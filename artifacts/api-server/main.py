#!/usr/bin/env python3
"""
OmniDownloader — Production FastAPI Media Archiver & Multi-Engine Extractor
Supports Instagram (Reels, Multi-Slide Carousels, Base64 & Direct Highlights/Stories, 1080p Profile DPs),
TikTok (vt.tiktok.com / vm.tiktok.com Shortlinks, Unwatermarked HD Videos, Photo Slideshows, Audio, DPs),
and Pinterest (pin.it Shortlinks, /originals/ Master Images, Video Pins).
"""

import base64
import io
import json
import os
import re
import subprocess
import time
import uuid
import zipfile
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlencode, urljoin, urlparse, urlunparse

import requests
from bs4 import BeautifulSoup
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

try:
    import yt_dlp  # type: ignore
    HAS_YTDLP = True
except ImportError:
    HAS_YTDLP = False

app = FastAPI(title="OmniDownloader API", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DESKTOP_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
INSTAGRAM_EMBED_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
)
MOBILE_TIKTOK_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1"
)

TRACKING_PARAMS = {
    "cplk", "vrfl", "dlrf", "xtok", "exln", "rpxt", "img_index",
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "igsh", "igshid", "fbclid", "_r", "_t", "is_from_webapp", "sender_device",
    "web_id", "checksum", "tt_from", "share_app_id", "share_link_id", "share_item_id",
}

CACHE_TTL_SECONDS = 3600
RESULT_CACHE: Dict[str, Dict[str, Any]] = {}


class ExtractRequest(BaseModel):
    url: str
    mode: Optional[str] = Field(default="post")
    platform: Optional[str] = Field(default=None)


class HighlightRequest(BaseModel):
    url: str


class DownloadRequest(BaseModel):
    downloadId: Optional[str] = None
    url: Optional[str] = None
    filename: Optional[str] = None
    assetType: str = Field(default="media")
    mediaIndex: Optional[int] = 0
    format: str = Field(default="original")
    bitrate: int = Field(default=320)
    items: Optional[List[Dict[str, Any]]] = None


def prune_cache() -> None:
    now = time.time()
    expired = [k for k, v in RESULT_CACHE.items() if now - v.get("createdAt", 0) > CACHE_TTL_SECONDS]
    for k in expired:
        RESULT_CACHE.pop(k, None)


def safe_filename(name: str, ext: str) -> str:
    base = re.sub(r"[^\w\- ]+", "", (name or "omnidownloader-media").strip())
    base = re.sub(r"\s+", "-", base)[:60] or "omnidownloader-media"
    clean_ext = ext.lstrip(".") or "mp4"
    return f"{base}.{clean_ext}"


def is_generic_instagram_logo(url: Optional[str]) -> bool:
    if not url:
        return True
    lower = url.lower()
    return (
        "instagram_logo" in lower or
        "instagram-logo" in lower or
        "instagramlogo" in lower or
        "instagram_icon" in lower or
        "instagram-icon" in lower or
        "brand_assets" in lower or
        "brand-assets" in lower or
        "brandassets" in lower or
        "brand" in lower or
        "4168x4168" in lower or
        "static.cdninstagram.com" in lower or
        "/rsrc.php/" in lower or
        "/static/images/" in lower or
        "/static/rsrc/" in lower or
        "favicon" in lower or
        "ig_icon" in lower or
        "apple-touch-icon" in lower or
        "play-button" in lower or
        "transparent.png" in lower or
        "spacer.gif" in lower or
        "sprite" in lower or
        "glyph" in lower or
        "meta_logo" in lower or
        "instagram-app" in lower or
        "fbcdn.net/rsrc.php" in lower or
        "150x150" in lower or
        "100x100" in lower or
        bool(re.search(r"logo.*\.(?:png|jpg|jpeg|svg|webp)", lower)) or
        bool(re.search(r"instagram[_-]?(?:glyph|brand|icon|wordmark|logo)", lower))
    )


def is_authentic_story_media(url: Optional[str]) -> bool:
    if not url:
        return False
    if is_generic_instagram_logo(url):
        return False
    lower = url.lower()
    if "instagram_logo" in lower or "brand" in lower or "static.cdninstagram.com" in lower or "/rsrc.php/" in lower or "/static/" in lower:
        return False
    if "cdninstagram.com" not in lower and "fbcdn.net" not in lower and "instagram." not in lower:
        return False
    return (
        ".mp4" in lower or
        ".jpg" in lower or
        ".jpeg" in lower or
        "/v/t51." in lower or
        "_nc_cat" in lower or
        "_nc_sid" in lower or
        "/o1/v/" in lower or
        "video" in lower
    )


def id_to_shortcode(id_str: Optional[str]) -> str:
    if not id_str:
        return ""
    try:
        clean = re.sub(r"\D+", "", str(id_str).split("_")[0])
        if not clean:
            return ""
        alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
        n = int(clean)
        sc = ""
        while n > 0:
            rem = n % 64
            sc = alphabet[rem] + sc
            n //= 64
        return sc
    except Exception:
        return ""


def build_stream_url(raw_url: str, filename: Optional[str] = None, inline: bool = False) -> str:
    params: Dict[str, str] = {"url": raw_url}
    if filename:
        params["filename"] = filename
    if inline:
        params["inline"] = "1"
    return f"/api/stream?{urlencode(params)}"


def strip_tracking_params(url: str) -> Tuple[str, Optional[str]]:
    parsed = urlparse(url)
    qs = parse_qs(parsed.query, keep_blank_values=False)
    story_media_id = qs.get("story_media_id", [None])[0]

    clean_qs = {
        k: v for k, v in qs.items()
        if k.lower() not in TRACKING_PARAMS and not k.lower().startswith("utm_")
    }
    host = (parsed.hostname or "").lower()
    if "instagram.com" in host or "tiktok.com" in host or "pinterest." in host:
        clean_query = ""
    elif "youtube.com" in host or "youtu.be" in host:
        v = qs.get("v", [None])[0]
        clean_query = urlencode({"v": v}) if v else ""
    else:
        clean_query = urlencode(clean_qs, doseq=True)

    cleaned = urlunparse((
        parsed.scheme or "https",
        parsed.netloc,
        parsed.path,
        parsed.params,
        clean_query,
        "",
    ))
    return cleaned, story_media_id


def decode_instagram_share_highlight(url: str) -> str:
    parsed = urlparse(url)
    match = re.match(r"^/s/([A-Za-z0-9+/=_-]+)", parsed.path)
    if not match:
        return url

    token = match.group(1)
    padded = token + "=" * ((4 - len(token) % 4) % 4)
    try:
        decoded = base64.urlsafe_b64decode(padded.encode("utf-8")).decode("utf-8", errors="ignore")
        if decoded.startswith("highlight:"):
            highlight_id = decoded.split(":", 1)[1].strip()
            if highlight_id.isdigit():
                return f"https://www.instagram.com/stories/highlights/{highlight_id}/"
    except Exception:
        pass
    return url


def unshorten_url(raw_url: str) -> str:
    session = requests.Session()
    current = raw_url.strip()

    for hop in range(8):
        parsed = urlparse(current)
        host = (parsed.hostname or "").lower()

        if host in {"youtu.be"} or host.endswith(".youtu.be"):
            vid_id = parsed.path.lstrip("/").split("/")[0].split("?")[0]
            if vid_id:
                current = f"https://www.youtube.com/watch?v={vid_id}"
                break

        is_shortlink = (
            host in {"vt.tiktok.com", "vm.tiktok.com", "pin.it", "instagr.am", "youtu.be"}
            or host.endswith(".youtu.be")
            or parsed.path.startswith("/t/")
            or parsed.path.startswith("/s/")
        )
        if not is_shortlink:
            break

        if "instagram.com" in host and parsed.path.startswith("/s/"):
            decoded = decode_instagram_share_highlight(current)
            if decoded != current:
                current = decoded
                break

        headers = {
            "User-Agent": MOBILE_TIKTOK_UA if "tiktok" in host else DESKTOP_UA,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        }

        try:
            resp = session.get(current, headers=headers, allow_redirects=False, timeout=8)
            if resp.status_code in {301, 302, 303, 307, 308}:
                location = resp.headers.get("Location") or resp.headers.get("location")
                if location:
                    next_url = urljoin(current, location)
                    next_parsed = urlparse(next_url)
                    if "/accounts/login" in next_parsed.path:
                        qs = parse_qs(next_parsed.query)
                        if qs.get("next"):
                            current = urljoin("https://www.instagram.com", qs["next"][0])
                        break
                    if "tiktok.com" in (next_parsed.hostname or "") and (
                        "/about" in next_parsed.path or next_parsed.path in {"", "/"}
                    ):
                        break
                    current = next_url
                    continue
            elif resp.status_code == 200 and is_shortlink:
                html = resp.text[:30000]
                canonical = re.search(
                    r'<link[^>]+rel=["\']canonical["\'][^>]+href=["\']([^"\']+)["\']',
                    html,
                    re.I,
                ) or re.search(
                    r'href=["\'](https?://(?:www\.|m\.)?tiktok\.com/@(?:[^"\']+)/(?:video|photo|story)/\d+[^"\']*)["\']',
                    html,
                    re.I,
                )
                if canonical:
                    current = canonical.group(1).replace("&amp;", "&")
            break
        except Exception:
            break

    current = decode_instagram_share_highlight(current)
    cleaned, _ = strip_tracking_params(current)
    return cleaned


