from __future__ import annotations

import ipaddress
import json
import logging
import os
import random
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import zipfile
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urljoin, urlparse, urlunparse

import requests
from bs4 import BeautifulSoup
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.background import BackgroundTask


logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("omnidownloader")

app = FastAPI(
    title="OmniDownloader API",
    version="1.0.0",
    description="Extracts and downloads publicly accessible social media media.",
    docs_url=None,
    redoc_url=None,
)

PLATFORM_DOMAINS: dict[str, tuple[str, ...]] = {
    "instagram": ("instagram.com", "instagr.am"),
    "tiktok": ("tiktok.com",),
    "pinterest": ("pinterest.com", "pin.it"),
}
SHORTLINK_HOSTS = ("pin.it", "vt.tiktok.com", "vm.tiktok.com", "instagr.am")
VIDEO_EXTENSIONS = {"mp4", "m4v", "mov", "webm"}
IMAGE_EXTENSIONS = {"jpg", "jpeg", "png", "webp", "gif", "avif"}
USER_AGENTS = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
)

RESULT_TTL_SECONDS = 15 * 60
MAX_CACHED_RESULTS = 500
MAX_MEDIA_ITEMS = 100
MAX_HIGHLIGHT_STORIES = 100
MAX_HTML_BYTES = 1_500_000
MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024
EXTRACTION_TIMEOUT_SECONDS = 42
DOWNLOAD_TIMEOUT_SECONDS = 180
RATE_LIMIT_WINDOW_SECONDS = 60
RATE_LIMIT_REQUESTS = 10


class DownloadInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    url: str = Field(min_length=1, max_length=2048)
    mode: Literal["post", "profile"] = "post"
    platform: Literal["instagram", "tiktok", "pinterest"] | None = None


class HighlightInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    url: str = Field(min_length=1, max_length=2048)


class DownloadFileInput(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    download_id: str = Field(
        alias="downloadId", min_length=32, max_length=32, pattern=r"^[a-f0-9]{32}$"
    )
    asset_type: Literal["media", "avatar", "audio", "archive"] = Field(alias="assetType")
    media_index: int | None = Field(alias="mediaIndex", ge=0)
    format: Literal["original", "webp", "mp3"] = "original"
    bitrate: Literal[128, 320] = 320


@dataclass
class CachedExtraction:
    created_at: float
    source_url: str
    platform: str
    media: list[dict[str, Any]]
    avatar_url: str | None
    title: str
    creator: dict[str, Any]
    audio_available: bool
    is_highlight: bool = False


_result_cache: dict[str, CachedExtraction] = {}
_cache_lock = threading.Lock()
_rate_log: dict[str, deque[float]] = {}
_rate_lock = threading.Lock()


class MediaToolError(Exception):
    pass


def _user_agent() -> str:
    return random.choice(USER_AGENTS)


def _headers() -> dict[str, str]:
    return {
        "User-Agent": _user_agent(),
        "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.8",
    }


def _host_matches(host: str, domains: tuple[str, ...]) -> bool:
    host = host.lower().rstrip(".")
    return any(host == domain or host.endswith(f".{domain}") for domain in domains)


def _host_is_shortlink(host: str) -> bool:
    host = host.lower().rstrip(".")
    return any(host == domain or host.endswith(f".{domain}") for domain in SHORTLINK_HOSTS)


def _validate_web_url(raw_url: str) -> str:
    value = raw_url.strip()
    try:
        parsed = urlparse(value)
        port = parsed.port
    except ValueError as exc:
        raise HTTPException(400, "Enter a valid public http or https link.") from exc
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise HTTPException(400, "Enter a complete public http or https link.")
    if parsed.username or parsed.password:
        raise HTTPException(400, "Links containing embedded credentials are not supported.")
    if port not in (None, 80, 443):
        raise HTTPException(400, "Links using a custom port are not supported.")
    host = parsed.hostname.lower().rstrip(".")
    if host in {"localhost", "localhost.localdomain"} or host.endswith(".local"):
        raise HTTPException(400, "Only public social media links are supported.")
    try:
        address = ipaddress.ip_address(host)
        if not address.is_global:
            raise HTTPException(400, "Only public social media links are supported.")
    except ValueError:
        pass
    clean = parsed._replace(fragment="")
    return urlunparse(clean)


def platform_for_url(raw_url: str) -> str | None:
    try:
        host = urlparse(raw_url).hostname
    except ValueError:
        return None
    if not host:
        return None
    for platform, domains in PLATFORM_DOMAINS.items():
        if _host_matches(host, domains):
            return platform
    return None


def _canonical_profile_url(handle_input: str, platform: str | None) -> tuple[str, str]:
    if platform not in {"instagram", "tiktok"}:
        raise HTTPException(400, "Choose Instagram or TikTok to look up a profile photo by username.")
    handle = handle_input.strip().lstrip("@")
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,80}", handle):
        raise HTTPException(400, "Enter a valid Instagram or TikTok username.")
    if platform == "instagram":
        return f"https://www.instagram.com/{handle}/", platform
    return f"https://www.tiktok.com/@{handle}", platform


def _normalize_input_url(payload: DownloadInput) -> tuple[str, str]:
    raw = payload.url.strip()
    if payload.mode == "profile" and "://" not in raw:
        return _canonical_profile_url(raw, payload.platform)
    url = _validate_web_url(raw)
    platform = platform_for_url(url)
    if not platform:
        raise HTTPException(400, "This link is not from Instagram, TikTok, or Pinterest.")
    if payload.platform and payload.platform != platform:
        raise HTTPException(400, f"This link is from {platform.title()}, not {payload.platform.title()}.")
    return url, platform


def _unshorten_url(url: str, platform: str) -> str:
    host = urlparse(url).hostname or ""
    if not _host_is_shortlink(host):
        return url

    current = url
    session = requests.Session()
    session.trust_env = False
    try:
        for _ in range(6):
            response = session.get(
                current,
                headers=_headers(),
                allow_redirects=False,
                stream=True,
                timeout=(4, 8),
            )
            try:
                if response.status_code not in {301, 302, 303, 307, 308}:
                    return current
                location = response.headers.get("Location")
                if not location:
                    return current
                next_url = _validate_web_url(urljoin(current, location))
                if platform_for_url(next_url) != platform:
                    raise HTTPException(400, "The short link did not resolve to a supported public post.")
                current = next_url
            finally:
                response.close()
        return current
    except HTTPException:
        raise
    except requests.RequestException as exc:
        logger.info("Short-link resolution failed (%s)", type(exc).__name__)
        raise HTTPException(422, "This short link could not be resolved. Try the full post link.") from exc
    finally:
        session.close()


