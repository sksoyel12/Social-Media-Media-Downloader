from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import sys
import threading
import time
from collections import defaultdict, deque
from typing import Any
from urllib.parse import urlparse

import requests
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("media-api")

app = FastAPI(title="Social Media Downloader API", docs_url=None, redoc_url=None)

PLATFORM_HOSTS = {
    "tiktok": ("tiktok.com",),
    "instagram": ("instagram.com", "instagr.am"),
    "pinterest": ("pinterest.com", "pin.it"),
}
ALLOWED_IMAGE_FORMATS = {"jpg", "jpeg", "png", "webp"}
RATE_LIMIT = int(os.getenv("DOWNLOAD_RATE_LIMIT", "10"))
RATE_WINDOW_SECONDS = 60
CLIENT_REQUESTS: dict[str, deque[float]] = defaultdict(deque)
RATE_LOCK = threading.Lock()
EXTRACTION_SLOTS = threading.BoundedSemaphore(4)
EXTRACTION_TIMEOUT_SECONDS = 25


class DownloadInput(BaseModel):
    url: str = Field(min_length=1, max_length=2048)


@app.exception_handler(RequestValidationError)
async def validation_error_handler(
    _request: Request, _exc: RequestValidationError
) -> JSONResponse:
    return JSONResponse(
        status_code=400,
        content={"error": "Enter a valid public TikTok, Instagram, or Pinterest URL."},
    )


@app.exception_handler(HTTPException)
async def http_error_handler(_request: Request, exc: HTTPException) -> JSONResponse:
    message = exc.detail if isinstance(exc.detail, str) else "The request could not be completed."
    return JSONResponse(status_code=exc.status_code, content={"error": message})


def unshorten_url(raw_url: str) -> str:
    """Expands pin.it and vt.tiktok.com links to full canonical URLs."""
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }
    try:
        parsed = urlparse(raw_url)
        host = (parsed.hostname or "").lower()

        # Handle TikTok shortlinks (prevent redirecting to /in/about)
        if "tiktok.com" in host:
            resp = requests.get(raw_url, headers=headers, allow_redirects=False, timeout=8)
            if resp.status_code in (301, 302, 303, 307, 308):
                loc = resp.headers.get("Location")
                if loc and "/video/" in loc:
                    return loc.split("?")[0]
            if "/video/" in resp.url:
                return resp.url.split("?")[0]

        # Handle Pinterest pin.it and generic shortlinks
        if "pin.it" in host or host.endswith("pin.it"):
            resp = requests.get(raw_url, headers=headers, allow_redirects=True, stream=True, timeout=8)
            return resp.url

    except Exception as e:
        logger.warning("Unshorten failed for %s: %s", raw_url, e)

    return raw_url


def platform_for_url(raw_url: str) -> str:
    parsed = urlparse(raw_url.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise HTTPException(400, "Enter a valid URL beginning with https://.")
    try:
        port = parsed.port
    except ValueError as exc:
        raise HTTPException(400, "This URL is not supported.") from exc
    if parsed.username or parsed.password or port not in (None, 80, 443):
        raise HTTPException(400, "This URL is not supported.")

    hostname = parsed.hostname.lower().rstrip(".")
    for platform, domains in PLATFORM_HOSTS.items():
        if any(hostname == domain or hostname.endswith(f".{domain}") for domain in domains):
            return platform
    raise HTTPException(400, "Only TikTok, Instagram, and Pinterest links are supported.")


def check_rate_limit(client_key: str) -> None:
    now = time.monotonic()
    with RATE_LOCK:
        attempts = CLIENT_REQUESTS[client_key]
        while attempts and now - attempts[0] >= RATE_WINDOW_SECONDS:
            attempts.popleft()
        if len(attempts) >= RATE_LIMIT:
            raise HTTPException(429, "Too many requests. Wait a minute and try again.")
        attempts.append(now)


def is_web_url(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.hostname)


def extension_for(url: str, declared: Any = None) -> str:
    ext = str(declared or "").lower().lstrip(".")
    if ext in ALLOWED_IMAGE_FORMATS:
        return "jpg" if ext == "jpeg" else ext
    path_ext = urlparse(url).path.rsplit(".", 1)[-1].lower() if "." in urlparse(url).path else ""
    if path_ext in ALLOWED_IMAGE_FORMATS:
        return "jpg" if path_ext == "jpeg" else path_ext
    return "unknown"


class ExtractorTimeout(Exception):
    def __init__(self, tool: str):
        self.tool = tool
        super().__init__(f"{tool} exceeded the extraction time limit")


def stderr_text(value: str | bytes | None) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace").strip()
    return (value or "").strip()


def log_extractor_stderr(tool: str, stderr: str | bytes | None, url: str) -> None:
    message = stderr_text(stderr)
    if url:
        message = message.replace(url, "[submitted URL]")
    logger.warning("%s stderr: %s", tool, message or "(empty)")


def run_extractor(
    tool: str,
    command: list[str],
    url: str,
    deadline: float,
    allow_partial_output: bool = False,
) -> str:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise ExtractorTimeout(tool)

    try:
        completed = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=remaining,
        )
    except subprocess.TimeoutExpired as exc:
        log_extractor_stderr(tool, exc.stderr, url)
        raise ExtractorTimeout(tool) from exc

    if completed.returncode != 0:
        log_extractor_stderr(tool, completed.stderr, url)
        if not (allow_partial_output and completed.stdout.strip()):
            raise RuntimeError(stderr_text(completed.stderr) or f"{tool} exited with status {completed.returncode}")
    return completed.stdout