def detect_platform_and_route(
    raw_input: str,
    requested_mode: str = "post",
    requested_platform: Optional[str] = None,
) -> Dict[str, Any]:
    text = raw_input.strip()
    forced_profile = requested_mode == "profile"
    explicit_handle: Optional[str] = None

    if "://" not in text and re.match(r"^@?[\w.-]{1,60}$", text) and "/" not in text:
        explicit_handle = text.lstrip("@")
        forced_profile = True
        plat = requested_platform if requested_platform in {"instagram", "tiktok", "pinterest", "youtube"} else "instagram"
        if plat == "tiktok":
            text = f"https://www.tiktok.com/@{explicit_handle}"
        elif plat == "pinterest":
            text = f"https://www.pinterest.com/{explicit_handle}/"
        elif plat == "youtube":
            text = f"https://www.youtube.com/@{explicit_handle}"
        else:
            text = f"https://www.instagram.com/{explicit_handle}/"
    elif "://" not in text and re.match(
        r"^(?:www\.|m\.|vt\.|vm\.)?(?:instagram\.com|tiktok\.com|pinterest\.com|pin\.it|instagr\.am|youtube\.com|youtu\.be)/",
        text,
        re.I,
    ):
        text = f"https://{text}"

    resolved_url = unshorten_url(text)
    parsed = urlparse(resolved_url)
    host = (parsed.hostname or "").lower()

    platform: Optional[str] = None
    if "instagram.com" in host or "instagr.am" in host:
        platform = "instagram"
    elif "tiktok.com" in host:
        platform = "tiktok"
    elif "pinterest." in host or "pin.it" in host:
        platform = "pinterest"
    elif "youtube.com" in host or "youtu.be" in host:
        platform = "youtube"

    if not platform:
        raise HTTPException(status_code=400, detail="Unsupported link. Paste a public Instagram, TikTok, YouTube, or Pinterest URL.")

    parts = [p for p in parsed.path.split("/") if p]
    route_type = "post"
    handle: Optional[str] = explicit_handle

    if platform == "instagram":
        if len(parts) >= 2 and parts[0].lower() == "stories":
            if parts[1].lower() == "highlights":
                route_type = "highlight"
            else:
                route_type = "story"
                handle = parts[1].lstrip("@")
        elif len(parts) == 1 and parts[0].lower() not in {
            "p", "reel", "reels", "tv", "stories", "explore", "accounts", "direct", "share"
        }:
            route_type = "profile"
            handle = parts[0].lstrip("@")
    elif platform == "tiktok":
        if len(parts) == 1 and parts[0].startswith("@"):
            route_type = "profile"
            handle = parts[0].lstrip("@")
    elif platform == "pinterest":
        if len(parts) == 1 and parts[0].lower() not in {"pin", "search", "ideas"}:
            route_type = "profile"
            handle = parts[0].lstrip("@")
    elif platform == "youtube":
        if parts and parts[0].startswith("@"):
            route_type = "profile"
            handle = parts[0].lstrip("@")
        elif parts and parts[0] in {"channel", "c", "user"} and len(parts) > 1:
            route_type = "profile"
            handle = parts[1]

    if forced_profile:
        route_type = "profile"

    return {
        "url": resolved_url,
        "platform": platform,
        "routeType": route_type,
        "handle": handle,
    }


def compute_aspect_ratio(width: Optional[int], height: Optional[int], fallback: str = "vertical") -> str:
    if not width or not height:
        return fallback
    ratio = width / height
    if ratio < 0.85:
        return "vertical"
    if ratio > 1.15:
        return "horizontal"
    return "square"


def extract_hashtags(*texts: Optional[str]) -> List[str]:
    tags: List[str] = []
    seen = set()
    for t in texts:
        if not t:
            continue
        for match in re.findall(r"(?<!\w)#[\w\u0080-\uffff]+", t):
            if match.lower() not in seen:
                seen.add(match.lower())
                tags.append(match)
    return tags


def parse_srcset_best(srcset: str) -> Optional[str]:
    best_url = None
    best_w = -1
    for part in srcset.split(","):
        tokens = part.strip().split()
        if not tokens:
            continue
        candidate_url = tokens[0].replace("&amp;", "&")
        width = 0
        if len(tokens) > 1 and tokens[1].endswith("w"):
            try:
                width = int(tokens[1][:-1])
            except ValueError:
                width = 0
        if width >= best_w:
            best_w = width
            best_url = candidate_url
    return best_url


def extract_with_ytdlp_fallback(url: str) -> Optional[Dict[str, Any]]:
    if not HAS_YTDLP:
        return None
    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "extract_flat": False,
        "http_headers": {"User-Agent": DESKTOP_UA},
    }
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            if not info:
                return None
            title = info.get("title") or "Social Media Post"
            caption = info.get("description") or title
            uploader = info.get("uploader") or info.get("channel")
            uploader_id = (info.get("uploader_id") or "").lstrip("@") or None
            thumb = info.get("thumbnail")
            entries = info.get("entries") or [info]
            media: List[Dict[str, Any]] = []
            for idx, entry in enumerate(entries):
                m_url = entry.get("url")
                if not m_url and entry.get("formats"):
                    formats = [f for f in entry["formats"] if f.get("url")]
                    if formats:
                        m_url = formats[-1]["url"]
                if not m_url:
                    continue
                ext = entry.get("ext") or "mp4"
                is_vid = ext in {"mp4", "webm", "mov"} or entry.get("vcodec") not in {None, "none"}
                w = entry.get("width") or 1080
                h = entry.get("height") or (1920 if is_vid else 1080)
                media.append({
                    "url": build_stream_url(m_url, safe_filename(f"{title}-{idx+1}", ext), True),
                    "rawUrl": m_url,
                    "downloadUrl": build_stream_url(m_url, safe_filename(f"{title}-{idx+1}", ext), False),
                    "thumbnail": build_stream_url(thumb, "thumb.jpg", True) if thumb else None,
                    "type": "video" if is_vid else "image",
                    "quality": f"{h}p HD" if is_vid else "Original HD",
                    "format": "mp4" if is_vid else "jpg",
                    "width": w,
                    "height": h,
                    "aspectRatio": compute_aspect_ratio(w, h, "vertical"),
                    "hasAudio": is_vid,
                })
            if not media:
                return None
            return {
                "title": title,
                "caption": caption,
                "thumbnail": build_stream_url(thumb, "thumb.jpg", True) if thumb else media[0]["url"],
                "uploadDate": None,
                "audioUrl": media[0]["rawUrl"] if media[0]["type"] == "video" else None,
                "audioAvailable": any(m["type"] == "video" for m in media),
                "isCarousel": len(entries) > 1,
                "creator": {
                    "handle": uploader_id,
                    "name": uploader or uploader_id,
                    "avatarUrl": None,
                    "profileUrl": None,
                    "verified": False,
                },
                "media": media,
            }
    except Exception:
        return None