def _rate_limit(request: Request) -> None:
    key = request.client.host if request.client else "unknown"
    now = time.monotonic()
    with _rate_lock:
        bucket = _rate_log.setdefault(key, deque())
        while bucket and now - bucket[0] > RATE_LIMIT_WINDOW_SECONDS:
            bucket.popleft()
        if len(bucket) >= RATE_LIMIT_REQUESTS:
            raise HTTPException(429, "Too many requests. Wait a minute and try again.")
        bucket.append(now)
        if len(_rate_log) > 5000:
            stale = [client for client, events in _rate_log.items() if not events or now - events[-1] > RATE_LIMIT_WINDOW_SECONDS]
            for client in stale[:2000]:
                _rate_log.pop(client, None)


def _prune_cache_locked(now: float) -> None:
    expired = [
        key
        for key, value in _result_cache.items()
        if now - value.created_at > RESULT_TTL_SECONDS
    ]
    for key in expired:
        _result_cache.pop(key, None)
    if len(_result_cache) > MAX_CACHED_RESULTS:
        oldest = sorted(_result_cache, key=lambda key: _result_cache[key].created_at)
        for key in oldest[: len(_result_cache) - MAX_CACHED_RESULTS]:
            _result_cache.pop(key, None)


def _store_result(
    source_url: str,
    platform: str,
    media: list[dict[str, Any]],
    avatar_url: str | None,
    title: str,
    creator: dict[str, Any],
    audio_available: bool,
    is_highlight: bool = False,
) -> str:
    download_id = uuid.uuid4().hex
    entry = CachedExtraction(
        created_at=time.time(),
        source_url=source_url,
        platform=platform,
        media=media,
        avatar_url=avatar_url,
        title=title,
        creator=creator,
        audio_available=audio_available,
        is_highlight=is_highlight,
    )
    with _cache_lock:
        _prune_cache_locked(time.time())
        _result_cache[download_id] = entry
    return download_id


def _get_cached(download_id: str) -> CachedExtraction:
    with _cache_lock:
        _prune_cache_locked(time.time())
        entry = _result_cache.get(download_id)
    if not entry:
        raise HTTPException(404, "This extraction expired. Paste the link again to refresh it.")
    return entry


def _run_tool(command: list[str], timeout: int) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        )
    except subprocess.TimeoutExpired as exc:
        raise MediaToolError("The source took too long to respond.") from exc
    except OSError as exc:
        raise MediaToolError("The media extraction tools are unavailable.") from exc


def _yt_dlp_info(url: str, mode: Literal["post", "profile"] = "post", timeout: int = 24) -> dict[str, Any] | None:
    command = [
        sys.executable,
        "-m",
        "yt_dlp",
        "--no-warnings",
        "--no-progress",
        "--skip-download",
        "--dump-single-json",
        "--socket-timeout",
        "10",
        "--user-agent",
        _user_agent(),
    ]
    if mode == "post":
        command.append("--no-playlist")
    else:
        command.extend(["--playlist-end", "1", "--ignore-errors"])
    command.append(url)
    result = _run_tool(command, timeout)
    if result.returncode != 0 or not result.stdout.strip():
        logger.info("yt-dlp metadata extraction did not produce a result")
        return None
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        logger.info("yt-dlp returned invalid metadata")
        return None
    if isinstance(data, dict) and isinstance(data.get("entries"), list):
        entries = [item for item in data["entries"] if isinstance(item, dict)]
        if mode == "post" and entries:
            return entries[0]
    return data if isinstance(data, dict) else None


def _gallery_records(url: str, limit: int, timeout: int) -> list[dict[str, Any]]:
    command = [
        sys.executable,
        "-m",
        "gallery_dl",
        "--simulate",
        "--dump-json",
        "--no-colors",
        "--range",
        f"1-{limit}",
        url,
    ]
    result = _run_tool(command, timeout)
    if result.returncode != 0:
        return []
    records: list[dict[str, Any]] = []
    for line in result.stdout.splitlines():
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            records.append(value)
        elif isinstance(value, list):
            records.append({"items": value})
    return records


def _string(value: Any) -> str | None:
    if isinstance(value, str):
        cleaned = value.strip()
        return cleaned or None
    if isinstance(value, (int, float)):
        return str(value)
    return None