def extract_video(url: str, deadline: float) -> dict[str, Any] | None:
    output = run_extractor(
        "yt-dlp",
        [
            sys.executable,
            "-m",
            "yt_dlp",
            "--dump-single-json",
            "--skip-download",
            "--no-playlist",
            "--no-progress",
            "--socket-timeout",
            "12",
            "--user-agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "--format",
            "best[ext=mp4]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best",
            url,
        ],
        url,
        deadline,
    )
    try:
        info = json.loads(output)
    except json.JSONDecodeError as exc:
        raise RuntimeError("yt-dlp did not return media metadata") from exc
    if not info:
        return None

    if info.get("_type") in {"playlist", "multi_video"}:
        entries = [e for e in info.get("entries", []) if isinstance(e, dict)]
        if entries:
            info = entries[0]
        else:
            return None

    formats = info.get("formats")
    formats = formats if isinstance(formats, list) else []

    selected = None

    # Progressive MP4 with audio and video
    progressive_mp4 = [
        item
        for item in formats
        if isinstance(item, dict)
        and is_web_url(item.get("url"))
        and str(item.get("ext") or "").lower() == "mp4"
        and item.get("acodec") not in (None, "none")
        and item.get("vcodec") not in (None, "none")
    ]
    if progressive_mp4:
        selected = max(
            progressive_mp4,
            key=lambda item: (
                item.get("height") if isinstance(item.get("height"), int) else 0,
                item.get("tbr") if isinstance(item.get("tbr"), (int, float)) else 0,
            ),
        )

    # Any MP4 stream
    if selected is None:
        any_mp4 = [
            item
            for item in formats
            if isinstance(item, dict)
            and is_web_url(item.get("url"))
            and str(item.get("ext") or "").lower() == "mp4"
        ]
        if any_mp4:
            selected = max(
                any_mp4,
                key=lambda item: (
                    item.get("height") if isinstance(item.get("height"), int) else 0,
                    item.get("tbr") if isinstance(item.get("tbr"), (int, float)) else 0,
                ),
            )

    # Direct URL fallback
    if selected is None and is_web_url(info.get("url")):
        selected = info

    # Last valid stream fallback
    if selected is None:
        valid_streams = [
            item for item in formats if isinstance(item, dict) and is_web_url(item.get("url"))
        ]
        if valid_streams:
            selected = valid_streams[-1]

    if not selected:
        return None

    media_url = selected.get("url")
    if not is_web_url(media_url):
        return None

    height = selected.get("height")
    quality = f"{height}p" if isinstance(height, int) and height > 0 else "HD"
    return {
        "status": "success",
        "platform": "",
        "type": "video",
        "title": str(info.get("title") or info.get("fulltitle") or "Social media video"),
        "thumbnail": info.get("thumbnail") if is_web_url(info.get("thumbnail")) else None,
        "media": [
            {
                "url": media_url,
                "quality": quality,
                "format": "mp4",
            }
        ],
    }


def collect_gallery_items(value: Any, found: list[dict[str, str]]) -> None:
    if isinstance(value, dict):
        url = value.get("url")
        if is_web_url(url):
            ext = extension_for(url, value.get("extension") or value.get("ext"))
            if ext != "unknown":
                found.append({"url": url, "format": ext})
        for key, nested in value.items():
            if key != "url":
                collect_gallery_items(nested, found)
    elif isinstance(value, list):
        for nested in value:
            collect_gallery_items(nested, found)