def extract_instagram(url: str, is_profile: bool, handle: Optional[str]) -> Dict[str, Any]:
    title = ""
    caption = ""
    thumbnail = None
    upload_date = None
    audio_url = None
    audio_available = False
    is_carousel = False
    creator = {
        "handle": handle,
        "name": None,
        "avatarUrl": None,
        "profileUrl": f"https://www.instagram.com/{handle}/" if handle else None,
        "verified": False,
    }
    media: List[Dict[str, Any]] = []

    if is_profile:
        path_parts = [p for p in urlparse(url).path.split("/") if p]
        target_handle = handle or (path_parts[0].lstrip("@") if path_parts else "instagram")
        embed_url = f"https://www.instagram.com/{target_handle}/embed/"
        try:
            resp = requests.get(embed_url, headers={"User-Agent": INSTAGRAM_EMBED_UA}, timeout=9)
            if resp.ok:
                html = resp.text
                ctx_match = re.search(r'"contextJSON"\s*:\s*"((?:\\.|[^"\\])*)"', html)
                if ctx_match:
                    unescaped = json.loads(f'"{ctx_match.group(1)}"')
                    ctx_obj = json.loads(unescaped)
                    ctx = ctx_obj.get("context") or {}
                    pic_url = ctx.get("profile_pic_url")
                    creator["handle"] = ctx.get("username") or target_handle
                    creator["name"] = ctx.get("full_name") or creator["handle"]
                    creator["verified"] = bool(ctx.get("is_verified") or ctx.get("verified"))
                    creator["profileUrl"] = f"https://www.instagram.com/{creator['handle']}/"
                    title = f"{creator['name']} (@{creator['handle']})"
                    followers = ctx.get("followers_count")
                    posts_cnt = ctx.get("posts_count")
                    if followers is not None or posts_cnt is not None:
                        caption = f"{followers or 0:,} followers · {posts_cnt or 0:,} public posts"
                    if pic_url:
                        proxied = build_stream_url(pic_url, f"{creator['handle']}-profile-hd.jpg", True)
                        creator["avatarUrl"] = proxied
                        thumbnail = proxied
                        media.append({
                            "url": proxied,
                            "rawUrl": pic_url,
                            "downloadUrl": build_stream_url(pic_url, f"{creator['handle']}-profile-photo-hd.jpg", False),
                            "thumbnail": proxied,
                            "type": "profile",
                            "quality": "Original HD · 1080×1080",
                            "format": "jpg",
                            "width": 1080,
                            "height": 1080,
                            "aspectRatio": "square",
                            "hasAudio": False,
                        })
        except Exception:
            pass
        return {
            "title": title or f"@{target_handle}",
            "caption": caption,
            "thumbnail": thumbnail,
            "uploadDate": upload_date,
            "audioUrl": audio_url,
            "audioAvailable": audio_available,
            "isCarousel": False,
            "creator": creator,
            "media": media,
        }

    sc_match = re.search(r"/(?:p|reel|reels|tv)/([A-Za-z0-9_-]+)", url, re.I)
    shortcode = sc_match.group(1) if sc_match else None
    is_reel = bool(re.search(r"/reels?/", url, re.I))

    if shortcode:
        embed_url = f"https://www.instagram.com/p/{shortcode}/embed/captioned/"
        try:
            resp = requests.get(embed_url, headers={"User-Agent": INSTAGRAM_EMBED_UA}, timeout=9)
            if resp.ok:
                html = resp.text
                soup = BeautifulSoup(html, "html.parser")

                user_el = soup.select_one(".UsernameText, a.eb_header_username")
                if user_el and user_el.get_text(strip=True):
                    creator["handle"] = user_el.get_text(strip=True).lstrip("@")
                    creator["name"] = creator["handle"]
                    creator["profileUrl"] = f"https://www.instagram.com/{creator['handle']}/"

                avatar_el = soup.select_one(".Header .Avatar img, a.Avatar img")
                if avatar_el and avatar_el.get("src"):
                    raw_av = str(avatar_el["src"]).replace("&amp;", "&")
                    creator["avatarUrl"] = build_stream_url(raw_av, f"{creator['handle'] or 'ig'}-avatar.jpg", True)

                cap_el = soup.select_one(".Caption")
                if cap_el:
                    for rm in cap_el.select(".CaptionUsername, .CaptionComments"):
                        rm.decompose()
                    cap_text = cap_el.get_text(" ", strip=True)
                    if cap_text:
                        caption = cap_text
                        title = cap_text[:90]

                ctx_match = re.search(r'"contextJSON"\s*:\s*"((?:\\.|[^"\\])*)"', html)
                media_data = None
                if ctx_match:
                    unescaped = json.loads(f'"{ctx_match.group(1)}"')
                    parsed_ctx = json.loads(unescaped)
                    media_data = (parsed_ctx.get("gql_data") or {}).get("shortcode_media")

                if media_data:
                    owner = media_data.get("owner") or {}
                    if owner.get("username"):
                        creator["handle"] = owner["username"]
                        creator["name"] = owner.get("full_name") or owner["username"]
                        creator["verified"] = bool(owner.get("is_verified"))
                        creator["profileUrl"] = f"https://www.instagram.com/{creator['handle']}/"
                    if owner.get("profile_pic_url"):
                        creator["avatarUrl"] = build_stream_url(
                            owner["profile_pic_url"], f"{creator['handle'] or 'ig'}-avatar.jpg", True
                        )

                    edges_cap = (media_data.get("edge_media_to_caption") or {}).get("edges") or []
                    if edges_cap and edges_cap[0].get("node", {}).get("text"):
                        caption = edges_cap[0]["node"]["text"]
                        title = caption.split("\n")[0][:95] or "Instagram Post"

                    sidecar = (media_data.get("edge_sidecar_to_children") or {}).get("edges") or []
                    if sidecar:
                        is_carousel = len(sidecar) > 1
                        for idx, edge in enumerate(sidecar):
                            node = edge.get("node") or {}
                            dims = node.get("dimensions") or {}
                            w = dims.get("width") or 1080
                            h = dims.get("height") or 1080
                            disp = node.get("display_url")
                            thumb = build_stream_url(disp, f"thumb-{idx+1}.jpg", True) if disp else None
                            if node.get("is_video") and node.get("video_url"):
                                raw_v = node["video_url"]
                                media.append({
                                    "url": build_stream_url(raw_v, f"slide-{idx+1}.mp4", True),
                                    "rawUrl": raw_v,
                                    "downloadUrl": build_stream_url(raw_v, safe_filename(f"{title or 'instagram'}-slide-{idx+1}", "mp4"), False),
                                    "thumbnail": thumb,
                                    "type": "video",
                                    "quality": f"Slide {idx+1} · 1080p Video",
                                    "format": "mp4",
                                    "width": w,
                                    "height": h,
                                    "aspectRatio": compute_aspect_ratio(w, h, "vertical"),
                                    "hasAudio": True,
                                })
                                audio_available = True
                                if not audio_url:
                                    audio_url = raw_v
                            elif disp:
                                media.append({
                                    "url": thumb,
                                    "rawUrl": disp,
                                    "downloadUrl": build_stream_url(disp, safe_filename(f"{title or 'instagram'}-slide-{idx+1}", "jpg"), False),
                                    "thumbnail": thumb,
                                    "type": "image",
                                    "quality": f"Slide {idx+1} · Original HD",
                                    "format": "jpg",
                                    "width": w,
                                    "height": h,
                                    "aspectRatio": compute_aspect_ratio(w, h, "square"),
                                    "hasAudio": False,
                                })
                    elif media_data.get("is_video") and media_data.get("video_url"):
                        raw_v = media_data["video_url"]
                        disp = media_data.get("display_url")
                        dims = media_data.get("dimensions") or {}
                        w = dims.get("width") or 1080
                        h = dims.get("height") or 1920
                        thumbnail = build_stream_url(disp, "thumb.jpg", True) if disp else None
                        media.append({
                            "url": build_stream_url(raw_v, safe_filename(title or "instagram-reel", "mp4"), True),
                            "rawUrl": raw_v,
                            "downloadUrl": build_stream_url(raw_v, safe_filename(title or "instagram-reel", "mp4"), False),
                            "thumbnail": thumbnail,
                            "type": "video",
                            "quality": "Full HD · 1080p",
                            "format": "mp4",
                            "width": w,
                            "height": h,
                            "aspectRatio": compute_aspect_ratio(w, h, "vertical" if is_reel else "square"),
                            "hasAudio": True,
                        })
                        audio_available = True
                        audio_url = raw_v
                    elif media_data.get("display_url"):
                        disp = media_data["display_url"]
                        dims = media_data.get("dimensions") or {}
                        w = dims.get("width") or 1080
                        h = dims.get("height") or 1080
                        proxied = build_stream_url(disp, "image.jpg", True)
                        thumbnail = proxied
                        media.append({
                            "url": proxied,
                            "rawUrl": disp,
                            "downloadUrl": build_stream_url(disp, safe_filename(title or "instagram-image", "jpg"), False),
                            "thumbnail": proxied,
                            "type": "image",
                            "quality": "Original HD · 1080p",
                            "format": "jpg",
                            "width": w,
                            "height": h,
                            "aspectRatio": compute_aspect_ratio(w, h, "square"),
                            "hasAudio": False,
                        })

                if not media:
                    img_el = soup.select_one("img.EmbeddedMediaImage")
                    if img_el:
                        srcset = str(img_el.get("srcset") or "")
                        best_img = parse_srcset_best(srcset) or str(img_el.get("src") or "").replace("&amp;", "&")
                        if best_img:
                            proxied = build_stream_url(best_img, "image.jpg", True)
                            thumbnail = proxied
                            media.append({
                                "url": proxied,
                                "rawUrl": best_img,
                                "downloadUrl": build_stream_url(best_img, safe_filename(title or "instagram-post", "jpg"), False),
                                "thumbnail": proxied,
                                "type": "image",
                                "quality": "Original HD · 1080p",
                                "format": "jpg",
                                "width": 1080,
                                "height": 1080,
                                "aspectRatio": "square",
                                "hasAudio": False,
                            })
        except Exception:
            pass

    if not media:
        ytdlp_res = extract_with_ytdlp_fallback(url)
        if ytdlp_res:
            return ytdlp_res

    return {
        "title": title or "Instagram Post",
        "caption": caption,
        "thumbnail": thumbnail or (media[0]["thumbnail"] if media else None),
        "uploadDate": upload_date,
        "audioUrl": audio_url,
        "audioAvailable": audio_available,
        "isCarousel": is_carousel,
        "creator": creator,
        "media": media,
    }