def _nested_value(data: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        value = data.get(key)
        if value is not None:
            return value
    return None


def _extract_creator(data: dict[str, Any], platform: str, fallback_url: str) -> dict[str, Any]:
    nested = data.get("author") or data.get("user") or data.get("owner") or data.get("uploader")
    nested = nested if isinstance(nested, dict) else {}
    handle = _string(
        _nested_value(data, "uploader_id", "channel_id", "username", "owner_username", "author_name", "handle")
        or _nested_value(nested, "username", "unique_id", "handle", "id")
    )
    if handle:
        handle = handle.lstrip("@")
    name = _string(
        _nested_value(data, "uploader", "channel", "creator", "author_name", "owner_name", "name")
        or _nested_value(nested, "nickname", "name", "title")
    )
    avatar = _string(
        _nested_value(
            data,
            "uploader_avatar",
            "channel_thumbnail",
            "author_thumbnail",
            "profile_picture",
            "avatar_url",
            "avatar",
        )
        or _nested_value(nested, "avatar", "avatar_url", "profile_picture", "thumbnail")
    )
    profile_url = _string(
        _nested_value(data, "uploader_url", "channel_url", "author_url", "profile_url")
        or _nested_value(nested, "url", "profile_url")
    )
    if profile_url and platform_for_url(profile_url) != platform:
        profile_url = None
    if not profile_url and handle:
        if platform == "instagram":
            profile_url = f"https://www.instagram.com/{handle}/"
        elif platform == "tiktok":
            profile_url = f"https://www.tiktok.com/@{handle}"
    if not profile_url and platform_for_url(fallback_url) == platform:
        profile_url = fallback_url
    verified_value = _nested_value(data, "verified", "uploader_is_verified", "is_verified")
    if verified_value is None:
        verified_value = _nested_value(nested, "verified", "is_verified")
    return {
        "handle": handle,
        "name": name,
        "avatarUrl": avatar,
        "profileUrl": profile_url,
        "verified": verified_value is True or str(verified_value).lower() in {"true", "1", "yes"},
    }


def _upload_date(data: dict[str, Any]) -> str | None:
    value = _string(_nested_value(data, "upload_date", "release_date", "created_at", "timestamp"))
    if not value:
        return None
    if re.fullmatch(r"\d{8}", value):
        return f"{value[:4]}-{value[4:6]}-{value[6:]}"
    return value[:64]


def _hashtag_list(*texts: str) -> list[str]:
    matches: dict[str, str] = {}
    for text in texts:
        for match in re.findall(r"(?<!\w)#[\w\u0080-\uffff]+", text, flags=re.UNICODE):
            matches.setdefault(match.casefold(), match)
    return list(matches.values())


def _file_extension(url: str, declared: Any = None) -> str:
    ext = _string(declared)
    if ext:
        ext = ext.lower().lstrip(".")
    if ext not in VIDEO_EXTENSIONS | IMAGE_EXTENSIONS:
        ext = Path(urlparse(url).path).suffix.lower().lstrip(".")
    return ext if ext in VIDEO_EXTENSIONS | IMAGE_EXTENSIONS else "unknown"


def _public_media_url(value: Any) -> str | None:
    url = _string(value)
    if not url:
        return None
    try:
        parsed = urlparse(url)
    except ValueError:
        return None
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return None
    if parsed.username or parsed.password:
        return None
    try:
        if parsed.port not in (None, 80, 443):
            return None
    except ValueError:
        return None
    return url


def _pinterest_original_url(url: str, platform: str) -> str:
    host = (urlparse(url).hostname or "").lower()
    if platform != "pinterest" or not host.endswith("pinimg.com"):
        return url
    path = re.sub(r"/(?:\d{2,4}x(?:\d{2,4})?|[0-9]+x[0-9]+)/", "/originals/", urlparse(url).path)
    parsed = urlparse(url)
    return urlunparse(parsed._replace(path=path))


def _candidate_media(record: dict[str, Any], platform: str) -> dict[str, Any] | None:
    raw_url = _public_media_url(
        _nested_value(record, "url", "file_url", "media_url", "video_url", "image_url")
    )
    if not raw_url:
        return None
    mime = (_string(_nested_value(record, "mime_type", "mime", "content_type")) or "").lower()
    ext = _file_extension(raw_url, _nested_value(record, "extension", "ext"))
    if ext in VIDEO_EXTENSIONS or mime.startswith("video/"):
        kind = "video"
    elif ext in IMAGE_EXTENSIONS or mime.startswith("image/"):
        kind = "image"
    else:
        return None
    if kind == "image":
        raw_url = _pinterest_original_url(raw_url, platform)
    try:
        width = int(record.get("width")) if record.get("width") is not None else None
        height = int(record.get("height")) if record.get("height") is not None else None
    except (ValueError, TypeError):
        width, height = None, None
    duration_value = record.get("duration")
    try:
        duration = float(duration_value) if duration_value is not None else None
    except (ValueError, TypeError):
        duration = None
    has_audio = bool(record.get("has_audio")) or record.get("acodec") not in (None, "none")
    quality = f"{height}p" if height else ("Original" if kind == "image" else "Available")
    return {
        "url": raw_url,
        "type": kind,
        "quality": quality,
        "format": ext if ext in VIDEO_EXTENSIONS | IMAGE_EXTENSIONS else "unknown",
        "width": width,
        "height": height,
        "hasAudio": has_audio,
        "_selector": None,
        "_sourcePage": None,
        "_duration": duration,
    }


def _walk_gallery_media(
    value: Any,
    platform: str,
    media: list[dict[str, Any]],
    parent_key: str = "",
) -> None:
    if len(media) >= MAX_MEDIA_ITEMS or parent_key.lower() in {
        "thumbnail",
        "thumbnails",
        "preview",
        "preview_url",
        "cover",
        "avatar",
    }:
        return
    if isinstance(value, dict):
        candidate = _candidate_media(value, platform)
        if candidate and candidate["url"] not in {item["url"] for item in media}:
            media.append(candidate)
        for key, child in value.items():
            if key not in {"url", "file_url", "media_url", "video_url", "image_url"}:
                _walk_gallery_media(child, platform, media, str(key))
    elif isinstance(value, list):
        for child in value:
            _walk_gallery_media(child, platform, media, parent_key)


def _collect_gallery_metadata(
    records: list[dict[str, Any]], platform: str, fallback_url: str
) -> dict[str, Any]:
    output: dict[str, Any] = {}
    fields = {
        "title": ("title", "post_title", "pin_title", "board_title"),
        "description": ("description", "caption", "text", "alt", "post_description"),
        "boardName": ("board_name", "board_title", "board", "collection_name"),
        "uploadDate": ("upload_date", "created_at", "date"),
        "thumbnail": ("thumbnail", "thumbnail_url", "cover", "cover_url"),
    }
    for record in records:
        for destination, keys in fields.items():
            if output.get(destination):
                continue
            value = _nested_value(record, *keys)
            if isinstance(value, dict):
                value = _nested_value(value, "name", "title", "url")
            cleaned = _string(value)
            if cleaned:
                output[destination] = cleaned
        if not output.get("creator") and any(
            key in record for key in ("username", "author", "owner", "uploader")
        ):
            output["creator"] = _extract_creator(record, platform, fallback_url)
    return output


def _video_variants(info: dict[str, Any], source_url: str) -> list[dict[str, Any]]:
    formats = info.get("formats") if isinstance(info.get("formats"), list) else []
    candidates: list[dict[str, Any]] = []
    for item in formats:
        if not isinstance(item, dict):
            continue
        media_url = _public_media_url(item.get("url"))
        if not media_url or item.get("vcodec") in (None, "none"):
            continue
        ext = _file_extension(media_url, item.get("ext"))
        if ext not in VIDEO_EXTENSIONS:
            continue
        try:
            height = int(item.get("height")) if item.get("height") is not None else None
            width = int(item.get("width")) if item.get("width") is not None else None
            bitrate = float(item.get("tbr") or 0)
        except (TypeError, ValueError):
            height, width, bitrate = None, None, 0
        has_audio = item.get("acodec") not in (None, "none")
        if item.get("format_id") and has_audio:
            selector = str(item["format_id"])
        elif height:
            selector = f"bestvideo[height<={height}]+bestaudio/best[height<={height}]"
        else:
            selector = "bestvideo+bestaudio/best"
        candidates.append(
            {
                "url": media_url,
                "type": "video",
                "quality": f"{height}p" if height else "Available",
                "format": ext,
                "width": width,
                "height": height,
                "hasAudio": has_audio,
                "_selector": selector,
                "_sourcePage": source_url,
                "_bitrate": bitrate,
            }
        )

    if not candidates:
        media_url = _public_media_url(info.get("url"))
        ext = _file_extension(media_url or "", info.get("ext"))
        if media_url and ext in VIDEO_EXTENSIONS:
            height = info.get("height")
            try:
                height = int(height) if height is not None else None
            except (TypeError, ValueError):
                height = None
            candidates.append(
                {
                    "url": media_url,
                    "type": "video",
                    "quality": f"{height}p" if height else "Available",
                    "format": ext,
                    "width": info.get("width"),
                    "height": height,
                    "hasAudio": info.get("acodec") not in (None, "none"),
                    "_selector": str(info.get("format_id") or "bestvideo+bestaudio/best"),
                    "_sourcePage": source_url,
                    "_bitrate": 0,
                }
            )

    # Keep one best candidate per actual resolution. Never label unavailable
    # resolutions as options; the UI receives only streams found by the extractor.
    best_by_height: dict[int | None, dict[str, Any]] = {}
    for candidate in candidates:
        height = candidate.get("height")
        existing = best_by_height.get(height)
        score = (bool(candidate.get("hasAudio")), float(candidate.get("_bitrate") or 0))
        existing_score = (
            bool(existing.get("hasAudio")),
            float(existing.get("_bitrate") or 0),
        ) if existing else (-1, -1)
        if existing is None or score > existing_score:
            best_by_height[height] = candidate
    return sorted(
        best_by_height.values(),
        key=lambda item: (item.get("height") or 0, item.get("hasAudio", False)),
        reverse=True,
    )


def _public_media(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "url": item["url"],
        "type": item["type"],
        "quality": item.get("quality") or "Available",
        "format": item.get("format") or "unknown",
        "width": item.get("width"),
        "height": item.get("height"),
        "hasAudio": bool(item.get("hasAudio")),
    }


def _read_public_html(url: str) -> str:
    session = requests.Session()
    session.trust_env = False
    current = url
    try:
        for _ in range(4):
            if platform_for_url(current) != "instagram":
                return ""
            response = session.get(
                current,
                headers=_headers(),
                allow_redirects=False,
                stream=True,
                timeout=(3, 6),
            )
            try:
                if response.status_code in {301, 302, 303, 307, 308}:
                    location = response.headers.get("Location")
                    if not location:
                        return ""
                    next_url = _validate_web_url(urljoin(current, location))
                    if platform_for_url(next_url) != "instagram":
                        return ""
                    current = next_url
                    continue
                if response.status_code != 200:
                    return ""
                body = bytearray()
                for chunk in response.iter_content(chunk_size=32_768):
                    if not chunk:
                        continue
                    body.extend(chunk)
                    if len(body) > MAX_HTML_BYTES:
                        break
                return bytes(body[:MAX_HTML_BYTES]).decode(
                    response.encoding or "utf-8", errors="replace"
                )
            finally:
                response.close()
    except (requests.RequestException, HTTPException) as exc:
        logger.info("Public Instagram page fallback failed (%s)", type(exc).__name__)
    finally:
        session.close()
    return ""


def _instagram_oembed(url: str) -> dict[str, Any]:
    """Best-effort public oEmbed metadata; no cookies, account sessions, or tokens."""
    session = requests.Session()
    session.trust_env = False
    try:
        response = session.get(
            "https://www.instagram.com/api/v1/oembed/",
            params={"url": url},
            headers=_headers(),
            allow_redirects=False,
            timeout=(3, 5),
        )
        try:
            if response.status_code != 200:
                return {}
            payload = response.json()
            return payload if isinstance(payload, dict) else {}
        except (ValueError, requests.RequestException):
            return {}
        finally:
            response.close()
    except requests.RequestException as exc:
        logger.info("Instagram oEmbed fallback unavailable (%s)", type(exc).__name__)
        return {}
    finally:
        session.close()


def _instagram_page_metadata(url: str) -> dict[str, Any]:
    oembed = _instagram_oembed(url)
    html = _read_public_html(url)
    metadata: dict[str, Any] = {}
    if oembed:
        html_caption = BeautifulSoup(_string(oembed.get("html")) or "", "html.parser").get_text(" ", strip=True)
        metadata.update(
            {
                "caption": _string(oembed.get("title")) or html_caption,
                "title": _string(oembed.get("title")),
                "thumbnail": _string(oembed.get("thumbnail_url")),
                "creatorName": _string(oembed.get("author_name")),
                "creatorUrl": _string(oembed.get("author_url")),
            }
        )
    if not html:
        return metadata
    soup = BeautifulSoup(html, "html.parser")

    def meta_value(*selectors: str) -> str | None:
        for selector in selectors:
            tag = soup.select_one(selector)
            if tag:
                value = tag.get("content") or tag.get_text(" ", strip=True)
                cleaned = _string(value)
                if cleaned:
                    return cleaned
        return None

    metadata["title"] = metadata.get("title") or meta_value(
        'meta[property="og:title"]', 'meta[name="twitter:title"]'
    )
    metadata["caption"] = metadata.get("caption") or meta_value(
        'meta[property="og:description"]', 'meta[name="description"]'
    )
    metadata["description"] = meta_value(
        'meta[property="og:description"]', 'meta[name="description"]'
    )
    metadata["thumbnail"] = metadata.get("thumbnail") or meta_value(
        'meta[property="og:image"]', 'meta[name="twitter:image"]'
    )
    for script in soup.select('script[type="application/ld+json"]'):
        try:
            parsed = json.loads(script.string or script.get_text())
        except (json.JSONDecodeError, TypeError):
            continue
        candidates = parsed if isinstance(parsed, list) else [parsed]
        for entry in candidates:
            if not isinstance(entry, dict):
                continue
            metadata["caption"] = metadata.get("caption") or _string(
                entry.get("caption") or entry.get("description")
            )
            metadata["title"] = metadata.get("title") or _string(entry.get("headline") or entry.get("name"))
            image = entry.get("image")
            if isinstance(image, list) and image:
                image = image[0]
            if isinstance(image, dict):
                image = image.get("url")
            metadata["thumbnail"] = metadata.get("thumbnail") or _string(image)
            author = entry.get("author")
            if isinstance(author, list) and author:
                author = author[0]
            if isinstance(author, dict):
                metadata["creatorName"] = metadata.get("creatorName") or _string(author.get("name"))
                metadata["creatorUrl"] = metadata.get("creatorUrl") or _string(author.get("url"))
    return metadata


def _clean_creator(data: dict[str, Any], platform: str, source_url: str) -> dict[str, Any]:
    creator = _extract_creator(data, platform, source_url)
    if creator["handle"] is None and creator["name"]:
        creator["handle"] = creator["name"].lstrip("@")
    return creator


def _merge_page_fallback(
    info: dict[str, Any],
    creator: dict[str, Any],
    platform: str,
    source_url: str,
    mode: str,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    fallback: dict[str, Any] = {}
    if platform == "instagram" and (
        not info.get("description")
        or not info.get("title")
        or not creator.get("avatarUrl")
        or (mode == "profile" and not creator.get("avatarUrl"))
    ):
        fallback = _instagram_page_metadata(source_url)
    if fallback.get("creatorName") and not creator.get("name"):
        creator["name"] = fallback["creatorName"]
    if fallback.get("creatorUrl") and not creator.get("profileUrl"):
        creator["profileUrl"] = fallback["creatorUrl"]
    if fallback.get("thumbnail") and mode == "profile" and not creator.get("avatarUrl"):
        creator["avatarUrl"] = fallback["thumbnail"]
    merged = dict(info)
    if fallback.get("caption") and not merged.get("description"):
        merged["description"] = fallback["caption"]
    if fallback.get("title") and not merged.get("title"):
        merged["title"] = fallback["title"]
    return merged, creator, fallback


def _extract_media_list(
    source_url: str,
    platform: str,
    info: dict[str, Any] | None,
    gallery: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], bool]:
    media: list[dict[str, Any]] = []
    audio_available = False
    if info:
        variants = _video_variants(info, source_url)
        media.extend(variants)
        formats = info.get("formats") if isinstance(info.get("formats"), list) else []
        audio_available = any(
            isinstance(item, dict) and item.get("acodec") not in (None, "none")
            for item in formats
        ) or any(item.get("hasAudio") for item in variants)
        image_fallback = info.get("url")
        if not media and _file_extension(_string(image_fallback) or "", info.get("ext")) in IMAGE_EXTENSIONS:
            candidate = _candidate_media(
                {
                    "url": image_fallback,
                    "ext": info.get("ext"),
                    "width": info.get("width"),
                    "height": info.get("height"),
                },
                platform,
            )
            if candidate:
                media.append(candidate)
        requested = info.get("requested_downloads")
        if isinstance(requested, list):
            _walk_gallery_media(requested, platform, media)
    for record in gallery:
        _walk_gallery_media(record, platform, media)
    unique: list[dict[str, Any]] = []
    seen: set[tuple[str, str, int | None]] = set()
    for item in media:
        signature = (item["url"], item["type"], item.get("height"))
        if signature in seen:
            continue
        seen.add(signature)
        unique.append(item)
        if len(unique) >= MAX_MEDIA_ITEMS:
            break
    return unique, audio_available


def _format_from_metadata(data: dict[str, Any]) -> str:
    ext = _string(data.get("ext")) or _file_extension(_string(data.get("url")) or "")
    return ext if ext in VIDEO_EXTENSIONS | IMAGE_EXTENSIONS else "unknown"


def _friendly_extraction_error() -> HTTPException:
    return HTTPException(
        422,
        "We couldn’t retrieve this public post. It may be private, expired, unsupported, or temporarily unavailable.",
    )


def _extract_public_result(payload: DownloadInput, request: Request) -> dict[str, Any]:
    _rate_limit(request)
    source_url, platform = _normalize_input_url(payload)
    source_url = _unshorten_url(source_url, platform)
    deadline = time.monotonic() + EXTRACTION_TIMEOUT_SECONDS
    info: dict[str, Any] | None = None
    try:
        info = _yt_dlp_info(
            source_url,
            mode=payload.mode,
            timeout=max(5, min(24, int(deadline - time.monotonic()))),
        )
    except MediaToolError as exc:
        logger.info("yt-dlp metadata attempt ended (%s)", type(exc).__name__)

    if payload.mode == "profile":
        info = info or {}
        creator = _clean_creator(info, platform, source_url)
        if platform == "instagram" and not creator.get("avatarUrl"):
            info, creator, fallback = _merge_page_fallback(info, creator, platform, source_url, "profile")
        else:
            fallback = {}
        avatar_url = _public_media_url(
            creator.get("avatarUrl")
            or fallback.get("thumbnail")
            or info.get("thumbnail")
        )
        if not avatar_url:
            raise _friendly_extraction_error()
        creator["avatarUrl"] = avatar_url
        if not creator.get("handle"):
            path_parts = [part for part in urlparse(source_url).path.split("/") if part]
            handle = path_parts[-1].lstrip("@") if path_parts else None
            creator["handle"] = handle
        title = creator.get("name") or creator.get("handle") or "Profile photo"
        media = [
            {
                "url": avatar_url,
                "type": "profile",
                "quality": "Original profile photo",
                "format": _format_from_metadata({"url": avatar_url}),
                "width": None,
                "height": None,
                "hasAudio": False,
                "_selector": None,
                "_sourcePage": None,
            }
        ]
        download_id = _store_result(
            source_url, platform, media, avatar_url, title, creator, False
        )
        return {
            "downloadId": download_id,
            "status": "success",
            "platform": platform,
            "type": "profile",
            "title": title,
            "caption": "",
            "description": "",
            "uploadDate": None,
            "boardName": None,
            "hashtags": [],
            "thumbnail": avatar_url,
            "creator": creator,
            "media": [_public_media(item) for item in media],
            "audioAvailable": False,
        }

    remaining = max(1, min(20, int(deadline - time.monotonic())))
    gallery: list[dict[str, Any]] = []
    try:
        gallery = _gallery_records(source_url, MAX_MEDIA_ITEMS, remaining)
    except MediaToolError as exc:
        logger.info("gallery-dl metadata attempt ended (%s)", type(exc).__name__)

    info = info or {}
    gallery_metadata = _collect_gallery_metadata(gallery, platform, source_url)
    creator = _clean_creator(info, platform, source_url)
    if not creator.get("handle") and gallery_metadata.get("creator"):
        creator = gallery_metadata["creator"]
    info, creator, page_fallback = _merge_page_fallback(
        info, creator, platform, source_url, "post"
    )
    media, audio_available = _extract_media_list(source_url, platform, info, gallery)
    if not media:
        fallback_image = _public_media_url(page_fallback.get("thumbnail"))
        if fallback_image and platform == "instagram":
            media = [
                {
                    "url": fallback_image,
                    "type": "image",
                    "quality": "Available image",
                    "format": _format_from_metadata({"url": fallback_image}),
                    "width": None,
                    "height": None,
                    "hasAudio": False,
                    "_selector": None,
                    "_sourcePage": None,
                }
            ]
    if not media:
        raise _friendly_extraction_error()

    description = _string(info.get("description") or info.get("caption")) or _string(
        gallery_metadata.get("description")
    ) or _string(page_fallback.get("description")) or ""
    title = (
        _string(info.get("title"))
        or _string(gallery_metadata.get("title"))
        or _string(page_fallback.get("title"))
        or f"{platform.title()} post"
    )
    if description:
        title = re.sub(r"\s+", " ", title).strip()[:180]
    if not creator.get("avatarUrl") and platform == "instagram":
        creator["avatarUrl"] = _public_media_url(page_fallback.get("thumbnail"))
    upload_date = _upload_date(info) or _string(gallery_metadata.get("uploadDate"))
    board_name = _string(
        info.get("board_name")
        or info.get("board")
        or info.get("collection_name")
        or gallery_metadata.get("boardName")
    )
    thumbnail = _public_media_url(info.get("thumbnail")) or _public_media_url(
        gallery_metadata.get("thumbnail")
    )
    if not thumbnail:
        thumbnail = next((item["url"] for item in media if item["type"] in {"image", "video"}), None)
    raw_tags = info.get("tags") if isinstance(info.get("tags"), list) else []
    tag_text = " ".join(
        str(tag) if str(tag).startswith("#") else f"#{tag}"
        for tag in raw_tags
        if tag
    )
    hashtags = _hashtag_list(description, tag_text)
    if any(item["type"] == "video" for item in media):
        result_type = "video"
    elif len([item for item in media if item["type"] == "image"]) > 1:
        result_type = "carousel"
    else:
        result_type = "image"
    if platform == "pinterest" and board_name:
        title = title or board_name

    download_id = _store_result(
        source_url,
        platform,
        media,
        _public_media_url(creator.get("avatarUrl")),
        title,
        creator,
        audio_available,
    )
    return {
        "downloadId": download_id,
        "status": "success",
        "platform": platform,
        "type": result_type,
        "title": title,
        "caption": description,
        "description": description,
        "uploadDate": upload_date,
        "boardName": board_name,
        "hashtags": hashtags,
        "thumbnail": thumbnail,
        "creator": creator,
        "media": [_public_media(item) for item in media],
        "audioAvailable": audio_available,
    }


def _extract_highlight_result(payload: HighlightInput, request: Request) -> dict[str, Any]:
    _rate_limit(request)
    source_url = _validate_web_url(payload.url)
    if platform_for_url(source_url) != "instagram":
        raise HTTPException(400, "Instagram Stories and Highlights links are supported here.")
    source_url = _unshorten_url(source_url, "instagram")
    if "/stories/" not in urlparse(source_url).path.lower():
        raise HTTPException(400, "Paste an Instagram Story or Highlight link.")

    try:
        records = _gallery_records(
            source_url,
            MAX_HIGHLIGHT_STORIES,
            min(30, EXTRACTION_TIMEOUT_SECONDS),
        )
    except MediaToolError as exc:
        logger.info("Highlight extractor failed (%s)", type(exc).__name__)
        records = []

    media: list[dict[str, Any]] = []
    for record in records:
        before = len(media)
        _walk_gallery_media(record, "instagram", media)
        # Carry duration and the individual story page URL when gallery-dl emits it.
        duration = record.get("duration")
        try:
            duration = float(duration) if duration is not None else None
        except (TypeError, ValueError):
            duration = None
        for item in media[before:]:
            item["_duration"] = duration
            item["_sourcePage"] = _public_media_url(record.get("webpage_url")) or source_url

    if not media:
        # yt-dlp can expose a public story/highlight as a playlist even when
        # gallery-dl has no matching extractor for the current platform version.
        try:
            playlist_info = _yt_dlp_info(
                source_url,
                mode="profile",
                timeout=min(22, EXTRACTION_TIMEOUT_SECONDS),
            )
        except MediaToolError as exc:
            logger.info("Highlight fallback failed (%s)", type(exc).__name__)
            playlist_info = None
        entries = playlist_info.get("entries", []) if isinstance(playlist_info, dict) else []
        if isinstance(entries, list):
            for entry in entries[:MAX_HIGHLIGHT_STORIES]:
                if not isinstance(entry, dict):
                    continue
                variants = _video_variants(entry, source_url)
                candidate = variants[0] if variants else None
                if not candidate:
                    direct = _candidate_media(entry, "instagram")
                    candidate = direct
                if candidate:
                    candidate["_sourcePage"] = source_url
                    media.append(candidate)

    unique: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in media:
        if item["url"] in seen:
            continue
        seen.add(item["url"])
        unique.append(item)
        if len(unique) >= MAX_HIGHLIGHT_STORIES:
            break
    if not unique:
        raise HTTPException(
            422,
            "These stories are private, expired, login-gated, or unavailable to public extractors.",
        )

    gallery_metadata = _collect_gallery_metadata(records, "instagram", source_url)
    info = _yt_dlp_info(source_url, mode="profile", timeout=8) or {}
    creator = _clean_creator(info, "instagram", source_url)
    if not creator.get("handle") and gallery_metadata.get("creator"):
        creator = gallery_metadata["creator"]
    title = (
        _string(info.get("title"))
        or _string(gallery_metadata.get("title"))
        or "Instagram Highlight"
    )
    cover = _public_media_url(info.get("thumbnail")) or _public_media_url(
        gallery_metadata.get("thumbnail")
    ) or next((item["url"] for item in unique if item["type"] == "image"), None)
    download_id = _store_result(
        source_url,
        "instagram",
        unique,
        _public_media_url(creator.get("avatarUrl")),
        title,
        creator,
        any(item.get("hasAudio") for item in unique),
        is_highlight=True,
    )
    stories = []
    for index, item in enumerate(unique):
        stories.append(
            {
                "storyNumber": index + 1,
                "mediaIndex": index,
                "type": "video" if item["type"] == "video" else "photo",
                "duration": item.get("_duration"),
                "thumbnail": item["url"],
                "createdAt": None,
            }
        )
    return {
        "downloadId": download_id,
        "title": title,
        "cover": cover,
        "creator": creator,
        "stories": stories,
        "truncated": len(media) >= MAX_HIGHLIGHT_STORIES,
    }


def _is_public_ip_host(host: str) -> bool:
    try:
        address = ipaddress.ip_address(host)
        return address.is_global
    except ValueError:
        if host in {"localhost", "localhost.localdomain"} or host.endswith(".local"):
            return False
    try:
        results = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except OSError:
        return False
    addresses = {result[4][0].split("%", 1)[0] for result in results}
    if not addresses:
        return False
    try:
        return all(ipaddress.ip_address(address).is_global for address in addresses)
    except ValueError:
        return False


def _validate_media_url(raw_url: str) -> str:
    url = _public_media_url(raw_url)
    if not url:
        raise HTTPException(422, "The extracted media link is invalid.")
    parsed = urlparse(url)
    if not _is_public_ip_host(parsed.hostname or ""):
        raise HTTPException(422, "The media host is unavailable.")
    return url


def _download_remote_file(
    url: str, destination: Path, max_bytes: int = MAX_DOWNLOAD_BYTES
) -> tuple[str, int]:
    session = requests.Session()
    session.trust_env = False
    current = url
    total = 0
    try:
        for _ in range(5):
            current = _validate_media_url(current)
            response = session.get(
                current,
                headers=_headers(),
                allow_redirects=False,
                stream=True,
                timeout=(8, 30),
            )
            try:
                if response.status_code in {301, 302, 303, 307, 308}:
                    location = response.headers.get("Location")
                    if not location:
                        raise MediaToolError("The media source redirected without a location.")
                    current = urljoin(current, location)
                    continue
                if not 200 <= response.status_code < 300:
                    raise MediaToolError("The media source did not return a downloadable file.")
                content_type = response.headers.get("Content-Type", "application/octet-stream").split(";", 1)[0].lower()
                if content_type.startswith("text/html"):
                    raise MediaToolError("The media source returned a web page instead of a file.")
                length = response.headers.get("Content-Length")
                if length and int(length) > max_bytes:
                    raise HTTPException(413, "This file is too large to download from the service.")
                with destination.open("wb") as output:
                    for chunk in response.iter_content(chunk_size=256 * 1024):
                        if not chunk:
                            continue
                        total += len(chunk)
                        if total > max_bytes:
                            raise HTTPException(413, "This file is too large to download from the service.")
                        output.write(chunk)
                return content_type, total
            finally:
                response.close()
        raise MediaToolError("The media source redirected too many times.")
    except (requests.RequestException, ValueError) as exc:
        raise MediaToolError("The media source could not be reached.") from exc
    finally:
        session.close()


def _safe_filename(title: str, suffix: str) -> str:
    cleaned = re.sub(r"[^\w\- ]+", "", title, flags=re.UNICODE)
    cleaned = re.sub(r"\s+", "-", cleaned).strip("-_")[:64] or "saved-media"
    return f"{cleaned}.{suffix}"


def _file_response(
    temp_dir: tempfile.TemporaryDirectory[str],
    path: Path,
    filename: str,
    media_type: str,
) -> FileResponse:
    return FileResponse(
        path,
        filename=filename,
        media_type=media_type,
        headers={"Cache-Control": "private, no-store"},
        background=BackgroundTask(temp_dir.cleanup),
    )


def _run_ytdlp_download(
    source_url: str,
    output_template: Path,
    selector: str,
    audio_bitrate: int | None = None,
) -> Path:
    command = [
        sys.executable,
        "-m",
        "yt_dlp",
        "--no-warnings",
        "--no-progress",
        "--no-playlist",
        "--no-part",
        "--socket-timeout",
        "15",
        "--max-filesize",
        str(MAX_DOWNLOAD_BYTES),
        "--user-agent",
        _user_agent(),
        "--output",
        str(output_template),
    ]
    if audio_bitrate:
        command.extend(
            [
                "--format",
                "bestaudio/best",
                "--extract-audio",
                "--audio-format",
                "mp3",
                "--audio-quality",
                f"{audio_bitrate}K",
            ]
        )
    else:
        command.extend(
            [
                "--format",
                selector or "bestvideo+bestaudio/best",
                "--merge-output-format",
                "mp4",
                "--recode-video",
                "mp4",
            ]
        )
    command.append(source_url)
    result = _run_tool(command, DOWNLOAD_TIMEOUT_SECONDS)
    if result.returncode != 0:
        raise MediaToolError("The selected stream could not be downloaded or converted.")
    output_path = output_template.parent / output_template.name
    if output_path.exists() and output_path.is_file():
        return output_path
    files = [
        path
        for path in output_template.parent.iterdir()
        if path.is_file() and not path.name.endswith((".part", ".ytdl"))
    ]
    if not files:
        raise MediaToolError("The media converter did not produce a file.")
    return max(files, key=lambda path: path.stat().st_size)


def _convert_to_webp(source: Path, destination: Path) -> None:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise MediaToolError("Image conversion is temporarily unavailable.")
    result = _run_tool(
        [
            ffmpeg,
            "-v",
            "error",
            "-y",
            "-i",
            str(source),
            "-frames:v",
            "1",
            "-c:v",
            "libwebp",
            "-quality",
            "88",
            str(destination),
        ],
        30,
    )
    if result.returncode != 0 or not destination.exists():
        raise MediaToolError("This image could not be converted to WebP.")


def _prepare_media_download(
    entry: CachedExtraction,
    payload: DownloadFileInput,
) -> tuple[tempfile.TemporaryDirectory[str], Path, str, str]:
    temp_dir = tempfile.TemporaryDirectory(prefix="omni-download-")
    directory = Path(temp_dir.name)
    try:
        if payload.asset_type == "archive":
            if not entry.is_highlight:
                raise HTTPException(422, "A story archive is only available for an Instagram Highlight.")
            if not entry.media:
                raise HTTPException(404, "No stories are available to add to this archive.")
            archive_path = directory / "stories.zip"
            total_bytes = 0
            with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_STORED) as archive:
                for index, item in enumerate(entry.media, start=1):
                    source_url = _validate_media_url(item["url"])
                    extension = _file_extension(source_url)
                    if extension == "unknown":
                        extension = "mp4" if item["type"] == "video" else "jpg"
                    item_path = directory / f"story-{index}.{extension}"
                    _download_remote_file(
                        source_url, item_path, max_bytes=MAX_DOWNLOAD_BYTES - total_bytes
                    )
                    total_bytes += item_path.stat().st_size
                    if total_bytes > MAX_DOWNLOAD_BYTES:
                        raise HTTPException(413, "The story archive is too large to prepare.")
                    archive.write(item_path, arcname=f"Story-{index:03d}.{extension}")
                    item_path.unlink(missing_ok=True)
            return (
                temp_dir,
                archive_path,
                _safe_filename(entry.title, "zip"),
                "application/zip",
            )

        if payload.asset_type == "avatar":
            if not entry.avatar_url:
                raise HTTPException(404, "No creator profile photo was found for this post.")
            source_url = entry.avatar_url
            source_extension = _file_extension(source_url)
            source_path = directory / f"avatar.{source_extension if source_extension != 'unknown' else 'bin'}"
            content_type, _ = _download_remote_file(source_url, source_path)
            if payload.format == "mp3":
                raise HTTPException(422, "MP3 format is only available for video audio.")
            if payload.format == "webp":
                converted = directory / "avatar.webp"
                _convert_to_webp(source_path, converted)
                return temp_dir, converted, _safe_filename("creator-profile", "webp"), "image/webp"
            return (
                temp_dir,
                source_path,
                _safe_filename("creator-profile", source_extension if source_extension != "unknown" else "jpg"),
                content_type if content_type.startswith("image/") else "application/octet-stream",
            )

        if payload.asset_type == "audio":
            if not entry.audio_available:
                raise HTTPException(422, "Audio extraction is not available for this post.")
            if payload.format != "mp3":
                raise HTTPException(422, "Choose MP3 for audio downloads.")
            output_template = directory / "audio.mp3"
            path = _run_ytdlp_download(
                entry.source_url,
                output_template,
                "bestaudio/best",
                audio_bitrate=payload.bitrate,
            )
            return temp_dir, path, _safe_filename(entry.title, "mp3"), "audio/mpeg"

        if payload.media_index is None or payload.media_index >= len(entry.media):
            raise HTTPException(404, "That media item is no longer available.")
        media = entry.media[payload.media_index]
        if payload.format == "mp3":
            raise HTTPException(422, "Choose a video or audio download format.")
        if media["type"] == "video" and payload.format == "original":
            source_page = media.get("_sourcePage") or entry.source_url
            selector = media.get("_selector")
            if selector:
                output_template = directory / "video.%(ext)s"
                path = _run_ytdlp_download(source_page, output_template, str(selector))
                return temp_dir, path, _safe_filename(entry.title, "mp4"), "video/mp4"

        source_url = _validate_media_url(media["url"])
        extension = _file_extension(source_url)
        source_path = directory / f"media.{extension if extension != 'unknown' else 'bin'}"
        content_type, _ = _download_remote_file(source_url, source_path)
        if payload.format == "webp":
            if media["type"] not in {"image", "profile"}:
                raise HTTPException(422, "WebP is only available for images.")
            converted = directory / "media.webp"
            _convert_to_webp(source_path, converted)
            return temp_dir, converted, _safe_filename(entry.title, "webp"), "image/webp"
        filename_extension = extension if extension != "unknown" else (
            "mp4" if media["type"] == "video" else "jpg"
        )
        fallback_type = "video/mp4" if media["type"] == "video" else "image/jpeg"
        return (
            temp_dir,
            source_path,
            _safe_filename(entry.title, filename_extension),
            content_type if content_type != "application/octet-stream" else fallback_type,
        )
    except Exception:
        temp_dir.cleanup()
        raise