def extract_gallery(url: str, deadline: float) -> list[dict[str, str]]:
    output = run_extractor(
        "gallery-dl",
        [
            sys.executable,
            "-m",
            "gallery_dl",
            "--simulate",
            "--dump-json",
            "--no-colors",
            url,
        ],
        url,
        deadline,
        allow_partial_output=True,
    )

    found: list[dict[str, str]] = []
    for line in output.splitlines():
        try:
            collect_gallery_items(json.loads(line), found)
        except json.JSONDecodeError:
            continue

    deduplicated: dict[str, dict[str, str]] = {}
    for item in found:
        deduplicated.setdefault(item["url"], item)
    return list(deduplicated.values())


def classify_extraction_error(message: str) -> HTTPException:
    normalized = message.lower()
    if any(token in normalized for token in ("429", "rate limit", "too many requests", "throttl")):
        return HTTPException(429, "The platform is temporarily limiting requests. Wait a minute and try again.")
    if any(
        token in normalized
        for token in (
            "private",
            "login required",
            "sign in",
            "instagram api is not granting access",
            "not available",
            "video unavailable",
            "post not found",
            "404",
            "403",
        )
    ):
        return HTTPException(
            422,
            "This post is private or unavailable. Only public posts can be processed.",
        )
    if any(
        token in normalized
        for token in (
            "timed out",
            "timeout",
            "connection reset",
            "temporary failure",
        )
    ):
        return HTTPException(502, "The platform could not be reached. Try again shortly.")
    if "unsupported url" in normalized:
        return HTTPException(
            422,
            "This link did not resolve to a supported public post. Check that it points directly to a video or post.",
        )
    return HTTPException(
        422,
        "Could not extract downloadable media from this link. Make sure the post is public.",
    )


def is_video_link(platform: str, url: str) -> bool:
    if platform == "tiktok":
        return True
    if platform == "instagram":
        return bool(re.search(r"/(?:reel|reels)/", urlparse(url).path.lower()))
    return False


@app.get("/api/healthz")
def health_check() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/download")
def download_media(payload: DownloadInput, request: Request) -> dict[str, Any]:
    # 1. Unshorten link first (pin.it -> pinterest.com, vt.tiktok.com -> tiktok.com/@user/video/...)
    resolved_url = unshorten_url(payload.url.strip())
    platform = platform_for_url(resolved_url)

    forwarded_for = request.headers.get("x-forwarded-for", "")
    client_key = (
        forwarded_for.split(",")[-1].strip()
        or (request.client.host if request.client else "unknown")
    )
    check_rate_limit(client_key)
    if not EXTRACTION_SLOTS.acquire(blocking=False):
        raise HTTPException(429, "The service is busy. Try again in a few seconds.")

    try:
        deadline = time.monotonic() + EXTRACTION_TIMEOUT_SECONDS
        video_error = ""

        # Step 1: Video extraction
        try:
            video = extract_video(resolved_url, deadline)
            if video:
                video["platform"] = platform
                return video
        except ExtractorTimeout as exc:
            raise HTTPException(
                502,
                f"{exc.tool} timed out after {EXTRACTION_TIMEOUT_SECONDS} seconds. Try again shortly.",
            ) from exc
        except Exception as exc:
            video_error = str(exc)

        # Step 2: Image / Gallery extraction
        try:
            images = extract_gallery(resolved_url, deadline)
            if images:
                kind = "carousel" if len(images) > 1 else "image"
                return {
                    "status": "success",
                    "platform": platform,
                    "type": kind,
                    "title": f"{platform.title()} {'carousel' if kind == 'carousel' else 'image'}",
                    "thumbnail": images[0]["url"],
                    "media": [
                        {
                            "url": item["url"],
                            "quality": "Original",
                            "format": item["format"],
                        }
                        for item in images
                    ],
                }
        except ExtractorTimeout as exc:
            raise HTTPException(
                502,
                f"{exc.tool} timed out before media was available. Try again shortly.",
            ) from exc
        except Exception:
            pass

        # Step 3: Handle failures
        if video_error:
            raise classify_extraction_error(video_error)

        raise HTTPException(
            422,
            "Could not extract downloadable media from this link. Make sure the post is public.",
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("Media extraction failed: %s", type(exc).__name__)
        raise HTTPException(502, "The platform could not be reached. Try again shortly.") from exc
    finally:
        EXTRACTION_SLOTS.release()
        