def extract_tiktok(url: str, is_profile: bool, handle: Optional[str]) -> Dict[str, Any]:
    title = ""
    caption = ""
    thumbnail = None
    upload_date = None
    audio_url = None
    audio_available = False
    is_carousel = False
    creator = {
        "handle": handle,
        "name": None,
        "avatarUrl": None,
        "profileUrl": f"https://www.tiktok.com/@{handle}" if handle else None,
        "verified": False,
    }
    media: List[Dict[str, Any]] = []

    if is_profile:
        target_handle = handle or (url.split("/@")[1].split("/")[0].split("?")[0] if "/@" in url else "tiktok")
        # Strategy 1: TikTok embed page scraper (bypasses Cloudflare & datacenter IP blocks, extracts 1080p DP)
        try:
            emb_resp = requests.get(
                f"https://www.tiktok.com/embed/@{target_handle}",
                headers={"User-Agent": DESKTOP_UA},
                timeout=8,
            )
            if emb_resp.ok:
                m = re.search(r'https://[^"\'\s]+(?:avt|avatar|tiktokcdn)[^"\'\s]+tplv-tiktokx-cropcenter:[^"\'\s]+', emb_resp.text, re.I)
                if m:
                    raw_av = m.group(0).replace("&amp;", "&")
                    hd_av = re.sub(r'cropcenter:\d+:\d+', 'cropcenter:1080:1080', raw_av)
                    creator["handle"] = target_handle
                    creator["name"] = target_handle
                    creator["profileUrl"] = f"https://www.tiktok.com/@{target_handle}"
                    title = f"{target_handle} (@{target_handle})"
                    proxied = build_stream_url(hd_av, f"{target_handle}-avatar.jpg", True)
                    creator["avatarUrl"] = proxied
                    thumbnail = proxied
                    media.append({
                        "url": proxied,
                        "rawUrl": hd_av,
                        "downloadUrl": build_stream_url(hd_av, f"{target_handle}-profile-photo-hd.jpg", False),
                        "thumbnail": proxied,
                        "type": "profile",
                        "quality": "Original HD · 1080×1080",
                        "format": "jpg",
                        "width": 1080,
                        "height": 1080,
                        "aspectRatio": "square",
                        "hasAudio": False,
                    })
        except Exception:
            pass

        if not media:
            try:
                resp = requests.get(
                    f"https://www.tikwm.com/api/user/info?unique_id={target_handle}",
                    headers={"User-Agent": DESKTOP_UA},
                    timeout=8,
                )
                if resp.ok:
                    user = (resp.json().get("data") or {}).get("user") or {}
                    hd_av = user.get("avatarLarger") or user.get("avatarMedium") or user.get("avatarThumb")
                    if hd_av:
                        creator["handle"] = user.get("uniqueId") or target_handle
                        creator["name"] = user.get("nickname") or creator["handle"]
                        creator["verified"] = bool(user.get("verified"))
                        creator["profileUrl"] = f"https://www.tiktok.com/@{creator['handle']}"
                        caption = user.get("signature") or ""
                        title = f"{creator['name']} (@{creator['handle']})"
                        proxied = build_stream_url(hd_av, f"{creator['handle']}-avatar.jpg", True)
                        creator["avatarUrl"] = proxied
                        thumbnail = proxied
                        media.append({
                            "url": proxied,
                            "rawUrl": hd_av,
                            "downloadUrl": build_stream_url(hd_av, f"{creator['handle']}-profile-photo-hd.jpg", False),
                            "thumbnail": proxied,
                            "type": "profile",
                            "quality": "Original HD · 1080×1080",
                            "format": "jpg",
                            "width": 1080,
                            "height": 1080,
                            "aspectRatio": "square",
                            "hasAudio": False,
                        })
            except Exception:
                pass
        return {
            "title": title or f"@{target_handle}",
            "caption": caption,
            "thumbnail": thumbnail,
            "uploadDate": upload_date,
            "audioUrl": audio_url,
            "audioAvailable": audio_available,
            "isCarousel": False,
            "creator": creator,
            "media": media,
        }

    # TikWM API for Stories, Videos, and Photo Slideshows
    is_story = bool(re.search(r"/story/", url, re.I))
    try:
        d = None
        # Try GET endpoint first: https://www.tikwm.com/api/?url={unshortened_url}
        try:
            r_get = requests.get(
                f"https://www.tikwm.com/api/?url={url}&hd=1",
                headers={"User-Agent": MOBILE_TIKTOK_UA},
                timeout=8,
            )
            if r_get.ok:
                res_json = r_get.json()
                if res_json.get("data") and (res_json["data"].get("play") or res_json["data"].get("hdplay") or res_json["data"].get("images")):
                    d = res_json["data"]
        except Exception:
            pass

        # Try POST fallback
        if not d:
            resp = requests.post(
                "https://www.tikwm.com/api/",
                data={"url": url, "hd": "1"},
                headers={
                    "User-Agent": DESKTOP_UA,
                    "Origin": "https://www.tikwm.com",
                    "Referer": "https://www.tikwm.com/",
                },
                timeout=10,
            )
            if resp.ok:
                d = resp.json().get("data") or {}

        if d:
            title = d.get("title") or ("TikTok Story" if is_story else "TikTok Post")
            caption = title
                author = d.get("author") or {}
                creator["handle"] = author.get("unique_id")
                creator["name"] = author.get("nickname") or creator["handle"]
                if creator["handle"]:
                    creator["profileUrl"] = f"https://www.tiktok.com/@{creator['handle']}"
                if author.get("avatar"):
                    av = author["avatar"] if author["avatar"].startswith("http") else f"https://www.tikwm.com{author['avatar']}"
                    creator["avatarUrl"] = build_stream_url(av, "avatar.jpg", True)

                raw_cover = d.get("origin_cover") or d.get("cover")
                if raw_cover:
                    full_cover = raw_cover if raw_cover.startswith("http") else f"https://www.tikwm.com{raw_cover}"
                    thumbnail = build_stream_url(full_cover, "thumbnail.jpg", True)

                raw_music = d.get("music") or (d.get("music_info") or {}).get("play")
                if isinstance(raw_music, str) and raw_music:
                    audio_url = raw_music if raw_music.startswith("http") else f"https://www.tikwm.com{raw_music}"
                    audio_available = True

                sd_url = d.get("play")
                hd_url = d.get("hdplay")
                images = d.get("images")
                w = d.get("width") or 1080
                h = d.get("height") or 1920
                aspect_ratio = compute_aspect_ratio(w, h, "vertical")
                has_video = bool(sd_url or hd_url)
                has_images = isinstance(images, list) and len(images) > 0

                if sd_url:
                    full_sd = sd_url if sd_url.startswith("http") else f"https://www.tikwm.com{sd_url}"
                    media.append({
                        "url": build_stream_url(full_sd, safe_filename(title, "mp4"), True),
                        "rawUrl": full_sd,
                        "downloadUrl": build_stream_url(full_sd, safe_filename(f"{title}-watermark-free", "mp4"), False),
                        "thumbnail": thumbnail,
                        "type": "video",
                        "quality": "Clean Story Video (Watermark-Free) · 1080p" if is_story else "Clean Video (Watermark-Free) · 1080p",
                        "format": "mp4",
                        "width": w,
                        "height": h,
                        "aspectRatio": aspect_ratio,
                        "hasAudio": True,
                    })
                    audio_available = True

                if hd_url and hd_url != sd_url:
                    full_hd = hd_url if hd_url.startswith("http") else f"https://www.tikwm.com{hd_url}"
                    media.append({
                        "url": build_stream_url(full_hd, safe_filename(title, "mp4"), True),
                        "rawUrl": full_hd,
                        "downloadUrl": build_stream_url(full_hd, safe_filename(f"{title}-hd-1080p", "mp4"), False),
                        "thumbnail": thumbnail,
                        "type": "video",
                        "quality": "Full HD · 1080p",
                        "format": "mp4",
                        "width": w,
                        "height": h,
                        "aspectRatio": aspect_ratio,
                        "hasAudio": True,
                    })
                    audio_available = True

                if has_images:
                    if not has_video:
                        is_carousel = len(images) > 1
                    for idx, img_url in enumerate(images):
                        if not img_url:
                            continue
                        full_img = img_url if img_url.startswith("http") else f"https://www.tikwm.com{img_url}"
                        proxied = build_stream_url(full_img, f"slide-{idx+1}.jpg", True)
                        media.append({
                            "url": proxied,
                            "rawUrl": full_img,
                            "downloadUrl": build_stream_url(full_img, safe_filename(f"{title}-slide-{idx+1}", "jpg"), False),
                            "thumbnail": proxied,
                            "type": "image",
                            "quality": f"Slide {idx+1} · Full HD",
                            "format": "jpg",
                            "width": 1080,
                            "height": 1440,
                            "aspectRatio": "vertical",
                            "hasAudio": False,
                        })

                if not thumbnail and media:
                    thumbnail = media[0].get("thumbnail") or media[0].get("url")
    except Exception:
        pass

    if not media:
        ytdlp_res = extract_with_ytdlp_fallback(url)
        if ytdlp_res:
            return ytdlp_res

    return {
        "title": title or "TikTok Post",
        "caption": caption,
        "thumbnail": thumbnail or (media[0]["thumbnail"] if media else None),
        "uploadDate": upload_date,
        "audioUrl": audio_url,
        "audioAvailable": audio_available,
        "isCarousel": is_carousel,
        "creator": creator,
        "media": media,
    }