@app.exception_handler(RequestValidationError)
async def request_validation_error_handler(
    _request: Request, _exc: RequestValidationError
) -> JSONResponse:
    return JSONResponse(
        status_code=400,
        content={"error": "Check the link and selected download options, then try again."},
    )


@app.exception_handler(HTTPException)
async def http_error_handler(_request: Request, exc: HTTPException) -> JSONResponse:
    detail = exc.detail if isinstance(exc.detail, str) else "The request could not be completed."
    return JSONResponse(status_code=exc.status_code, content={"error": detail})


@app.get("/api/healthz")
async def health_check() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/extract")
async def extract_media(payload: DownloadInput, request: Request) -> dict[str, Any]:
    return _extract_public_result(payload, request)


@app.post("/api/highlight")
async def extract_highlight(payload: HighlightInput, request: Request) -> dict[str, Any]:
    return _extract_highlight_result(payload, request)


@app.post("/api/download")
async def download_file(payload: DownloadFileInput, request: Request) -> FileResponse:
    _rate_limit(request)
    entry = _get_cached(payload.download_id)
    try:
        temp_dir, path, filename, media_type = _prepare_media_download(entry, payload)
    except MediaToolError as exc:
        logger.info("Download preparation failed (%s)", type(exc).__name__)
        raise HTTPException(
            502,
            "The selected media could not be prepared. Try another available option.",
        ) from exc
    return _file_response(temp_dir, path, filename, media_type)