def extract_pinterest(url: str, is_profile: bool, handle: Optional[str]) -> Dict[str, Any]:
    title = ""
    caption = ""
    thumbnail = None
    audio_url = None
    audio_available = False
    creator = {
        "handle": handle,
        "name": None,
        "avatarUrl": None,
        "profileUrl": f"https://www.pinterest.com/{handle}/" if handle else None,
        "verified": False,
    }
    media: List[Dict[str, Any]] = []

    try:
        oembed = requests.get(
            f"https://www.pinterest.com/oembed.json?url={url}",
            headers={"User-Agent": DESKTOP_UA},
            timeout=6,
        )
        if oembed.ok:
            data = oembed.json()
            title = data.get("title") or ""
            caption = title
            creator["name"] = data.get("author_name")
            creator["profileUrl"] = data.get("author_url")
            if data.get("thumbnail_url"):
                thumbnail = re.sub(r"/(?:\d{2,4}x(?:\d{2,4})?|[0-9]+x[0-9]+)/", "/originals/", data["thumbnail_url"])
    except Exception:
        pass

    try:
        resp = requests.get(url, headers={"User-Agent": DESKTOP_UA}, timeout=8)
        if resp.ok:
            html = resp.text
            soup = BeautifulSoup(html, "html.parser")
            og_title = soup.find("meta", property="og:title")
            og_desc = soup.find("meta", property="og:description")
            og_img = soup.find("meta", property="og:image")
            og_vid = soup.find("meta", property="og:video") or soup.find("meta", property="og:video:url")

            if not title and og_title and og_title.get("content"):
                title = str(og_title["content"])
            if not caption and og_desc and og_desc.get("content"):
                caption = str(og_desc["content"])

            vid_url = str(og_vid["content"]) if og_vid and og_vid.get("content") else None
            if not vid_url:
                v_match = re.search(r'"(https://v1\.pinimg\.com/videos/[^"]+\.mp4)"', html)
                if v_match:
                    vid_url = v_match.group(1)

            img_url = str(og_img["content"]) if og_img and og_img.get("content") else thumbnail
            if img_url and "pinimg.com" in img_url:
                img_url = re.sub(r"/(?:\d{2,4}x(?:\d{2,4})?|[0-9]+x[0-9]+)/", "/originals/", img_url)

            if is_profile and img_url:
                creator["avatarUrl"] = img_url
                thumbnail = img_url
                media.append({
                    "url": img_url,
                    "rawUrl": img_url,
                    "downloadUrl": build_stream_url(img_url, safe_filename(title or "pinterest-profile", "jpg"), False),
                    "thumbnail": img_url,
                    "type": "profile",
                    "quality": "Original HD · 1080×1080",
                    "format": "jpg",
                    "width": 1080,
                    "height": 1080,
                    "aspectRatio": "square",
                    "hasAudio": False,
                })
            else:
                if vid_url:
                    media.append({
                        "url": build_stream_url(vid_url, safe_filename(title or "pinterest-video", "mp4"), True),
                        "rawUrl": vid_url,
                        "downloadUrl": build_stream_url(vid_url, safe_filename(title or "pinterest-video", "mp4"), False),
                        "thumbnail": img_url,
                        "type": "video",
                        "quality": "Full HD Video",
                        "format": "mp4",
                        "width": 1080,
                        "height": 1920,
                        "aspectRatio": "vertical",
                        "hasAudio": True,
                    })
                    audio_available = True
                    audio_url = vid_url
                elif img_url:
                    media.append({
                        "url": img_url,
                        "rawUrl": img_url,
                        "downloadUrl": build_stream_url(img_url, safe_filename(title or "pinterest-pin", "jpg"), False),
                        "thumbnail": img_url,
                        "type": "image",
                        "quality": "Original Master HD",
                        "format": "jpg",
                        "width": 1200,
                        "height": 1800,
                        "aspectRatio": "vertical",
                        "hasAudio": False,
                    })
    except Exception:
        pass

    return {
        "title": title or "Pinterest Pin",
        "caption": caption,
        "thumbnail": thumbnail or (media[0]["thumbnail"] if media else None),
        "uploadDate": None,
        "audioUrl": audio_url,
        "audioAvailable": audio_available,
        "isCarousel": False,
        "creator": creator,
        "media": media,
    }


def extract_youtube(target_url: str, is_profile: bool, profile_handle: Optional[str]) -> Dict[str, Any]:
    title = ""
    caption = ""
    thumbnail = None
    upload_date = None
    audio_url = None
    audio_available = False
    creator = {
        "handle": profile_handle,
        "name": None,
        "avatarUrl": None,
        "profileUrl": f"https://www.youtube.com/@{profile_handle}" if profile_handle else None,
        "verified": False,
    }
    media: List[Dict[str, Any]] = []

    # 1. Profile / Channel Avatar Mode (DP)
    if is_profile:
        handle = profile_handle or (target_url.split("/@")[1].split("/")[0] if "/@" in target_url else "")
        try:
            resp = requests.get(
                target_url,
                headers={"User-Agent": DESKTOP_UA, "Accept-Language": "en-US,en;q=0.9"},
                timeout=8,
            )
            if resp.ok:
                html = resp.text
                og_title = re.search(r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']+)["\']', html, re.I)
                og_img = re.search(r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']', html, re.I)
                og_desc = re.search(r'<meta[^>]+property=["\']og:description["\'][^>]+content=["\']([^"\']+)["\']', html, re.I)
                avatar_match = re.search(r'"avatar":\s*\{\s*"thumbnails":\s*\[(.*?)\]', html, re.S)

                raw_avatar = og_img.group(1) if og_img else None
                if avatar_match:
                    try:
                        thumbs = json.loads(f"[{avatar_match.group(1)}]")
                        if thumbs:
                            raw_avatar = thumbs[-1].get("url") or raw_avatar
                    except Exception:
                        pass

                if raw_avatar:
                    hd_avatar = re.sub(r"=s\d+", "=s1080", raw_avatar)
                    creator["name"] = og_title.group(1) if og_title else (handle or "YouTube Creator")
                    creator["handle"] = handle or None
                    creator["profileUrl"] = target_url
                    title = f"{creator['name']} (@{creator['handle']})" if creator["handle"] else creator["name"]
                    caption = og_desc.group(1) if og_desc else ""

                    proxied_avatar = build_stream_url(hd_avatar, f"{handle or 'creator'}-avatar-hd.jpg", True)
                    creator["avatarUrl"] = proxied_avatar
                    thumbnail = proxied_avatar

                    media.append({
                        "url": proxied_avatar,
                        "rawUrl": hd_avatar,
                        "downloadUrl": build_stream_url(hd_avatar, f"{handle or 'creator'}-profile-photo-hd.jpg", False),
                        "thumbnail": proxied_avatar,
                        "type": "profile",
                        "quality": "Original HD · 1080×1080",
                        "format": "jpg",
                        "width": 1080,
                        "height": 1080,
                        "aspectRatio": "square",
                        "hasAudio": False,
                    })
        except Exception:
            pass

    # 2. Video / Shorts Mode
    if not media:
        yt_bin = "/bin/yt-dlp" if os.path.exists("/bin/yt-dlp") else "yt-dlp"

        # Strategy A: Standard yt-dlp with full progressive/merged formats (up to 4K / 2160p)
        try:
            cmd = [yt_bin, "--dump-single-json", "--no-warnings", target_url]
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
            if proc.returncode == 0 and proc.stdout.strip():
                yt_data = json.loads(proc.stdout)
        except Exception:
            pass

        # Strategy B: Bot bypass fallback with android client
        if not yt_data:
            try:
                cmd = [
                    yt_bin,
                    "--dump-single-json",
                    "--no-warnings",
                    "--extractor-args",
                    "youtube:player_client=android",
                    target_url,
                ]
                proc = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
                if proc.returncode == 0 and proc.stdout.strip():
                    yt_data = json.loads(proc.stdout)
            except Exception:
                pass

        # Strategy C: Bot bypass fallback with android,web
        if not yt_data:
            try:
                cmd = [
                    yt_bin,
                    "--dump-single-json",
                    "--no-warnings",
                    "--extractor-args",
                    "youtube:player_client=android,web",
                    target_url,
                ]
                proc = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
                if proc.returncode == 0 and proc.stdout.strip():
                    yt_data = json.loads(proc.stdout)
            except Exception:
                pass

        # Strategy D: Invidious fallback
        if not yt_data:
            video_id = ""
            parsed = urlparse(target_url)
            qs = parse_qs(parsed.query)
            if qs.get("v"):
                video_id = qs["v"][0]
            elif "/shorts/" in parsed.path:
                video_id = parsed.path.split("/shorts/")[1].split("/")[0]

            if video_id:
                for mir in [
                    f"https://yt.drgnz.club/api/v1/videos/{video_id}",
                    f"https://invidious.jing.rocks/api/v1/videos/{video_id}",
                    f"https://invidious.projectsegfau.lt/api/v1/videos/{video_id}",
                ]:
                    try:
                        m_res = requests.get(mir, headers={"User-Agent": DESKTOP_UA}, timeout=6)
                        if m_res.ok:
                            yt_data = m_res.json()
                            break
                    except Exception:
                        pass

        if yt_data:
            title = yt_data.get("title") or "YouTube Video"
            caption = yt_data.get("description") or ""
            if yt_data.get("upload_date"):
                d = str(yt_data["upload_date"])
                upload_date = f"{d[:4]}-{d[4:6]}-{d[6:8]}"
            elif yt_data.get("published"):
                upload_date = time.strftime("%Y-%m-%d", time.gmtime(yt_data["published"]))

            creator["name"] = yt_data.get("uploader") or yt_data.get("channel") or yt_data.get("author") or "YouTube Creator"
            creator["handle"] = yt_data.get("uploader_id") or yt_data.get("channel_id")
            creator["profileUrl"] = yt_data.get("channel_url") or yt_data.get("uploader_url")

            raw_thumb = yt_data.get("thumbnail") or (f"https://i.ytimg.com/vi/{yt_data['id']}/maxresdefault.jpg" if yt_data.get("id") else None)
            if raw_thumb:
                thumbnail = build_stream_url(raw_thumb, "thumbnail.jpg", True)

            is_shorts = "/shorts/" in target_url or any(
                f.get("height") and f.get("width") and f["height"] > f["width"]
                for f in yt_data.get("formats", [])
            )
            default_aspect = "vertical" if is_shorts else "horizontal"

            raw_formats = yt_data.get("formats") or yt_data.get("formatStreams") or []
            heights_found = [f.get("height") or 0 for f in raw_formats if f.get("height")]
            max_height = max(heights_found) if heights_found else 1080

            progressive_format = next(
                (f for f in raw_formats if f.get("vcodec") and f["vcodec"] != "none" and f.get("acodec") and f["acodec"] != "none" and f.get("url") and "manifest.googlevideo.com" not in f["url"]),
                next((f for f in raw_formats if f.get("format_id") == "18" and f.get("url")), None)
            )
            preview_url = (progressive_format.get("url") if progressive_format else None) or next((f["url"] for f in raw_formats if f.get("url") and f.get("vcodec") != "none"), target_url)

            audio_available = True
            audio_url = target_url

            target_ladder = [2160, 1440, 1080, 720, 480, 360]
            valid_heights = [h for h in target_ladder if h <= max_height or h == 720 or h == 360]
            if max_height >= 1080 and 1080 not in valid_heights:
                valid_heights.append(1080)
            valid_heights.sort(reverse=True)

            for idx, h in enumerate(valid_heights):
                q_name = f"{h}p"
                if h >= 2160: q_name = "4K · 2160p"
                elif h >= 1440: q_name = "QHD · 1440p"
                elif h >= 1080: q_name = "Full HD · 1080p"
                elif h >= 720: q_name = "HD · 720p"
                elif h >= 480: q_name = "SD · 480p"
                else: q_name = "SD · 360p"

                w = (1215 if h == 2160 else 810 if h == 1440 else 608 if h == 1080 else 405 if h == 720 else 270) if is_shorts else (3840 if h == 2160 else 2560 if h == 1440 else 1920 if h == 1080 else 1280 if h == 720 else 854)

                media.append({
                    "url": build_stream_url(preview_url, safe_filename(f"{title}-{h}p", "mp4"), True),
                    "rawUrl": target_url,
                    "downloadUrl": f"/api/download?downloadId=pending&format=mp4&assetType=media&mediaIndex={idx}",
                    "thumbnail": thumbnail,
                    "type": "video",
                    "quality": q_name,
                    "format": "mp4",
                    "width": w,
                    "height": h,
                    "aspectRatio": compute_aspect_ratio(w, h, default_aspect),
                    "hasAudio": True,
                })

            if not media:
                avail = [f for f in raw_formats if f.get("url") and (f.get("vcodec") != "none" or f.get("height"))]
                avail.sort(key=lambda x: x.get("height") or 0, reverse=True)
                if avail:
                    top_f = avail[0]
                    h = top_f.get("height") or 720
                    w = top_f.get("width") or (720 if is_shorts else 1280)
                    media.append({
                        "url": build_stream_url(top_f["url"], safe_filename(title, "mp4"), True),
                        "rawUrl": top_f["url"],
                        "downloadUrl": build_stream_url(top_f["url"], safe_filename(title, "mp4"), False),
                        "thumbnail": thumbnail,
                        "type": "video",
                        "quality": "Full HD · 1080p" if h >= 1080 else "HD · 720p" if h >= 720 else "SD · 480p",
                        "format": top_f.get("ext") or "mp4",
                        "width": w,
                        "height": h,
                        "aspectRatio": compute_aspect_ratio(w, h, default_aspect),
                        "hasAudio": bool(top_f.get("acodec") and top_f["acodec"] != "none"),
                    })

    # oEmbed fallback
    if not media:
        try:
            oem = requests.get(f"https://www.youtube.com/oembed?url={requests.utils.quote(target_url)}&format=json", timeout=5).json()
            title = oem.get("title") or title or "YouTube Video"
            creator["name"] = oem.get("author_name") or creator["name"]
            raw_thumb = oem.get("thumbnail_url")
            if raw_thumb:
                thumbnail = build_stream_url(raw_thumb, "thumbnail.jpg", True)
            media.append({
                "url": build_stream_url(target_url, safe_filename(title, "mp4"), True),
                "rawUrl": target_url,
                "downloadUrl": build_stream_url(target_url, safe_filename(title, "mp4"), False),
                "thumbnail": thumbnail,
                "type": "video",
                "quality": "Full HD · 1080p",
                "format": "mp4",
                "width": 1920,
                "height": 1080,
                "aspectRatio": "horizontal",
                "hasAudio": True,
            })
            audio_available = True
            audio_url = target_url
        except Exception:
            pass

    return {
        "title": title or "YouTube Video",
        "caption": caption,
        "thumbnail": thumbnail,
        "uploadDate": upload_date,
        "audioUrl": audio_url,
        "audioAvailable": audio_available,
        "isCarousel": False,
        "creator": creator,
        "media": media,
    }


@app.get("/api/stream")
def stream_media(
    url: str = Query(...),
    filename: str = Query(default="omnidownloader-media"),
    inline: Optional[str] = Query(default=None),
):
    parsed = urlparse(url)
    referer = (
        "https://www.tiktok.com/"
        if "tiktok" in (parsed.hostname or "")
        else "https://www.instagram.com/"
        if "instagram" in (parsed.hostname or "") or "fbcdn" in (parsed.hostname or "")
        else f"{parsed.scheme}://{parsed.netloc}/"
    )
    resp = requests.get(
        url,
        headers={"User-Agent": DESKTOP_UA, "Referer": referer},
        stream=True,
        timeout=25,
    )
    if not resp.ok:
        raise HTTPException(status_code=502, detail="Media source could not be reached.")

    headers = {
        "Access-Control-Allow-Origin": "*",
        "Cross-Origin-Resource-Policy": "cross-origin",
    }
    if inline != "1":
        clean_name = re.sub(r"[^\w.\- ]+", "_", filename)
        headers["Content-Disposition"] = f'attachment; filename="{clean_name}"'

    return StreamingResponse(
        resp.iter_content(chunk_size=65536),
        media_type=resp.headers.get("Content-Type", "application/octet-stream"),
        headers=headers,
    )


@app.post("/api/extract")
def extract_route(payload: ExtractRequest):
    prune_cache()
    route = detect_platform_and_route(payload.url, payload.mode or "post", payload.platform)
    platform = route["platform"]
    is_profile = route["routeType"] == "profile"
    handle = route["handle"]

    if platform == "instagram":
        extracted = extract_instagram(route["url"], is_profile, handle)
    elif platform == "tiktok":
        extracted = extract_tiktok(route["url"], is_profile, handle)
    elif platform == "youtube":
        extracted = extract_youtube(route["url"], is_profile, handle)
    else:
        extracted = extract_pinterest(route["url"], is_profile, handle)

    media = extracted.get("media") or []
    if not media:
        raise HTTPException(
            status_code=422,
            detail="We couldn’t retrieve this public post. It may be private, expired, or temporarily unavailable.",
        )

    result_type = "image"
    if is_profile or all(m.get("type") == "profile" for m in media):
        result_type = "profile"
    elif extracted.get("isCarousel"):
        result_type = "carousel"
    elif any(m.get("type") == "video" for m in media):
        result_type = "video"

    download_id = uuid.uuid4().hex
    RESULT_CACHE[download_id] = {
        "createdAt": time.time(),
        "media": media,
        "creator": extracted["creator"],
        "audioUrl": extracted.get("audioUrl"),
        "title": extracted["title"],
    }

    return {
        "downloadId": download_id,
        "status": "success",
        "platform": platform,
        "type": result_type,
        "title": extracted["title"],
        "caption": extracted["caption"],
        "description": extracted["caption"],
        "uploadDate": extracted.get("uploadDate"),
        "boardName": None,
        "hashtags": extract_hashtags(extracted["caption"], extracted["title"]),
        "thumbnail": extracted.get("thumbnail"),
        "audioUrl": (
            build_stream_url(extracted["audioUrl"], safe_filename(f"{extracted['title']}-audio", "mp3"), False)
            if extracted.get("audioUrl")
            else None
        ),
        "creator": extracted["creator"],
        "media": media,
        "audioAvailable": extracted.get("audioAvailable", False),
    }


@app.post("/api/highlight")
def highlight_route(payload: HighlightRequest):
    prune_cache()
    raw_url = payload.url.strip()
    if not raw_url.startswith("http"):
        raw_url = f"https://{raw_url}"
    unshortened = unshorten_url(raw_url)

    route = detect_platform_and_route(unshortened, "post", "instagram")
    target_url = route["url"]

    download_id = uuid.uuid4().hex
    title = "Instagram Story"
    cover = None
    creator = {
        "handle": route.get("handle"),
        "name": route.get("handle"),
        "avatarUrl": None,
        "profileUrl": f"https://www.instagram.com/{route['handle']}/" if route.get("handle") else None,
        "verified": False,
    }
    stories: List[Dict[str, Any]] = []
    media: List[Dict[str, Any]] = []

    parsed = urlparse(target_url)
    path_parts = [p for p in parsed.path.split("/") if p]
    is_highlight = len(path_parts) >= 2 and path_parts[0] == "stories" and path_parts[1] == "highlights"
    highlight_id = path_parts[2] if is_highlight and len(path_parts) > 2 else None

    # Parse query params (e.g. ?story_media_id=3628878983900849427_16080427485)
    query_params = parse_qs(parsed.query)
    raw_sm_id = query_params.get("story_media_id", [None])[0]
    story_media_id = raw_sm_id.split("_")[0] if raw_sm_id else None

    # Decode Base64 mobile share highlights (/s/aGlnaGxpZ2h0...)
    if len(path_parts) >= 2 and path_parts[0] == "s":
        try:
            b64_str = path_parts[1].replace("-", "+").replace("_", "/")
            while len(b64_str) % 4 != 0:
                b64_str += "="
            decoded = base64.b64decode(b64_str).decode("utf-8", errors="ignore")
            m = re.search(r"highlight:(\d+)", decoded, re.I)
            if m:
                highlight_id = m.group(1)
                is_highlight = True
        except Exception:
            pass

    story_username = path_parts[1] if len(path_parts) >= 2 and path_parts[0] == "stories" and path_parts[1] != "highlights" else None
    story_id = (path_parts[2] if story_username and len(path_parts) > 2 else None) or story_media_id

    if story_username:
        creator["handle"] = story_username
        creator["name"] = story_username
        creator["profileUrl"] = f"https://www.instagram.com/{story_username}/"
        title = f"@{story_username}'s Story"
    elif highlight_id:
        title = "Instagram Highlight"

    # Engine 1: Instagram Public GraphQL Highlight Reel Query
    if highlight_id:
        try:
            gql_url = (
                "https://www.instagram.com/graphql/query/?query_hash=452461e2dc7e6744e242663777b9d502&variables="
                + requests.utils.quote(json.dumps({
                    "highlight_reel_ids": [highlight_id],
                    "reel_ids": [],
                    "location_ids": [],
                    "precomposed_overlay": False,
                }))
            )
            gql_resp = requests.get(
                gql_url,
                headers={
                    "User-Agent": INSTAGRAM_EMBED_UA,
                    "x-ig-app-id": "936619743392459",
                    "Accept": "application/json",
                },
                timeout=8,
            )
            if gql_resp.ok:
                data = gql_resp.json()
                reel = (
                    (data.get("data") or {}).get("user", {}).get("reel")
                    or ((data.get("data") or {}).get("reels_media") or [None])[0]
                    or (data.get("data") or {}).get("highlight_reel")
                )
                if reel:
                    u = reel.get("user") or {}
                    if u:
                        creator["handle"] = u.get("username") or creator["handle"]
                        creator["name"] = u.get("full_name") or creator["handle"]
                        creator["verified"] = bool(u.get("is_verified"))
                        if creator["handle"]:
                            creator["profileUrl"] = f"https://www.instagram.com/{creator['handle']}/"
                        if u.get("profile_pic_url"):
                            creator["avatarUrl"] = build_stream_url(u["profile_pic_url"], "avatar.jpg", True)
                    if reel.get("title"):
                        title = reel["title"]
                    cov = (reel.get("cover_media") or {}).get("cropped_image_version", {}).get("url")
                    if cov:
                        cover = build_stream_url(cov, "cover.jpg", True)

                    items = reel.get("items") or (reel.get("edge_highlight_reel_to_media") or {}).get("edges") or []
                    for idx, it in enumerate(items):
                        node = it.get("node") if isinstance(it, dict) and "node" in it else it
                        if not isinstance(node, dict):
                            continue
                        is_vid = bool(node.get("is_video") or node.get("video_versions") or node.get("video_resources"))
                        vids = node.get("video_resources") or node.get("video_versions") or []
                        raw_vid = vids[0].get("src") or vids[0].get("url") if vids else node.get("video_url")
                        raw_img = node.get("display_url") or ((node.get("image_versions2") or {}).get("candidates") or [{}])[0].get("url")

                        thumb = build_stream_url(raw_img, f"story-thumb-{idx+1}.jpg", True) if raw_img else cover
                        stream_u = build_stream_url(raw_vid, f"story-{idx+1}.mp4", True) if is_vid and raw_vid else (build_stream_url(raw_img, f"story-{idx+1}.jpg", True) if raw_img else "")
                        dl_u = build_stream_url(raw_vid, safe_filename(f"{title}-story-{idx+1}", "mp4"), False) if is_vid and raw_vid else (build_stream_url(raw_img, safe_filename(f"{title}-story-{idx+1}", "jpg"), False) if raw_img else "")

                        if stream_u:
                            stories.append({
                                "storyNumber": idx + 1,
                                "mediaIndex": idx,
                                "type": "video" if is_vid else "photo",
                                "duration": node.get("video_duration") or (15 if is_vid else None),
                                "thumbnail": thumb,
                                "createdAt": time.strftime("%Y-%m-%d", time.gmtime(node["taken_at_timestamp"])) if node.get("taken_at_timestamp") else time.strftime("%Y-%m-%d"),
                                "url": stream_u,
                                "downloadUrl": dl_u,
                            })
                            media.append({
                                "url": stream_u,
                                "rawUrl": raw_vid if is_vid else raw_img,
                                "downloadUrl": dl_u,
                                "thumbnail": thumb,
                                "type": "video" if is_vid else "image",
                                "quality": "Full HD · 1080p",
                                "format": "mp4" if is_vid else "jpg",
                                "width": 1080,
                                "height": 1920,
                                "aspectRatio": "vertical",
                                "hasAudio": is_vid,
                            })
        except Exception:
            pass

    # Engine 2: Public SSSInstagram / FastDL Converter Mirror Fallback
    if not stories:
        try:
            m_resp = requests.post(
                "https://sssinstagram.com/api/convert",
                json={"target_url": target_url},
                headers={
                    "User-Agent": DESKTOP_UA,
                    "X-Requested-With": "XMLHttpRequest",
                    "Referer": "https://sssinstagram.com/",
                },
                timeout=8,
            )
            if m_resp.ok:
                m_data = m_resp.json()
                html_c = m_data.get("data", {}).get("html") or m_data.get("html")
                if html_c and isinstance(html_c, str):
                    soup_m = BeautifulSoup(html_c, "html.parser")
                    links = soup_m.select("a.download-file, a[href*='cdninstagram.com'], a[href*='fbcdn.net']")
                    for idx, a_el in enumerate(links):
                        h = a_el.get("href")
                        if not h or not isinstance(h, str):
                            continue
                        is_vid = ".mp4" in h or "video" in h
                        ext = "mp4" if is_vid else "jpg"
                        stream_u = build_stream_url(h, f"story-{idx+1}.{ext}", True)
                        dl_u = build_stream_url(h, safe_filename(f"{title}-story-{idx+1}", ext), False)
                        stories.append({
                            "storyNumber": idx + 1,
                            "mediaIndex": idx,
                            "type": "video" if is_vid else "photo",
                            "duration": 15 if is_vid else None,
                            "thumbnail": stream_u,
                            "createdAt": time.strftime("%Y-%m-%d"),
                            "url": stream_u,
                            "downloadUrl": dl_u,
                        })
                        media.append({
                            "url": stream_u,
                            "rawUrl": h,
                            "downloadUrl": dl_u,
                            "thumbnail": stream_u,
                            "type": "video" if is_vid else "image",
                            "quality": "Full HD · 1080p",
                            "format": ext,
                            "width": 1080,
                            "height": 1920,
                            "aspectRatio": "vertical",
                            "hasAudio": is_vid,
                        })
        except Exception:
            pass

    # Engine 3: Instagram Direct Shortcode Embed Scraper & Public Embed Mirrors
    if not stories:
        candidate_urls = []
        if story_id:
            sc = id_to_shortcode(story_id)
            if sc:
                candidate_urls.append(f"https://www.instagram.com/p/{sc}/embed/captioned/")
        if story_media_id:
            sc = id_to_shortcode(story_media_id)
            if sc and not any(sc in u for u in candidate_urls):
                candidate_urls.append(f"https://www.instagram.com/p/{sc}/embed/captioned/")
        candidate_urls.extend([
            target_url,
            f"{target_url.rstrip('/')}/embed/captioned/",
            f"{target_url.rstrip('/')}/embed/"
        ])

        for cand in candidate_urls:
            if stories:
                break
            try:
                e_resp = requests.get(cand, headers={"User-Agent": INSTAGRAM_EMBED_UA}, timeout=8)
                if not e_resp.ok:
                    continue
                html = e_resp.text
                if '"LoginAndSignupPage"' in html:
                    continue
                soup = BeautifulSoup(html, "html.parser")
                og_t = soup.find("meta", property="og:title")
                og_i = soup.find("meta", property="og:image")
                og_v = soup.find("meta", property="og:video") or soup.find("meta", property="og:video:secure_url")

                if og_t and og_t.get("content"):
                    title = re.sub(r"\s*•\s*Instagram.*$", "", str(og_t["content"]), flags=re.I).strip()

                username_el = soup.find(class_="Username")
                if username_el:
                    uname = username_el.get_text(strip=True).split()[0]
                    uname = re.sub(r"Verified.*$", "", uname, flags=re.I)
                    if uname and not creator.get("handle"):
                        creator["handle"] = uname
                        creator["name"] = uname
                        creator["profileUrl"] = f"https://www.instagram.com/{uname}/"
                        if not title or title in ("Instagram Story", "Instagram Highlight"):
                            title = f"@{uname}'s Story"

                # 1. Direct .mp4 video stream scan
                direct_v = None
                mp4_idx = html.find(".mp4")
                if mp4_idx != -1:
                    start = html.rfind("https:", 0, mp4_idx)
                    end = html.find('"', mp4_idx)
                    if start != -1 and end != -1 and end > start:
                        raw = html[start:end]
                        try:
                            raw = json.loads(f'"{raw}"')
                        except Exception:
                            raw = raw.replace(r"\/", "/").replace(r"\u0026", "&").replace("\\", "")
                        if not is_generic_instagram_logo(raw):
                            direct_v = raw

                if not direct_v and og_v and og_v.get("content") and not is_generic_instagram_logo(str(og_v["content"])):
                    direct_v = str(og_v["content"])

                # 2. Direct high-res photo scan
                direct_i = None
                emb_img = soup.find("img", class_="EmbeddedMediaImage")
                if emb_img and emb_img.get("src") and not is_generic_instagram_logo(str(emb_img["src"])):
                    direct_i = str(emb_img["src"])
                elif og_i and og_i.get("content") and not is_generic_instagram_logo(str(og_i["content"])):
                    direct_i = str(og_i["content"])

                if direct_i and not cover:
                    cover = build_stream_url(direct_i, "cover.jpg", True)

                if direct_v and not is_generic_instagram_logo(direct_v):
                    stream_u = build_stream_url(direct_v, "story-1.mp4", True)
                    dl_u = build_stream_url(direct_v, safe_filename(f"{title}-story-1", "mp4"), False)
                    thumb_u = build_stream_url(direct_i, "thumb.jpg", True) if direct_i else cover
                    stories.append({
                        "storyNumber": 1,
                        "mediaIndex": 0,
                        "type": "video",
                        "duration": 15,
                        "thumbnail": thumb_u,
                        "createdAt": time.strftime("%Y-%m-%d"),
                        "url": stream_u,
                        "downloadUrl": dl_u,
                    })
                    media.append({
                        "url": stream_u,
                        "rawUrl": direct_v,
                        "downloadUrl": dl_u,
                        "thumbnail": thumb_u,
                        "type": "video",
                        "quality": "Full HD · 1080p",
                        "format": "mp4",
                        "width": 1080,
                        "height": 1920,
                        "aspectRatio": "vertical",
                        "hasAudio": True,
                    })
                    break
                elif direct_i and not is_generic_instagram_logo(direct_i):
                    stream_u = build_stream_url(direct_i, "story-1.jpg", True)
                    dl_u = build_stream_url(direct_i, safe_filename(f"{title}-story-1", "jpg"), False)
                    stories.append({
                        "storyNumber": 1,
                        "mediaIndex": 0,
                        "type": "photo",
                        "duration": None,
                        "thumbnail": stream_u,
                        "createdAt": time.strftime("%Y-%m-%d"),
                        "url": stream_u,
                        "downloadUrl": dl_u,
                    })
                    media.append({
                        "url": stream_u,
                        "rawUrl": direct_i,
                        "downloadUrl": dl_u,
                        "thumbnail": stream_u,
                        "type": "image",
                        "quality": "Original HD",
                        "format": "jpg",
                        "width": 1080,
                        "height": 1920,
                        "aspectRatio": "vertical",
                        "hasAudio": False,
                    })
                    break
            except Exception:
                pass

    # Engine 4: Public oEmbed API for Author & Title
    if not creator["handle"]:
        try:
            o_resp = requests.get(
                f"https://api.instagram.com/oembed/?url={target_url}",
                headers={"User-Agent": DESKTOP_UA},
                timeout=5,
            )
            if o_resp.ok:
                o_json = o_resp.json()
                if o_json.get("author_name"):
                    creator["handle"] = o_json["author_name"]
                    creator["name"] = o_json["author_name"]
                    creator["profileUrl"] = f"https://www.instagram.com/{o_json['author_name']}/"
                if o_json.get("title") and (not title or title == "Instagram Story"):
                    title = o_json["title"]
                if o_json.get("thumbnail_url") and not cover:
                    cover = build_stream_url(o_json["thumbnail_url"], "cover.jpg", True)
        except Exception:
            pass

    if not stories:
        return {
            "downloadId": download_id,
            "title": f"@{creator['handle']}'s Story" if creator.get("handle") else "Instagram Story",
            "cover": cover,
            "creator": creator,
            "stories": [],
            "truncated": False,
            "requiresDirectLinkAlert": False,
            "alertMessage": "This story or highlight is private, expired, or temporarily unavailable. Make sure the creator's account is public and active.",
        }

    RESULT_CACHE[download_id] = {
        "createdAt": time.time(),
        "media": media,
        "creator": creator,
        "title": title,
        "stories": stories,
    }

    return {
        "downloadId": download_id,
        "title": title or (f"@{creator['handle']}'s Stories" if creator.get("handle") else "Instagram Stories"),
        "cover": cover or (stories[0]["thumbnail"] if stories else None),
        "creator": creator,
        "stories": stories,
        "truncated": False,
        "requiresDirectLinkAlert": False,
    }


@app.post("/api/download")
def download_route(payload: DownloadRequest):
    if payload.assetType == "archive":
        items = payload.items or []
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for idx, item in enumerate(items):
                u = item.get("url")
                if not u:
                    continue
                try:
                    r = requests.get(u, headers={"User-Agent": DESKTOP_UA}, timeout=20)
                    if r.ok:
                        ext = "mp4" if item.get("type") == "video" else "jpg"
                        zf.writestr(item.get("filename") or f"slide-{idx+1}.{ext}", r.content)
                except Exception:
                    continue
        buf.seek(0)
        return Response(
            content=buf.getvalue(),
            media_type="application/zip",
            headers={"Content-Disposition": 'attachment; filename="omnidownloader-slides.zip"'},
        )

    cached = RESULT_CACHE.get(payload.downloadId) if payload.downloadId else None
    target_url = payload.url
    media_list = cached.get("media", []) if cached else []
    idx = payload.mediaIndex if payload.mediaIndex is not None else 0

    if not target_url and cached:
        if media_list and idx < len(media_list):
            target_url = media_list[idx].get("rawUrl") or media_list[idx].get("url")

    if not target_url:
        raise HTTPException(status_code=404, detail="Media URL not found.")

    if is_generic_instagram_logo(target_url):
        raise HTTPException(status_code=400, detail="Cannot download static logo assets. Story media is not directly downloadable.")

    is_yt = ("youtube.com" in target_url or "youtu.be" in target_url or (cached and cached.get("platform") == "youtube"))
    clean_name = safe_filename(payload.filename or "media", "mp4")

    if is_yt:
        yt_bin = "/bin/yt-dlp" if os.path.exists("/bin/yt-dlp") else (os.path.abspath("bin/yt-dlp") if os.path.exists("bin/yt-dlp") else "yt-dlp")
        src_url = (cached.get("sourceUrl") if cached else None) or target_url
        if payload.assetType == "audio" or payload.format == "mp3":
            tmp_audio = f"/tmp/omni-py-audio-{uuid.uuid4().hex}.mp3"
            cmd = [
                yt_bin,
                "-f", "bestaudio/best",
                "-x",
                "--audio-format", "mp3",
                "--audio-quality", "320k",
                "--ffmpeg-location", "/usr/bin/ffmpeg",
                "--extractor-args", "youtube:player_client=android,web",
                "--no-warnings",
                "-o", tmp_audio,
                src_url,
            ]
            subprocess.run(cmd, timeout=120)
            if os.path.exists(tmp_audio):
                fname = clean_name if clean_name.endswith(".mp3") else f"{clean_name.rsplit('.', 1)[0]}.mp3"
                return FileResponse(tmp_audio, media_type="audio/mpeg", filename=fname)
        else:
            media_item = media_list[idx] if media_list and idx < len(media_list) else None
            target_height = media_item.get("height") if media_item else None
            format_spec = (
                f"bestvideo[height<={target_height}]+bestaudio/best[ext=mp4]/best"
                if target_height
                else "bestvideo+bestaudio/best[ext=mp4]/best"
            )
            tmp_vid = f"/tmp/omni-py-vid-{uuid.uuid4().hex}.mp4"
            cmd = [
                yt_bin,
                "-f", format_spec,
                "--merge-output-format", "mp4",
                "--ffmpeg-location", "/usr/bin/ffmpeg",
                "--extractor-args", "youtube:player_client=android,web",
                "--no-warnings",
                "-o", tmp_vid,
                src_url,
            ]
            subprocess.run(cmd, timeout=180)
            if os.path.exists(tmp_vid):
                fname = clean_name if clean_name.endswith(".mp4") else f"{clean_name.rsplit('.', 1)[0]}.mp4"
                return FileResponse(tmp_vid, media_type="video/mp4", filename=fname)

    if payload.assetType == "audio" or payload.format == "mp3":
        tmp_audio = f"/tmp/omni-py-audio-{uuid.uuid4().hex}.mp3"
        try:
            subprocess.run(
                ["/usr/bin/ffmpeg", "-i", target_url, "-vn", "-acodec", "libmp3lame", "-b:a", "320k", "-y", tmp_audio],
                timeout=60,
                check=True,
            )
            if os.path.exists(tmp_audio):
                fname = clean_name if clean_name.endswith(".mp3") else f"{clean_name.rsplit('.', 1)[0]}.mp3"
                return FileResponse(tmp_audio, media_type="audio/mpeg", filename=fname)
        except Exception:
            pass

    r = requests.get(target_url, headers={"User-Agent": DESKTOP_UA}, timeout=25)
    if not r.ok:
        raise HTTPException(status_code=502, detail="Could not download media.")
    return Response(
        content=r.content,
        media_type=r.headers.get("Content-Type", "application/octet-stream"),
        headers={"Content-Disposition": f'attachment; filename="{clean_name}"'},
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 8000)))
