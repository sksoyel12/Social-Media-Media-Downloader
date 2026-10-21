import express, { type Request, type Response } from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { execFile, spawn } from "child_process";
import { Readable } from "stream";
import { promisify } from "util";
import { v4 as uuidv4 } from "uuid";
import * as cheerio from "cheerio";
import archiver from "archiver";
import type {
  DownloadCreator,
  DownloadMedia,
  DownloadResult,
  HighlightResult,
  HighlightStory,
  Platform,
} from "./src/types/api";

const PORT = Number(process.env.PORT) || 3000;
const isProd = process.env.NODE_ENV === "production";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

interface CachedItem {
  createdAt: number;
  sourceUrl: string;
  platform: Platform;
  media: DownloadMedia[];
  avatarUrl: string | null;
  audioUrl: string | null;
  title: string;
  creator: DownloadCreator;
  audioAvailable: boolean;
  isHighlight?: boolean;
  stories?: HighlightStory[];
}

const resultCache = new Map<string, CachedItem>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function pruneCache() {
  const now = Date.now();
  for (const [key, value] of resultCache.entries()) {
    if (now - value.createdAt > CACHE_TTL_MS) {
      resultCache.delete(key);
    }
  }
}

const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Crucial: Clean WebKit UA without Chrome/131 and without Accept: application/xhtml+xml
 * forces Instagram's /embed/ edge servers to return server-rendered contextJSON & DOM media
 * instead of the client-side React Polaris login shell.
 */
const INSTAGRAM_EMBED_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

const MOBILE_TIKTOK_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1";

const TRACKING_PARAMS = new Set([
  "cplk",
  "vrfl",
  "dlrf",
  "xtok",
  "exln",
  "rpxt",
  "img_index",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "igsh",
  "igshid",
  "fbclid",
  "_r",
  "_t",
  "is_from_webapp",
  "sender_device",
  "web_id",
  "checksum",
  "tt_from",
  "share_app_id",
  "share_link_id",
  "share_item_id",
]);

function safeFilename(name: string, ext: string): string {
  const base =
    (name || "omnidownloader-media")
      .trim()
      .replace(/[^\w\- ]+/g, "")
      .replace(/\s+/g, "-")
      .slice(0, 60) || "omnidownloader-media";
  const cleanExt = ext.replace(/^\./, "") || "mp4";
  return `${base}.${cleanExt}`;
}

function buildStreamUrl(rawUrl: string, filename?: string, inline = false): string {
  const params = new URLSearchParams();
  params.set("url", rawUrl);
  if (filename) params.set("filename", filename);
  if (inline) params.set("inline", "1");
  return `/api/stream?${params.toString()}`;
}

function computeAspectRatio(
  width: number | null,
  height: number | null,
  fallback: "vertical" | "horizontal" | "square" = "vertical"
): "vertical" | "horizontal" | "square" {
  if (!width || !height) return fallback;
  const ratio = width / height;
  if (ratio < 0.85) return "vertical";
  if (ratio > 1.15) return "horizontal";
  return "square";
}

function isGenericInstagramLogo(url: string | null | undefined): boolean {
  if (!url) return true;
  const lower = url.toLowerCase();
  return (
    lower.includes("instagram_logo") ||
    lower.includes("instagram-logo") ||
    lower.includes("4168x4168") ||
    lower.includes("static.cdninstagram.com") ||
    lower.includes("/rsrc.php/") ||
    lower.includes("/static/images/") ||
    lower.includes("brand_assets") ||
    lower.includes("favicon") ||
    lower.includes("instagram_icon") ||
    lower.includes("ig_icon") ||
    lower.includes("apple-touch-icon") ||
    lower.includes("logo") ||
    lower.includes("play-button") ||
    lower.includes("transparent.png") ||
    lower.includes("spacer.gif")
  );
}

function detectPlatform(url: string): Platform | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (
      host === "instagram.com" ||
      host.endsWith(".instagram.com") ||
      host === "instagr.am" ||
      host.endsWith(".instagr.am")
    ) {
      return "instagram";
    }
    if (host === "tiktok.com" || host.endsWith(".tiktok.com")) {
      return "tiktok";
    }
    if (
      host === "pinterest.com" ||
      host.endsWith(".pinterest.com") ||
      host.includes(".pinterest.") ||
      host === "pin.it" ||
      host.endsWith(".pin.it")
    ) {
      return "pinterest";
    }
    if (
      host === "youtube.com" ||
      host.endsWith(".youtube.com") ||
      host === "youtu.be" ||
      host.endsWith(".youtu.be")
    ) {
      return "youtube";
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Decodes Base64 Instagram Mobile Share Highlight links:
 * e.g. /s/aGlnaGxpZ2h0OjE4MTQ0NTMzNDEwMzc1OTIw?story_media_id=...
 * -> base64 decode -> "highlight:18144533410375920" -> /stories/highlights/18144533410375920/
 */
function decodeInstagramShareHighlight(urlStr: string): string {
  try {
    const parsed = new URL(urlStr);
    const match = parsed.pathname.match(/^\/s\/([A-Za-z0-9+/=_-]+)/);
    if (!match?.[1]) return urlStr;
    const token = match[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = token + "=".repeat((4 - (token.length % 4)) % 4);
    const decoded = Buffer.from(padded, "base64").toString("utf-8");
    if (decoded.startsWith("highlight:")) {
      const highlightId = decoded.split(":")[1]?.trim();
      if (highlightId && /^\d+$/.test(highlightId)) {
        const storyMediaId = parsed.searchParams.get("story_media_id");
        const query = storyMediaId ? `?story_media_id=${encodeURIComponent(storyMediaId)}` : "";
        return `https://www.instagram.com/stories/highlights/${highlightId}/${query}`;
      }
    }
  } catch {
    // ignore
  }
  return urlStr;
}

/**
 * Purges tracking parameters (?cplk=, ?vrfl=, ?dlrf=, ?xtok=, ?exln=, ?rpxt=, ?img_index=, ?utm_source=, etc.)
 */
function sanitizeTrackingParams(urlStr: string): string {
  try {
    const parsed = new URL(decodeInstagramShareHighlight(urlStr));
    const host = parsed.hostname.toLowerCase();
    const storyMediaId = parsed.searchParams.get("story_media_id");

    if (
      host.includes("tiktok.com") ||
      host.includes("instagram.com") ||
      host.includes("pinterest.")
    ) {
      parsed.search = "";
      parsed.hash = "";
      if (storyMediaId && parsed.pathname.includes("/stories/")) {
        parsed.searchParams.set("story_media_id", storyMediaId);
      }
      return parsed.toString();
    }

    if (host.includes("youtube.com") || host.includes("youtu.be")) {
      const v = parsed.searchParams.get("v");
      parsed.search = "";
      parsed.hash = "";
      if (v) {
        parsed.searchParams.set("v", v);
      }
      return parsed.toString();
    }

    for (const key of Array.from(parsed.searchParams.keys())) {
      if (TRACKING_PARAMS.has(key.toLowerCase()) || key.toLowerCase().startsWith("utm_")) {
        parsed.searchParams.delete(key);
      }
    }
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return urlStr;
  }
}

/**
 * Resolves vt.tiktok.com, vm.tiktok.com, pin.it, instagr.am, youtu.be, and /s/ highlight redirects
 * while guarding against TikTok geolocation traps (/in/about).
 */
async function resolveShortUrl(rawUrl: string): Promise<string> {
  let current = decodeInstagramShareHighlight(rawUrl.trim());
  const cookies: string[] = [];

  for (let hop = 0; hop < 8; hop++) {
    try {
      const parsed = new URL(current);
      const host = parsed.hostname.toLowerCase();

      if (host === "youtu.be" || host.endsWith(".youtu.be")) {
        const vidId = parsed.pathname.replace(/^\/+/, "").split("/")[0]?.split("?")[0];
        if (vidId) {
          current = `https://www.youtube.com/watch?v=${vidId}`;
          break;
        }
      }

      const isShortlink =
        host === "vt.tiktok.com" ||
        host === "vm.tiktok.com" ||
        host === "pin.it" ||
        host === "instagr.am" ||
        host === "youtu.be" ||
        host.endsWith(".youtu.be") ||
        parsed.pathname.startsWith("/t/") ||
        parsed.pathname.startsWith("/s/");

      if (!isShortlink) {
        break;
      }

      if (host.includes("instagram.com") && parsed.pathname.startsWith("/s/")) {
        const decoded = decodeInstagramShareHighlight(current);
        if (decoded !== current) {
          current = decoded;
          break;
        }
      }

      const headers: Record<string, string> = {
        "User-Agent": host.includes("tiktok") ? MOBILE_TIKTOK_UA : DESKTOP_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      };
      if (cookies.length > 0) {
        headers["Cookie"] = cookies.join("; ");
      }

      const response = await fetch(current, {
        method: "GET",
        redirect: "manual",
        headers,
        signal: AbortSignal.timeout(8000),
      });

      const setCookie = response.headers.get("set-cookie");
      if (setCookie) {
        const firstPart = setCookie.split(";")[0];
        if (firstPart) cookies.push(firstPart);
      }

      const location = response.headers.get("location");
      if (location && [301, 302, 303, 307, 308].includes(response.status)) {
        let nextUrl = new URL(location, current).toString();
        try {
          if (response.body) await response.body.cancel();
        } catch {
          // ignore
        }
        const nextParsed = new URL(nextUrl);
        // Guard against Instagram /accounts/login?next=... redirect wall
        if (nextParsed.pathname.includes("/accounts/login")) {
          const nextParam = nextParsed.searchParams.get("next");
          if (nextParam) {
            current = new URL(nextParam, "https://www.instagram.com").toString();
          }
          break;
        }
        // Guard against TikTok geolocation /in/about redirect trap
        if (
          nextParsed.hostname.includes("tiktok.com") &&
          (nextParsed.pathname.includes("/about") || nextParsed.pathname === "/")
        ) {
          break;
        }
        current = decodeInstagramShareHighlight(nextUrl);
        continue;
      }

      if (isShortlink && response.status === 200) {
        const html = await response.text();
        const canonicalMatch =
          html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i) ||
          html.match(/href=["'](https?:\/\/(?:www\.|m\.)?tiktok\.com\/@(?:[^"']+)\/(?:video|photo|story)\/\d+[^"']*)["']/i);
        if (canonicalMatch?.[1]) {
          current = canonicalMatch[1].replace(/&amp;/g, "&");
          break;
        }
      } else {
        try {
          if (response.body) await response.body.cancel();
        } catch {
          // ignore
        }
      }
      break;
    } catch {
      break;
    }
  }

  return sanitizeTrackingParams(current);
}

function isProfileUrl(url: string, platform: Platform): { isProfile: boolean; handle: string | null } {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);

    if (platform === "instagram") {
      const reserved = new Set([
        "p",
        "reel",
        "reels",
        "tv",
        "stories",
        "s",
        "explore",
        "accounts",
        "direct",
        "about",
        "legal",
        "developer",
        "share",
      ]);
      if (parts.length === 1 && !reserved.has(parts[0].toLowerCase())) {
        return { isProfile: true, handle: parts[0].replace(/^@/, "") };
      }
      return { isProfile: false, handle: null };
    }

    if (platform === "tiktok") {
      if (parts.length === 1 && parts[0].startsWith("@")) {
        return { isProfile: true, handle: parts[0].replace(/^@/, "") };
      }
      return { isProfile: false, handle: null };
    }

    if (platform === "pinterest") {
      if (
        parts.length === 1 &&
        parts[0].toLowerCase() !== "pin" &&
        parts[0].toLowerCase() !== "search" &&
        parts[0].toLowerCase() !== "ideas"
      ) {
        return { isProfile: true, handle: parts[0].replace(/^@/, "") };
      }
      return { isProfile: false, handle: null };
    }

    if (platform === "youtube") {
      if (parts[0]?.startsWith("@")) {
        return { isProfile: true, handle: parts[0].replace(/^@/, "") };
      }
      if ((parts[0] === "channel" || parts[0] === "c" || parts[0] === "user") && parts[1]) {
        return { isProfile: true, handle: parts[1] };
      }
      return { isProfile: false, handle: null };
    }
  } catch {
    return { isProfile: false, handle: null };
  }
  return { isProfile: false, handle: null };
}

function extractHashtags(...texts: (string | null | undefined)[]): string[] {
  const tags = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    const matches = text.match(/(?<!\w)#[\w\u0080-\uffff]+/gi);
    if (matches) {
      for (const m of matches) {
        tags.add(m);
      }
    }
  }
  return Array.from(tags);
}

function normalizePinterestUrl(url: string): string {
  if (url.includes("pinimg.com")) {
    return url.replace(/\/(?:\d{2,4}x(?:\d{2,4})?|[0-9]+x[0-9]+)\//, "/originals/");
  }
  return url;
}

function decodeEscapedUrl(raw: string): string {
  return raw
    .replace(/\\u0026/g, "&")
    .replace(/\\u002F/g, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&");
}

function parseBestSrcsetUrl(srcset: string | undefined): string | null {
  if (!srcset) return null;
  let bestUrl: string | null = null;
  let bestWidth = -1;
  for (const part of srcset.split(",")) {
    const tokens = part.trim().split(/\s+/);
    if (!tokens[0]) continue;
    const candidate = decodeEscapedUrl(tokens[0]);
    const wMatch = tokens[1]?.match(/^(\d+)w$/i);
    const width = wMatch ? Number(wMatch[1]) : 0;
    if (width >= bestWidth) {
      bestWidth = width;
      bestUrl = candidate;
    }
  }
  return bestUrl;
}

/**
 * Safely extracts and parses Instagram's double-escaped `"contextJSON":"{\"context\":...}"`
 * without truncating at the first inner escaped quote.
 */
function parseInstagramContextJson(html: string): any | null {
  const match = html.match(/"contextJSON"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (!match?.[1]) return null;
  try {
    const unescaped = JSON.parse(`"${match[1]}"`);
    return JSON.parse(unescaped);
  } catch {
    return null;
  }
}

interface PlatformExtractResult {
  title: string;
  caption: string;
  thumbnail: string | null;
  uploadDate: string | null;
  boardName?: string | null;
  audioUrl: string | null;
  audioAvailable: boolean;
  isCarousel: boolean;
  creator: DownloadCreator;
  media: DownloadMedia[];
}

// ============================================================================
// TIKTOK EXTRACTOR (Shortlinks, Photo Slideshows, HD Video & Profile DP)
// ============================================================================

async function extractTikTok(
  targetUrl: string,
  isProfile: boolean,
  profileHandle: string | null
): Promise<PlatformExtractResult> {
  let title = "";
  let caption = "";
  let thumbnail: string | null = null;
  let uploadDate: string | null = null;
  let audioUrl: string | null = null;
  let audioAvailable = false;
  let isCarousel = false;
  const creator: DownloadCreator = {
    handle: profileHandle,
    name: null,
    avatarUrl: null,
    profileUrl: profileHandle ? `https://www.tiktok.com/@${profileHandle}` : null,
    verified: false,
  };
  const media: DownloadMedia[] = [];

  if (isProfile) {
    const handle =
      profileHandle ||
      targetUrl.split("/@")[1]?.split(/[/?#]/)[0]?.replace(/^@/, "") ||
      "";

    if (handle) {
      try {
        const apiRes = await fetch(
          `https://www.tikwm.com/api/user/info?unique_id=${encodeURIComponent(handle)}`,
          {
            headers: {
              "User-Agent": DESKTOP_UA,
              Accept: "application/json",
            },
            signal: AbortSignal.timeout(8000),
          }
        );
        if (apiRes.ok) {
          const payload = await apiRes.json();
          const user = payload?.data?.user;
          if (user) {
            const hdAvatar = user.avatarLarger || user.avatarMedium || user.avatarThumb;
            creator.handle = user.uniqueId || handle;
            creator.name = user.nickname || handle;
            creator.verified = Boolean(user.verified);
            creator.profileUrl = `https://www.tiktok.com/@${creator.handle}`;
            if (hdAvatar) {
              creator.avatarUrl = buildStreamUrl(hdAvatar, `${creator.handle}-avatar.jpg`, true);
              thumbnail = creator.avatarUrl;
              caption = user.signature || "";
              title = `${creator.name} (@${creator.handle})`;
              media.push({
                url: creator.avatarUrl,
                rawUrl: hdAvatar,
                downloadUrl: buildStreamUrl(hdAvatar, `${creator.handle}-profile-photo.jpg`, false),
                thumbnail: creator.avatarUrl,
                type: "profile",
                quality: "Original HD · 1080×1080",
                format: "jpg",
                width: 1080,
                height: 1080,
                aspectRatio: "square",
                hasAudio: false,
              });
            }
          }
        }
      } catch {
        // Fallback to HTML hydration below
      }
    }

    if (media.length === 0) {
      try {
        const pageRes = await fetch(targetUrl, {
          headers: { "User-Agent": DESKTOP_UA },
          signal: AbortSignal.timeout(8000),
        });
        if (pageRes.ok) {
          const html = await pageRes.text();
          const $ = cheerio.load(html);
          const hydrationScript = $("#__UNIVERSAL_DATA_FOR_REHYDRATION__").html();
          if (hydrationScript) {
            const json = JSON.parse(hydrationScript);
            const userInfo =
              json?.["__DEFAULT_SCOPE__"]?.["webapp.user-detail"]?.userInfo?.user;
            if (userInfo) {
              const hdAvatar =
                userInfo.avatarLarger || userInfo.avatarMedium || userInfo.avatarThumb;
              creator.handle = userInfo.uniqueId || handle;
              creator.name = userInfo.nickname || handle;
              creator.verified = Boolean(userInfo.verified);
              if (hdAvatar) {
                creator.avatarUrl = buildStreamUrl(hdAvatar, `${creator.handle}-avatar.jpg`, true);
                thumbnail = creator.avatarUrl;
                caption = userInfo.signature || "";
                title = `${creator.name} (@${creator.handle})`;
                media.push({
                  url: creator.avatarUrl,
                  rawUrl: hdAvatar,
                  downloadUrl: buildStreamUrl(hdAvatar, `${creator.handle}-profile-photo.jpg`, false),
                  thumbnail: creator.avatarUrl,
                  type: "profile",
                  quality: "Original HD · 1080×1080",
                  format: "jpg",
                  width: 1080,
                  height: 1080,
                  aspectRatio: "square",
                  hasAudio: false,
                });
              }
            }
          }
        }
      } catch {
        // ignore
      }
    }

    return {
      title: title || `@${handle || "tiktok"}`,
      caption,
      thumbnail,
      uploadDate,
      audioUrl,
      audioAvailable,
      isCarousel: false,
      creator,
      media,
    };
  }

  // Strategy A: TikWM Direct Scraper API (supports vt.tiktok.com, /story/, photo slideshows, and HD video)
  const isStory = /\/story\//i.test(targetUrl);
  try {
    let tikwmData: any = null;

    // A1: Try GET with query param https://www.tikwm.com/api/?url={unshortened_url}
    try {
      const getRes = await fetch(
        `https://www.tikwm.com/api/?url=${encodeURIComponent(targetUrl)}&hd=1`,
        {
          headers: {
            "User-Agent": MOBILE_TIKTOK_UA,
            Accept: "application/json, text/javascript, */*; q=0.01",
          },
          signal: AbortSignal.timeout(8000),
        }
      );
      if (getRes.ok) {
        const json = await getRes.json();
        if (json?.data && (json.data.play || json.data.hdplay || (Array.isArray(json.data.images) && json.data.images.length > 0))) {
          tikwmData = json.data;
        }
      }
    } catch {
      // Fallback to POST below
    }

    // A2: Try POST fallback
    if (!tikwmData) {
      const formBody = new URLSearchParams();
      formBody.set("url", targetUrl);
      formBody.set("hd", "1");

      const tikwmRes = await fetch("https://www.tikwm.com/api/", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "User-Agent": DESKTOP_UA,
          Accept: "application/json, text/javascript, */*; q=0.01",
          Origin: "https://www.tikwm.com",
          Referer: "https://www.tikwm.com/",
        },
        body: formBody.toString(),
        signal: AbortSignal.timeout(10000),
      });

      if (tikwmRes.ok) {
        const payload = await tikwmRes.json();
        if (payload?.data && (payload.data.play || payload.data.hdplay || (Array.isArray(payload.data.images) && payload.data.images.length > 0))) {
          tikwmData = payload.data;
        }
      }
    }

    if (tikwmData) {
      const d = tikwmData;
      title = d.title || (isStory ? "TikTok Story" : "TikTok Post");
      caption = d.title || "";
      if (d.create_time) {
        uploadDate = new Date(d.create_time * 1000).toISOString().split("T")[0];
      }

        if (d.author) {
          creator.handle = d.author.unique_id || null;
          creator.name = d.author.nickname || d.author.unique_id || null;
          if (creator.handle) {
            creator.profileUrl = `https://www.tiktok.com/@${creator.handle}`;
          }
          if (d.author.avatar) {
            const rawAvatar = d.author.avatar.startsWith("http")
              ? d.author.avatar
              : `https://www.tikwm.com${d.author.avatar}`;
            creator.avatarUrl = buildStreamUrl(rawAvatar, `${creator.handle || "creator"}-avatar.jpg`, true);
          }
        }

        const rawCover = d.origin_cover || d.cover;
        if (rawCover) {
          const fullCover = rawCover.startsWith("http")
            ? rawCover
            : `https://www.tikwm.com${rawCover}`;
          thumbnail = buildStreamUrl(fullCover, "thumbnail.jpg", true);
        }

        const rawMusic = d.music || d.music_info?.play;
        if (rawMusic && typeof rawMusic === "string") {
          const fullMusic = rawMusic.startsWith("http")
            ? rawMusic
            : `https://www.tikwm.com${rawMusic}`;
          audioUrl = fullMusic;
          audioAvailable = true;
        }

        // Photo Slideshow vs Video Post
        if (Array.isArray(d.images) && d.images.length > 0) {
          isCarousel = d.images.length > 1;
          d.images.forEach((imgUrl: string, idx: number) => {
            if (!imgUrl) return;
            const proxiedPreview = buildStreamUrl(imgUrl, `slide-${idx + 1}.jpg`, true);
            const proxiedDownload = buildStreamUrl(
              imgUrl,
              safeFilename(`${title}-slide-${idx + 1}`, "jpg"),
              false
            );
            media.push({
              url: proxiedPreview,
              rawUrl: imgUrl,
              downloadUrl: proxiedDownload,
              thumbnail: proxiedPreview,
              type: "image",
              quality: `Slide ${idx + 1} · Full HD`,
              format: "jpg",
              width: 1080,
              height: 1440,
              aspectRatio: "vertical",
              hasAudio: false,
            });
          });
          if (!thumbnail && media[0]) {
            thumbnail = media[0].url;
          }
        } else {
          // Single Video post with selectable quality streams (NOT a carousel)
          isCarousel = false;
          const hdUrl = d.hdplay
            ? d.hdplay.startsWith("http")
              ? d.hdplay
              : `https://www.tikwm.com${d.hdplay}`
            : null;
          const sdUrl = d.play
            ? d.play.startsWith("http")
              ? d.play
              : `https://www.tikwm.com${d.play}`
            : null;

          const width = d.width || 1080;
          const height = d.height || 1920;
          const aspectRatio = computeAspectRatio(width, height, "vertical");

          if (hdUrl) {
            media.push({
              url: buildStreamUrl(hdUrl, safeFilename(title, "mp4"), true),
              rawUrl: hdUrl,
              downloadUrl: buildStreamUrl(hdUrl, safeFilename(`${title}-1080p`, "mp4"), false),
              thumbnail,
              type: "video",
              quality: "Full HD · 1080p",
              format: "mp4",
              width,
              height,
              aspectRatio,
              hasAudio: true,
            });
            audioAvailable = true;
          }

          if (sdUrl && sdUrl !== hdUrl) {
            media.push({
              url: buildStreamUrl(sdUrl, safeFilename(title, "mp4"), true),
              rawUrl: sdUrl,
              downloadUrl: buildStreamUrl(sdUrl, safeFilename(`${title}-720p`, "mp4"), false),
              thumbnail,
              type: "video",
              quality: hdUrl ? "HD · 720p" : "Full HD · 1080p",
              format: "mp4",
              width: hdUrl ? 720 : width,
              height: hdUrl ? 1280 : height,
              aspectRatio,
              hasAudio: true,
            });
            audioAvailable = true;
          }
        }
      }
    } catch {
    // Fallback to direct page hydration scraping below
  }

  // Strategy B: Direct TikTok HTML Hydration JSON (__UNIVERSAL_DATA_FOR_REHYDRATION__)
  if (media.length === 0) {
    try {
      const pageRes = await fetch(targetUrl, {
        headers: {
          "User-Agent": MOBILE_TIKTOK_UA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        signal: AbortSignal.timeout(9000),
      });

      if (pageRes.ok) {
        const html = await pageRes.text();
        const $ = cheerio.load(html);

        const hydrationText = $("#__UNIVERSAL_DATA_FOR_REHYDRATION__").html();
        if (hydrationText) {
          const parsed = JSON.parse(hydrationText);
          const scope = parsed?.["__DEFAULT_SCOPE__"] || {};
          const itemStruct =
            scope?.["webapp.video-detail"]?.itemInfo?.itemStruct ||
            scope?.["webapp.reflow.video.detail"]?.itemInfo?.itemStruct;

          if (itemStruct) {
            caption = itemStruct.desc || "";
            title = caption || "TikTok Post";
            if (itemStruct.createTime) {
              uploadDate = new Date(Number(itemStruct.createTime) * 1000)
                .toISOString()
                .split("T")[0];
            }

            if (itemStruct.author) {
              creator.handle = itemStruct.author.uniqueId || null;
              creator.name = itemStruct.author.nickname || null;
              creator.verified = Boolean(itemStruct.author.verified);
              if (creator.handle) {
                creator.profileUrl = `https://www.tiktok.com/@${creator.handle}`;
              }
              const av =
                itemStruct.author.avatarLarger ||
                itemStruct.author.avatarMedium ||
                itemStruct.author.avatarThumb;
              if (av) {
                creator.avatarUrl = buildStreamUrl(av, "avatar.jpg", true);
              }
            }

            if (itemStruct.music?.playUrl) {
              audioUrl = itemStruct.music.playUrl;
              audioAvailable = true;
            }

            if (itemStruct.imagePost?.images && Array.isArray(itemStruct.imagePost.images)) {
              isCarousel = itemStruct.imagePost.images.length > 1;
              itemStruct.imagePost.images.forEach((imgObj: any, idx: number) => {
                const rawImgUrl = imgObj?.imageURL?.urlList?.[0];
                if (!rawImgUrl) return;
                const proxiedPreview = buildStreamUrl(rawImgUrl, `slide-${idx + 1}.jpg`, true);
                media.push({
                  url: proxiedPreview,
                  rawUrl: rawImgUrl,
                  downloadUrl: buildStreamUrl(
                    rawImgUrl,
                    safeFilename(`${title}-slide-${idx + 1}`, "jpg"),
                    false
                  ),
                  thumbnail: proxiedPreview,
                  type: "image",
                  quality: `Slide ${idx + 1} · Original HD`,
                  format: "jpg",
                  width: imgObj?.imageWidth || 1080,
                  height: imgObj?.imageHeight || 1440,
                  aspectRatio: "vertical",
                  hasAudio: false,
                });
              });
              if (media[0]) thumbnail = media[0].url;
            } else if (itemStruct.video) {
              const v = itemStruct.video;
              const rawVideoUrl =
                v.playAddr ||
                v.downloadAddr ||
                v.bitrateInfo?.[0]?.PlayAddr?.UrlList?.[0];
              const rawCover = v.originCover || v.cover;
              if (rawCover) {
                thumbnail = buildStreamUrl(rawCover, "cover.jpg", true);
              }
              if (rawVideoUrl) {
                const w = v.width || 1080;
                const h = v.height || 1920;
                media.push({
                  url: buildStreamUrl(rawVideoUrl, safeFilename(title, "mp4"), true),
                  rawUrl: rawVideoUrl,
                  downloadUrl: buildStreamUrl(rawVideoUrl, safeFilename(title, "mp4"), false),
                  thumbnail,
                  type: "video",
                  quality: "Full HD · 1080p",
                  format: "mp4",
                  width: w,
                  height: h,
                  aspectRatio: computeAspectRatio(w, h, "vertical"),
                  hasAudio: true,
                });
                audioAvailable = true;
              }
            }
          }
        }
      }
    } catch {
      // Fallback to oEmbed below
    }
  }

  return {
    title: title || "TikTok Post",
    caption,
    thumbnail,
    uploadDate,
    audioUrl,
    audioAvailable,
    isCarousel,
    creator,
    media,
  };
}

// ============================================================================
// INSTAGRAM EXTRACTOR (Profile HD DP, Carousels, Reels & Single-Image Posts)
// ============================================================================

async function extractInstagram(
  targetUrl: string,
  isProfile: boolean,
  profileHandle: string | null
): Promise<PlatformExtractResult> {
  let title = "";
  let caption = "";
  let thumbnail: string | null = null;
  const uploadDate: string | null = null;
  let audioUrl: string | null = null;
  let audioAvailable = false;
  let isCarousel = false;
  const creator: DownloadCreator = {
    handle: profileHandle,
    name: null,
    avatarUrl: null,
    profileUrl: profileHandle ? `https://www.instagram.com/${profileHandle}/` : null,
    verified: false,
  };
  const media: DownloadMedia[] = [];

  // 1. Profile Photo (DP) Mode
  if (isProfile) {
    const handle =
      profileHandle ||
      new URL(targetUrl).pathname.split("/").filter(Boolean)[0]?.replace(/^@/, "") ||
      "";

    // Engine 1: Instagram /username/embed/ with INSTAGRAM_EMBED_UA & escaped contextJSON parser
    if (handle) {
      try {
        const embedRes = await fetch(`https://www.instagram.com/${encodeURIComponent(handle)}/embed/`, {
          headers: {
            "User-Agent": INSTAGRAM_EMBED_UA,
          },
          signal: AbortSignal.timeout(8000),
        });
        if (embedRes.ok) {
          const html = await embedRes.text();
          const parsedContext = parseInstagramContextJson(html);
          const ctx = parsedContext?.context;
          if (ctx) {
            const hdPic = ctx.profile_pic_url
              ? decodeEscapedUrl(ctx.profile_pic_url)
              : null;
            creator.handle = ctx.username || handle;
            creator.name = ctx.full_name || creator.handle;
            creator.verified = Boolean(ctx.is_verified || ctx.verified);
            creator.profileUrl = `https://www.instagram.com/${creator.handle}/`;
            title = `${creator.name} (@${creator.handle})`;

            const followers =
              typeof ctx.followers_count === "number"
                ? `${ctx.followers_count.toLocaleString()} followers`
                : null;
            const postsCount =
              typeof ctx.posts_count === "number"
                ? `${ctx.posts_count.toLocaleString()} public posts`
                : null;
            caption = [followers, postsCount].filter(Boolean).join(" · ");

            if (hdPic) {
              const proxiedAvatar = buildStreamUrl(hdPic, `${creator.handle}-profile-hd.jpg`, true);
              creator.avatarUrl = proxiedAvatar;
              thumbnail = proxiedAvatar;
              media.push({
                url: proxiedAvatar,
                rawUrl: hdPic,
                downloadUrl: buildStreamUrl(
                  hdPic,
                  `${creator.handle}-profile-photo-hd.jpg`,
                  false
                ),
                thumbnail: proxiedAvatar,
                type: "profile",
                quality: "Original HD · 1080×1080",
                format: "jpg",
                width: 1080,
                height: 1080,
                aspectRatio: "square",
                hasAudio: false,
              });
            }
          }

          // Fallback to DOM avatar in /embed/ if contextJSON was empty
          if (media.length === 0) {
            const $ = cheerio.load(html);
            const domAvatar = $(".Header .Avatar img, a.Avatar img").first().attr("src");
            if (domAvatar) {
              const rawAv = decodeEscapedUrl(domAvatar);
              const proxiedAvatar = buildStreamUrl(rawAv, `${handle}-profile-hd.jpg`, true);
              creator.handle = handle;
              creator.name = $(".UsernameText").first().text().trim() || handle;
              title = `${creator.name} (@${handle})`;
              creator.avatarUrl = proxiedAvatar;
              thumbnail = proxiedAvatar;
              media.push({
                url: proxiedAvatar,
                rawUrl: rawAv,
                downloadUrl: buildStreamUrl(rawAv, `${handle}-profile-photo-hd.jpg`, false),
                thumbnail: proxiedAvatar,
                type: "profile",
                quality: "Original HD · 1080×1080",
                format: "jpg",
                width: 1080,
                height: 1080,
                aspectRatio: "square",
                hasAudio: false,
              });
            }
          }
        }
      } catch {
        // Fallback to web_profile_info below
      }
    }

    // Engine 2: Instagram web_profile_info API fallback
    if (media.length === 0 && handle) {
      try {
        const igApiRes = await fetch(
          `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(handle)}`,
          {
            headers: {
              "User-Agent": DESKTOP_UA,
              "x-ig-app-id": "936619743392459",
              Accept: "application/json",
              Referer: `https://www.instagram.com/${handle}/`,
            },
            signal: AbortSignal.timeout(7000),
          }
        );
        if (igApiRes.ok) {
          const data = await igApiRes.json();
          const user = data?.data?.user;
          if (user) {
            const hdPic = user.profile_pic_url_hd || user.profile_pic_url;
            creator.handle = user.username || handle;
            creator.name = user.full_name || handle;
            creator.verified = Boolean(user.is_verified);
            creator.profileUrl = `https://www.instagram.com/${creator.handle}/`;
            caption = user.biography || "";
            title = `${creator.name} (@${creator.handle})`;
            if (hdPic) {
              const proxiedAvatar = buildStreamUrl(hdPic, `${creator.handle}-profile-hd.jpg`, true);
              creator.avatarUrl = proxiedAvatar;
              thumbnail = proxiedAvatar;
              media.push({
                url: proxiedAvatar,
                rawUrl: hdPic,
                downloadUrl: buildStreamUrl(hdPic, `${creator.handle}-profile-photo-hd.jpg`, false),
                thumbnail: proxiedAvatar,
                type: "profile",
                quality: "Original HD · 1080×1080",
                format: "jpg",
                width: 1080,
                height: 1080,
                aspectRatio: "square",
                hasAudio: false,
              });
            }
          }
        }
      } catch {
        // ignore
      }
    }

    return {
      title: title || `@${handle}`,
      caption,
      thumbnail,
      uploadDate,
      audioUrl,
      audioAvailable,
      isCarousel: false,
      creator,
      media,
    };
  }

  // 2. Instagram Post / Reel / Carousel Mode
  const shortcodeMatch = targetUrl.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
  const shortcode = shortcodeMatch?.[1] || null;
  const isReel = /\/reels?\//i.test(targetUrl);

  if (shortcode) {
    try {
      const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/captioned/`;
      const embedRes = await fetch(embedUrl, {
        headers: {
          "User-Agent": INSTAGRAM_EMBED_UA,
        },
        signal: AbortSignal.timeout(8500),
      });

      if (embedRes.ok) {
        const html = await embedRes.text();
        const $ = cheerio.load(html);

        const embedUsername =
          $(".HoverCardRoot a.UsernameText").first().text().trim() ||
          $(".Header .UsernameText").first().text().trim() ||
          $(".UsernameText").first().text().trim() ||
          $("a.eb_header_username").first().text().trim();
        if (embedUsername) {
          creator.handle = embedUsername.replace(/^@/, "");
          creator.name = creator.handle;
          creator.profileUrl = `https://www.instagram.com/${creator.handle}/`;
        }

        const embedAvatar = $(".Header .Avatar img, a.Avatar img, .eb_header_avatar img")
          .first()
          .attr("src");
        if (embedAvatar) {
          creator.avatarUrl = buildStreamUrl(
            decodeEscapedUrl(embedAvatar),
            `${creator.handle || "ig"}-avatar.jpg`,
            true
          );
        }

        const embedCaption = $(".Caption").first().clone();
        embedCaption.find(".CaptionUsername, .CaptionComments").remove();
        const captionText = embedCaption.text().trim();
        if (captionText) {
          caption = captionText;
          title = captionText.split("\n")[0].slice(0, 95);
        }

        const parsedContext = parseInstagramContextJson(html);
        let mediaData: any = parsedContext?.gql_data?.shortcode_media || null;

        if (!mediaData) {
          const contextMatch = html.match(/window\.__additionalDataLoaded\([^,]+,\s*(\{.+?\})\s*\);/s);
          if (contextMatch?.[1]) {
            try {
              const parsed = JSON.parse(contextMatch[1]);
              mediaData = parsed?.shortcode_media || parsed?.graphql?.shortcode_media;
            } catch {
              // ignore
            }
          }
        }

        if (mediaData) {
          if (mediaData.owner) {
            creator.handle = mediaData.owner.username || creator.handle;
            creator.name = mediaData.owner.full_name || creator.handle;
            creator.verified = Boolean(mediaData.owner.is_verified);
            if (creator.handle) {
              creator.profileUrl = `https://www.instagram.com/${creator.handle}/`;
            }
            if (mediaData.owner.profile_pic_url) {
              creator.avatarUrl = buildStreamUrl(
                decodeEscapedUrl(mediaData.owner.profile_pic_url),
                `${creator.handle || "ig"}-avatar.jpg`,
                true
              );
            }
          }

          const edgeCaption = mediaData.edge_media_to_caption?.edges?.[0]?.node?.text;
          if (edgeCaption) {
            caption = edgeCaption;
            title = edgeCaption.split("\n")[0].slice(0, 100) || "Instagram Post";
          }

          const sidecarEdges = mediaData.edge_sidecar_to_children?.edges;
          if (Array.isArray(sidecarEdges) && sidecarEdges.length > 0) {
            isCarousel = sidecarEdges.length > 1;
            sidecarEdges.forEach((edge: any, idx: number) => {
              const node = edge?.node;
              if (!node) return;
              const w = node.dimensions?.width || 1080;
              const h = node.dimensions?.height || 1080;
              const aspectRatio = computeAspectRatio(w, h, "square");
              const slideDisplayUrl = node.display_url
                ? decodeEscapedUrl(node.display_url)
                : null;
              const slideThumb = slideDisplayUrl
                ? buildStreamUrl(slideDisplayUrl, `thumb-${idx + 1}.jpg`, true)
                : null;

              if (node.is_video && node.video_url) {
                const rawVid = decodeEscapedUrl(node.video_url);
                media.push({
                  url: buildStreamUrl(rawVid, `slide-${idx + 1}.mp4`, true),
                  rawUrl: rawVid,
                  downloadUrl: buildStreamUrl(
                    rawVid,
                    safeFilename(`${title || "instagram"}-slide-${idx + 1}`, "mp4"),
                    false
                  ),
                  thumbnail: slideThumb,
                  type: "video",
                  quality: `Slide ${idx + 1} · 1080p Video`,
                  format: "mp4",
                  width: w,
                  height: h,
                  aspectRatio,
                  hasAudio: true,
                });
                audioAvailable = true;
                if (!audioUrl) audioUrl = rawVid;
              } else if (slideDisplayUrl) {
                media.push({
                  url: slideThumb!,
                  rawUrl: slideDisplayUrl,
                  downloadUrl: buildStreamUrl(
                    slideDisplayUrl,
                    safeFilename(`${title || "instagram"}-slide-${idx + 1}`, "jpg"),
                    false
                  ),
                  thumbnail: slideThumb,
                  type: "image",
                  quality: `Slide ${idx + 1} · Original HD`,
                  format: "jpg",
                  width: w,
                  height: h,
                  aspectRatio,
                  hasAudio: false,
                });
              }
            });
          } else if (mediaData.is_video && mediaData.video_url) {
            const rawVid = decodeEscapedUrl(mediaData.video_url);
            const rawThumb = mediaData.display_url
              ? decodeEscapedUrl(mediaData.display_url)
              : null;
            const w = mediaData.dimensions?.width || 1080;
            const h = mediaData.dimensions?.height || 1920;
            thumbnail = rawThumb ? buildStreamUrl(rawThumb, "thumb.jpg", true) : null;
            media.push({
              url: buildStreamUrl(rawVid, safeFilename(title || "instagram-video", "mp4"), true),
              rawUrl: rawVid,
              downloadUrl: buildStreamUrl(
                rawVid,
                safeFilename(title || "instagram-video", "mp4"),
                false
              ),
              thumbnail,
              type: "video",
              quality: "Full HD · 1080p",
              format: "mp4",
              width: w,
              height: h,
              aspectRatio: computeAspectRatio(w, h, isReel ? "vertical" : "square"),
              hasAudio: true,
            });
            audioAvailable = true;
            audioUrl = rawVid;
          } else if (mediaData.display_url && !isGenericInstagramLogo(mediaData.display_url)) {
            const rawImg = decodeEscapedUrl(mediaData.display_url);
            const w = mediaData.dimensions?.width || 1080;
            const h = mediaData.dimensions?.height || 1080;
            const proxiedImg = buildStreamUrl(rawImg, "image.jpg", true);
            thumbnail = proxiedImg;
            media.push({
              url: proxiedImg,
              rawUrl: rawImg,
              downloadUrl: buildStreamUrl(
                rawImg,
                safeFilename(title || "instagram-image", "jpg"),
                false
              ),
              thumbnail: proxiedImg,
              type: "image",
              quality: "Original HD · 1080p",
              format: "jpg",
              width: w,
              height: h,
              aspectRatio: computeAspectRatio(w, h, "square"),
              hasAudio: false,
            });
          }
        }

        // Single-Image Post DOM Fallback (when contextJSON is null on GraphImage embeds)
        if (media.length === 0) {
          const embeddedImgEl = $("img.EmbeddedMediaImage").first();
          const bestSrcset = parseBestSrcsetUrl(embeddedImgEl.attr("srcset"));
          const fallbackSrc = embeddedImgEl.attr("src")
            ? decodeEscapedUrl(embeddedImgEl.attr("src")!)
            : null;
          const rawImg = bestSrcset || fallbackSrc;

          if (rawImg && !isGenericInstagramLogo(rawImg)) {
            const proxiedImg = buildStreamUrl(rawImg, "image.jpg", true);
            thumbnail = proxiedImg;
            media.push({
              url: proxiedImg,
              rawUrl: rawImg,
              downloadUrl: buildStreamUrl(
                rawImg,
                safeFilename(title || "instagram-post", "jpg"),
                false
              ),
              thumbnail: proxiedImg,
              type: "image",
              quality: "Original HD · 1080p",
              format: "jpg",
              width: 1080,
              height: 1080,
              aspectRatio: "square",
              hasAudio: false,
            });
          }
        }
      }
    } catch {
      // Fallback below
    }
  }

  return {
    title: title || "Instagram Post",
    caption,
    thumbnail: thumbnail || media[0]?.thumbnail || media[0]?.url || null,
    uploadDate,
    audioUrl,
    audioAvailable,
    isCarousel,
    creator,
    media,
  };
}

// ============================================================================
// PINTEREST EXTRACTOR
// ============================================================================

async function extractPinterest(
  targetUrl: string,
  isProfile: boolean,
  profileHandle: string | null
): Promise<PlatformExtractResult> {
  let title = "";
  let caption = "";
  let thumbnail: string | null = null;
  const uploadDate: string | null = null;
  const boardName: string | null = null;
  let audioUrl: string | null = null;
  let audioAvailable = false;
  const creator: DownloadCreator = {
    handle: profileHandle,
    name: null,
    avatarUrl: null,
    profileUrl: profileHandle ? `https://www.pinterest.com/${profileHandle}/` : null,
    verified: false,
  };
  const media: DownloadMedia[] = [];

  try {
    const oembedRes = await fetch(
      `https://www.pinterest.com/oembed.json?url=${encodeURIComponent(targetUrl)}`,
      { headers: { "User-Agent": DESKTOP_UA }, signal: AbortSignal.timeout(6000) }
    );
    if (oembedRes.ok) {
      const oembed = await oembedRes.json();
      title = oembed.title || "";
      caption = oembed.title || "";
      creator.name = oembed.author_name || null;
      creator.profileUrl = oembed.author_url || null;
      if (oembed.thumbnail_url) {
        const orig = normalizePinterestUrl(oembed.thumbnail_url);
        thumbnail = orig;
      }
    }
  } catch {
    // continue
  }

  try {
    const pageRes = await fetch(targetUrl, {
      headers: { "User-Agent": DESKTOP_UA },
      signal: AbortSignal.timeout(8000),
    });
    if (pageRes.ok) {
      const html = await pageRes.text();
      const $ = cheerio.load(html);

      const ogTitle = $('meta[property="og:title"]').attr("content");
      const ogDesc = $('meta[property="og:description"]').attr("content");
      const ogImage = $('meta[property="og:image"]').attr("content");
      const ogVideo =
        $('meta[property="og:video"]').attr("content") ||
        $('meta[property="og:video:url"]').attr("content") ||
        html.match(/"(https:\/\/v1\.pinimg\.com\/videos\/[^"]+\.mp4)"/)?.[1];

      if (!title && ogTitle) title = ogTitle;
      if (!caption && ogDesc) caption = ogDesc;

      if (isProfile && ogImage) {
        const orig = normalizePinterestUrl(ogImage);
        creator.avatarUrl = orig;
        thumbnail = orig;
        media.push({
          url: orig,
          rawUrl: orig,
          downloadUrl: buildStreamUrl(orig, safeFilename(title || "pinterest-profile", "jpg"), false),
          thumbnail: orig,
          type: "profile",
          quality: "Original HD · 1080×1080",
          format: "jpg",
          width: 1080,
          height: 1080,
          aspectRatio: "square",
          hasAudio: false,
        });
      } else {
        if (ogVideo) {
          const origThumb = ogImage ? normalizePinterestUrl(ogImage) : thumbnail;
          thumbnail = origThumb;
          media.push({
            url: buildStreamUrl(ogVideo, safeFilename(title || "pinterest-video", "mp4"), true),
            rawUrl: ogVideo,
            downloadUrl: buildStreamUrl(
              ogVideo,
              safeFilename(title || "pinterest-video", "mp4"),
              false
            ),
            thumbnail: origThumb,
            type: "video",
            quality: "Full HD Video",
            format: "mp4",
            width: 1080,
            height: 1920,
            aspectRatio: "vertical",
            hasAudio: true,
          });
          audioAvailable = true;
          audioUrl = ogVideo;
        }

        if (ogImage) {
          const origImg = normalizePinterestUrl(ogImage);
          if (!thumbnail) thumbnail = origImg;
          media.push({
            url: origImg,
            rawUrl: origImg,
            downloadUrl: buildStreamUrl(
              origImg,
              safeFilename(title || "pinterest-pin", "jpg"),
              false
            ),
            thumbnail: origImg,
            type: "image",
            quality: "Original Master HD",
            format: "jpg",
            width: 1200,
            height: 1800,
            aspectRatio: "vertical",
            hasAudio: false,
          });
        }
      }
    }
  } catch {
    // ignore
  }

  if (media.length === 0 && thumbnail) {
    media.push({
      url: thumbnail,
      rawUrl: thumbnail,
      downloadUrl: buildStreamUrl(thumbnail, safeFilename(title || "pinterest-pin", "jpg"), false),
      thumbnail,
      type: isProfile ? "profile" : "image",
      quality: "Original Master HD",
      format: "jpg",
      width: 1080,
      height: 1080,
      aspectRatio: "square",
      hasAudio: false,
    });
  }

  return {
    title: title || "Pinterest Pin",
    caption,
    thumbnail,
    uploadDate,
    boardName,
    audioUrl,
    audioAvailable,
    isCarousel: false,
    creator,
    media,
  };
}

// ============================================================================
// YOUTUBE EXTRACTOR (Videos, Shorts, 4K/1440p/1080p/720p/480p, MP3 Audio & Channel DP)
// ============================================================================

const execFileAsync = promisify(execFile);

async function extractYouTube(
  targetUrl: string,
  isProfile: boolean,
  profileHandle: string | null
): Promise<PlatformExtractResult> {
  let title = "";
  let caption = "";
  let thumbnail: string | null = null;
  let uploadDate: string | null = null;
  let audioUrl: string | null = null;
  let audioAvailable = false;
  const isCarousel = false;
  const creator: DownloadCreator = {
    handle: profileHandle,
    name: null,
    avatarUrl: null,
    profileUrl: profileHandle ? `https://www.youtube.com/@${profileHandle}` : null,
    verified: false,
  };
  const media: DownloadMedia[] = [];

  // 1. Channel / Profile Picture Mode (DP)
  if (isProfile) {
    const handle =
      profileHandle ||
      targetUrl.split("/@")[1]?.split(/[/?#]/)[0]?.replace(/^@/, "") ||
      "";

    try {
      const channelRes = await fetch(targetUrl, {
        headers: {
          "User-Agent": DESKTOP_UA,
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: AbortSignal.timeout(8000),
      });

      if (channelRes.ok) {
        const html = await channelRes.text();
        const ogTitleMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
        const ogImgMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
        const ogDescMatch = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
        const avatarMatch = html.match(/"avatar":\s*\{\s*"thumbnails":\s*\[(.*?)\]/s);

        let rawAvatar = ogImgMatch?.[1] || null;
        if (avatarMatch?.[1]) {
          try {
            const thumbs = JSON.parse(`[${avatarMatch[1]}]`);
            if (thumbs?.length) {
              rawAvatar = thumbs[thumbs.length - 1]?.url || rawAvatar;
            }
          } catch {
            // ignore
          }
        }

        if (rawAvatar) {
          const hdAvatar = rawAvatar.replace(/=s\d+/, "=s1080");
          creator.name = ogTitleMatch?.[1] || handle || "YouTube Creator";
          creator.handle = handle || null;
          creator.profileUrl = targetUrl;
          title = `${creator.name} (${creator.handle ? `@${creator.handle}` : "Channel"})`;
          caption = ogDescMatch?.[1] || "";

          const proxiedAvatar = buildStreamUrl(hdAvatar, `${handle || "creator"}-avatar-hd.jpg`, true);
          creator.avatarUrl = proxiedAvatar;
          thumbnail = proxiedAvatar;

          media.push({
            url: proxiedAvatar,
            rawUrl: hdAvatar,
            downloadUrl: buildStreamUrl(hdAvatar, `${handle || "creator"}-profile-photo-hd.jpg`, false),
            thumbnail: proxiedAvatar,
            type: "profile",
            quality: "Original HD · 1080×1080",
            format: "jpg",
            width: 1080,
            height: 1080,
            aspectRatio: "square",
            hasAudio: false,
          });
        }
      }
    } catch {
      // Fallback to yt-dlp below
    }
  }

  // 2. Video / Shorts Mode via yt-dlp & multi-engine fallback
  if (media.length === 0) {
    let ytData: any = null;

    // Strategy A: yt-dlp standard extraction for full resolutions (4K 2160p, 1440p, 1080p, 720p, 480p)
    try {
      const { stdout } = await execFileAsync(
        "yt-dlp",
        ["--dump-single-json", "--no-warnings", targetUrl],
        { maxBuffer: 50 * 1024 * 1024, timeout: 15000 }
      );
      if (stdout) {
        ytData = JSON.parse(stdout);
      }
    } catch {
      // Strategy B: yt-dlp with android,web client to bypass bot/IP block if 429
      try {
        const { stdout } = await execFileAsync(
          "yt-dlp",
          [
            "--dump-single-json",
            "--no-warnings",
            "--extractor-args",
            "youtube:player_client=android,web",
            targetUrl,
          ],
          { maxBuffer: 50 * 1024 * 1024, timeout: 15000 }
        );
        if (stdout) {
          ytData = JSON.parse(stdout);
        }
      } catch {
        // Fallback to Invidious / Piped API below
      }
    }

    // Strategy C: Public Invidious / Piped API fallback
    if (!ytData) {
      let videoId = "";
      try {
        const u = new URL(targetUrl);
        videoId = u.searchParams.get("v") || "";
        if (!videoId && u.pathname.includes("/shorts/")) {
          videoId = u.pathname.split("/shorts/")[1]?.split(/[/?#]/)[0] || "";
        }
      } catch {
        // ignore
      }

      if (videoId) {
        const invidiousMirrors = [
          `https://yt.drgnz.club/api/v1/videos/${videoId}`,
          `https://invidious.jing.rocks/api/v1/videos/${videoId}`,
          `https://invidious.projectsegfau.lt/api/v1/videos/${videoId}`,
          `https://pipedapi.kavin.rocks/streams/${videoId}`,
        ];

        for (const mirrorUrl of invidiousMirrors) {
          if (ytData) break;
          try {
            const mirRes = await fetch(mirrorUrl, {
              headers: { "User-Agent": DESKTOP_UA },
              signal: AbortSignal.timeout(6000),
            });
            if (mirRes.ok) {
              ytData = await mirRes.json();
            }
          } catch {
            // continue
          }
        }
      }
    }

    if (ytData) {
      title = ytData.title || "YouTube Video";
      caption = ytData.description || "";
      if (ytData.upload_date) {
        const d = String(ytData.upload_date);
        uploadDate = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
      } else if (ytData.published) {
        uploadDate = new Date(ytData.published * 1000).toISOString().split("T")[0];
      }

      creator.name = ytData.uploader || ytData.channel || ytData.author || "YouTube Creator";
      creator.handle = ytData.uploader_id || ytData.channel_id || null;
      creator.profileUrl = ytData.channel_url || ytData.uploader_url || null;

      const rawThumb =
        ytData.thumbnail ||
        ytData.videoThumbnails?.[0]?.url ||
        (ytData.id ? `https://i.ytimg.com/vi/${ytData.id}/maxresdefault.jpg` : null);
      if (rawThumb) {
        thumbnail = buildStreamUrl(rawThumb, "thumbnail.jpg", true);
      }

      // Detect Shorts (vertical) vs Standard Video (horizontal)
      const isShorts =
        targetUrl.includes("/shorts/") ||
        Boolean(ytData.formats?.some((f: any) => f.height && f.width && f.height > f.width));
      const defaultAspect = isShorts ? "vertical" : "horizontal";

      // Group formats by target resolutions: 4K (2160p), 1440p, 1080p, 720p, 480p, 360p
      const rawFormats: any[] = ytData.formats || ytData.formatStreams || [];
      const targetHeights = [2160, 1440, 1080, 720, 480, 360];
      const seenHeights = new Set<number>();

      // Audio setup (320kbps MP3 capability)
      const audioStreams = rawFormats.filter((f) => f.acodec && f.acodec !== "none" && f.url);
      if (audioStreams.length > 0 || ytData.id) {
        audioAvailable = true;
        audioUrl = audioStreams[0]?.url || targetUrl;
      }

      // Progressive format with both audio and video for 100% reliable player preview
      const progressiveFormat =
        rawFormats.find(
          (f) =>
            f.vcodec &&
            f.vcodec !== "none" &&
            f.acodec &&
            f.acodec !== "none" &&
            f.url &&
            f.protocol === "https" &&
            !f.url.includes("manifest.googlevideo.com")
        ) ||
        rawFormats.find(
          (f) =>
            f.format_id === "18" &&
            f.url &&
            !f.url.includes("manifest.googlevideo.com")
        ) ||
        rawFormats.find(
          (f) =>
            f.url &&
            f.protocol === "https" &&
            !f.url.includes("manifest.googlevideo.com") &&
            !f.protocol?.includes("m3u8")
        );

      for (const h of targetHeights) {
        const matchingFormats = rawFormats.filter(
          (f) =>
            f.height === h &&
            f.url &&
            f.vcodec !== "none" &&
            !f.protocol?.includes("m3u8") &&
            f.protocol !== "mhtml" &&
            !f.url.includes("manifest.googlevideo.com")
        );
        if (matchingFormats.length === 0) continue;

        // Prefer mp4 extension
        matchingFormats.sort((a, b) => {
          if (a.ext === "mp4" && b.ext !== "mp4") return -1;
          if (b.ext === "mp4" && a.ext !== "mp4") return 1;
          return (b.tbr || 0) - (a.tbr || 0);
        });

        const chosen = matchingFormats[0];
        seenHeights.add(h);

        let qName = `${h}p`;
        if (h >= 2160) qName = "4K · 2160p";
        else if (h >= 1440) qName = "QHD · 1440p";
        else if (h >= 1080) qName = "Full HD · 1080p";
        else if (h >= 720) qName = "HD · 720p";
        else if (h >= 480) qName = "SD · 480p";
        else qName = "SD · 360p";

        const hasAudio = Boolean(chosen.acodec && chosen.acodec !== "none");
        const ext = chosen.ext || "mp4";
        const width =
          chosen.width ||
          (h === 2160 ? 3840 : h === 1440 ? 2560 : h === 1080 ? 1920 : h === 720 ? 1280 : 854);

        const previewStreamUrl =
          hasAudio && chosen.protocol === "https"
            ? chosen.url
            : progressiveFormat?.url || chosen.url;

        media.push({
          url: buildStreamUrl(previewStreamUrl, safeFilename(`${title}-${h}p`, "mp4"), true),
          rawUrl: chosen.url,
          downloadUrl: buildStreamUrl(chosen.url, safeFilename(`${title}-${h}p`, ext), false),
          thumbnail,
          type: "video",
          quality: qName,
          format: ext,
          width,
          height: h,
          aspectRatio: computeAspectRatio(width, h, defaultAspect),
          hasAudio: true,
        });
      }

      // If no target heights matched, pick any available video formats
      if (media.length === 0) {
        const availableVideo = rawFormats.filter((f) => f.url && (f.vcodec !== "none" || f.height));
        availableVideo.sort((a, b) => (b.height || 0) - (a.height || 0));

        if (availableVideo.length > 0) {
          const topF = availableVideo[0];
          const h = topF.height || 720;
          const w = topF.width || (isShorts ? 720 : 1280);
          media.push({
            url: buildStreamUrl(topF.url, safeFilename(title, "mp4"), true),
            rawUrl: topF.url,
            downloadUrl: buildStreamUrl(topF.url, safeFilename(title, "mp4"), false),
            thumbnail,
            type: "video",
            quality: h >= 1080 ? "Full HD · 1080p" : h >= 720 ? "HD · 720p" : "SD · 480p",
            format: topF.ext || "mp4",
            width: w,
            height: h,
            aspectRatio: computeAspectRatio(w, h, defaultAspect),
            hasAudio: Boolean(topF.acodec && topF.acodec !== "none"),
          });
        }
      }
    }
  }

  // 3. Fallback to YouTube oEmbed API if both yt-dlp and Invidious were blocked
  if (media.length === 0) {
    try {
      const oembedRes = await fetch(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(targetUrl)}&format=json`,
        { headers: { "User-Agent": DESKTOP_UA }, signal: AbortSignal.timeout(6000) }
      );
      if (oembedRes.ok) {
        const oembed = await oembedRes.json();
        title = oembed.title || title || "YouTube Video";
        creator.name = oembed.author_name || creator.name;
        creator.profileUrl = oembed.author_url || creator.profileUrl;

        let videoId = "";
        try {
          const u = new URL(targetUrl);
          videoId = u.searchParams.get("v") || u.pathname.split("/shorts/")[1]?.split(/[/?#]/)[0] || "";
        } catch {
          // ignore
        }

        const rawThumb =
          oembed.thumbnail_url || (videoId ? `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg` : null);
        if (rawThumb) {
          thumbnail = buildStreamUrl(rawThumb, "thumbnail.jpg", true);
        }

        media.push({
          url: buildStreamUrl(targetUrl, safeFilename(title, "mp4"), true),
          rawUrl: targetUrl,
          downloadUrl: buildStreamUrl(targetUrl, safeFilename(title, "mp4"), false),
          thumbnail,
          type: "video",
          quality: "Full HD · 1080p",
          format: "mp4",
          width: 1920,
          height: 1080,
          aspectRatio: "horizontal",
          hasAudio: true,
        });
        audioAvailable = true;
        audioUrl = targetUrl;
      }
    } catch {
      // ignore
    }
  }

  return {
    title: title || "YouTube Video",
    caption,
    thumbnail,
    uploadDate,
    audioUrl,
    audioAvailable,
    isCarousel,
    creator,
    media,
  };
}

// ============================================================================
// ROUTES
// ============================================================================

app.get("/api/healthz", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

app.get("/api/stream", async (req: Request, res: Response) => {
  try {
    const rawUrl = typeof req.query.url === "string" ? req.query.url : "";
    const filename =
      typeof req.query.filename === "string" ? req.query.filename : "omnidownloader-media";
    const inline = req.query.inline === "1";

    if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) {
      res.status(400).json({ error: "A valid media URL is required." });
      return;
    }

    const parsed = new URL(rawUrl);
    const referer = parsed.hostname.includes("tiktok")
      ? "https://www.tiktok.com/"
      : parsed.hostname.includes("instagram") || parsed.hostname.includes("fbcdn")
      ? "https://www.instagram.com/"
      : parsed.origin;

    const reqHeaders: Record<string, string> = {
      "User-Agent": DESKTOP_UA,
      Referer: referer,
      Accept: "*/*",
    };

    if (req.headers.range) {
      reqHeaders["Range"] = req.headers.range;
    }

    const upstream = await fetch(rawUrl, {
      headers: reqHeaders,
      signal: AbortSignal.timeout(25000),
    });

    if (!upstream.ok && upstream.status !== 206) {
      res.status(502).json({ error: "Media source could not be reached." });
      return;
    }

    const contentType = upstream.headers.get("content-type") || "application/octet-stream";
    const contentLength = upstream.headers.get("content-length");
    const contentRange = upstream.headers.get("content-range");

    res.status(upstream.status);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("Accept-Ranges", "bytes");

    if (contentLength) res.setHeader("Content-Length", contentLength);
    if (contentRange) res.setHeader("Content-Range", contentRange);

    if (!inline) {
      const cleanName = filename.replace(/[^\w.\- ]+/g, "_");
      res.setHeader("Content-Disposition", `attachment; filename="${cleanName}"`);
    } else {
      res.setHeader("Cache-Control", "public, max-age=3600");
    }

    if (upstream.body) {
      Readable.fromWeb(upstream.body as any).pipe(res);
    } else {
      const arrayBuffer = await upstream.arrayBuffer();
      res.send(Buffer.from(arrayBuffer));
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Stream error";
    if (!res.headersSent) {
      res.status(500).json({ error: message });
    }
  }
});

app.post("/api/extract", async (req: Request, res: Response) => {
  try {
    pruneCache();
    const { url: rawInput, mode: requestedMode = "post", platform: requestedPlatform } = req.body;

    if (!rawInput || typeof rawInput !== "string") {
      res.status(400).json({ error: "A valid public URL or @username is required." });
      return;
    }

    let targetUrl = rawInput.trim();
    let forcedProfileMode = requestedMode === "profile";
    let explicitHandle: string | null = null;

    if (!targetUrl.includes("://") && /^@?[\w.-]{1,60}$/.test(targetUrl) && !targetUrl.includes("/")) {
      const cleanHandle = targetUrl.replace(/^@/, "");
      explicitHandle = cleanHandle;
      forcedProfileMode = true;
      const plat =
        requestedPlatform && requestedPlatform !== "auto" ? requestedPlatform : "instagram";
      if (plat === "tiktok") {
        targetUrl = `https://www.tiktok.com/@${cleanHandle}`;
      } else if (plat === "pinterest") {
        targetUrl = `https://www.pinterest.com/${cleanHandle}/`;
      } else if (plat === "youtube") {
        targetUrl = `https://www.youtube.com/@${cleanHandle}`;
      } else {
        targetUrl = `https://www.instagram.com/${cleanHandle}/`;
      }
    } else if (
      !targetUrl.includes("://") &&
      /^(?:www\.|m\.|vt\.|vm\.)?(?:instagram\.com|tiktok\.com|pinterest\.com|pin\.it|instagr\.am|youtube\.com|youtu\.be)\//i.test(
        targetUrl
      )
    ) {
      targetUrl = `https://${targetUrl}`;
    }

    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        throw new Error();
      }
    } catch {
      res.status(400).json({
        error: "Enter a full public URL (e.g. https://...) or a @username handle.",
      });
      return;
    }

    targetUrl = await resolveShortUrl(targetUrl);
    const platform = detectPlatform(targetUrl);

    if (!platform) {
      res.status(400).json({
        error: "This link is not from Instagram, TikTok, YouTube, or Pinterest.",
      });
      return;
    }

    if (
      requestedPlatform &&
      requestedPlatform !== "auto" &&
      requestedPlatform !== platform &&
      !explicitHandle
    ) {
      res.status(400).json({
        error: `This link is from ${platform.charAt(0).toUpperCase() + platform.slice(1)}, not ${
          requestedPlatform.charAt(0).toUpperCase() + requestedPlatform.slice(1)
        }.`,
      });
      return;
    }

    const profileCheck = isProfileUrl(targetUrl, platform);
    const isProfile = forcedProfileMode || profileCheck.isProfile;
    const detectedHandle = explicitHandle || profileCheck.handle;

    let extracted: PlatformExtractResult;
    if (platform === "tiktok") {
      extracted = await extractTikTok(targetUrl, isProfile, detectedHandle);
    } else if (platform === "instagram") {
      extracted = await extractInstagram(targetUrl, isProfile, detectedHandle);
    } else if (platform === "youtube") {
      extracted = await extractYouTube(targetUrl, isProfile, detectedHandle);
    } else {
      extracted = await extractPinterest(targetUrl, isProfile, detectedHandle);
    }

    if (!extracted.media.length) {
      res.status(422).json({
        error:
          "We couldn’t retrieve this public post. It may be private, expired, or temporarily unavailable.",
      });
      return;
    }

    const hashtags = extractHashtags(extracted.caption, extracted.title);

    let resultType: DownloadResult["type"] = "image";
    if (isProfile || extracted.media.every((m) => m.type === "profile")) {
      resultType = "profile";
    } else if (extracted.isCarousel) {
      resultType = "carousel";
    } else if (extracted.media.some((m) => m.type === "video")) {
      resultType = "video";
    }

    const downloadId = uuidv4().replace(/-/g, "");
    resultCache.set(downloadId, {
      createdAt: Date.now(),
      sourceUrl: targetUrl,
      platform,
      media: extracted.media,
      avatarUrl:
        extracted.creator.avatarUrl ||
        extracted.media[0]?.rawUrl ||
        extracted.media[0]?.url ||
        null,
      audioUrl: extracted.audioUrl,
      title: extracted.title,
      creator: extracted.creator,
      audioAvailable: extracted.audioAvailable,
    });

    const responseData: DownloadResult = {
      downloadId,
      status: "success",
      platform,
      type: resultType,
      title: extracted.title,
      caption: extracted.caption,
      description: extracted.caption,
      uploadDate: extracted.uploadDate,
      boardName: extracted.boardName || null,
      hashtags,
      thumbnail:
        extracted.thumbnail || extracted.media[0]?.thumbnail || extracted.media[0]?.url || null,
      audioUrl: extracted.audioUrl
        ? buildStreamUrl(
            extracted.audioUrl,
            safeFilename(`${extracted.title}-audio`, "mp3"),
            false
          )
        : null,
      creator: extracted.creator,
      media: extracted.media,
      audioAvailable: extracted.audioAvailable,
    };

    res.json(responseData);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to extract media";
    res.status(500).json({ error: message });
  }
});

app.post("/api/highlight", async (req: Request, res: Response) => {
  try {
    pruneCache();
    const { url: rawUrl } = req.body;

    if (!rawUrl || typeof rawUrl !== "string") {
      res.status(400).json({ error: "Paste an Instagram Story or Highlight link." });
      return;
    }

    let normalized = rawUrl.trim();
    if (!normalized.includes("://")) normalized = `https://${normalized}`;
    const targetUrl = await resolveShortUrl(normalized);
    const platform = detectPlatform(targetUrl);

    if (platform !== "instagram") {
      res.status(400).json({ error: "Instagram Stories and Highlights links are supported here." });
      return;
    }

    let title = "Instagram Story";
    let cover: string | null = null;
    const creator: DownloadCreator = {
      handle: null,
      name: null,
      avatarUrl: null,
      profileUrl: null,
      verified: false,
    };
    const stories: HighlightStory[] = [];
    const media: DownloadMedia[] = [];

    const parsedTarget = new URL(targetUrl);
    const pathParts = parsedTarget.pathname.split("/").filter(Boolean);
    const isHighlightReel = pathParts[0] === "stories" && pathParts[1] === "highlights";
    const highlightId = isHighlightReel ? pathParts[2] : null;
    const storyUsername =
      pathParts[0] === "stories" && pathParts[1] !== "highlights" ? pathParts[1] : null;
    const storyId =
      pathParts[0] === "stories" && pathParts[1] !== "highlights" ? pathParts[2] : null;

    if (storyUsername) {
      creator.handle = storyUsername;
      creator.name = storyUsername;
      creator.profileUrl = `https://www.instagram.com/${storyUsername}/`;
      title = `@${storyUsername}'s Story`;
    } else if (highlightId) {
      title = "Instagram Highlight";
    }

    // Engine 1: Instagram Public GraphQL Query & Reels Media API for Highlights
    if (highlightId) {
      try {
        const gqlUrl = `https://www.instagram.com/graphql/query/?query_hash=452461e2dc7e6744e242663777b9d502&variables=${encodeURIComponent(
          JSON.stringify({
            highlight_reel_ids: [highlightId],
            reel_ids: [],
            location_ids: [],
            precomposed_overlay: false,
          })
        )}`;

        const gqlRes = await fetch(gqlUrl, {
          headers: {
            "User-Agent": INSTAGRAM_EMBED_UA,
            "x-ig-app-id": "936619743392459",
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(8000),
        });

        if (gqlRes.ok) {
          const gqlData = await gqlRes.json();
          const reel =
            gqlData?.data?.user?.reel ||
            gqlData?.data?.reels_media?.[0] ||
            gqlData?.data?.highlight_reel;
          if (reel) {
            if (reel.user) {
              creator.handle = reel.user.username || creator.handle;
              creator.name = reel.user.full_name || creator.handle;
              creator.verified = Boolean(reel.user.is_verified);
              if (creator.handle) creator.profileUrl = `https://www.instagram.com/${creator.handle}/`;
              if (reel.user.profile_pic_url) {
                creator.avatarUrl = buildStreamUrl(reel.user.profile_pic_url, `${creator.handle}-avatar.jpg`, true);
              }
            }
            if (reel.title) title = reel.title;
            if (reel.cover_media?.cropped_image_version?.url) {
              cover = buildStreamUrl(reel.cover_media.cropped_image_version.url, "cover.jpg", true);
            }

            const items = reel.items || reel.edge_highlight_reel_to_media?.edges;
            if (Array.isArray(items) && items.length > 0) {
              items.forEach((it: any, idx: number) => {
                const node = it?.node || it;
                const isVid = Boolean(node.is_video || node.video_versions?.length || node.video_resources?.length);
                const rawVid =
                  node.video_resources?.[0]?.src ||
                  node.video_versions?.[0]?.url ||
                  node.video_url;
                const rawImg =
                  node.display_url ||
                  node.image_versions2?.candidates?.[0]?.url ||
                  node.display_resources?.[node.display_resources.length - 1]?.src;

                const itemThumb = rawImg ? buildStreamUrl(rawImg, `story-thumb-${idx + 1}.jpg`, true) : cover;
                const streamUrl = isVid && rawVid
                  ? buildStreamUrl(rawVid, `story-${idx + 1}.mp4`, true)
                  : rawImg
                  ? buildStreamUrl(rawImg, `story-${idx + 1}.jpg`, true)
                  : "";
                const dlUrl = isVid && rawVid
                  ? buildStreamUrl(rawVid, `${safeFilename(title, "mp4")}-story-${idx + 1}.mp4`, false)
                  : rawImg
                  ? buildStreamUrl(rawImg, `${safeFilename(title, "jpg")}-story-${idx + 1}.jpg`, false)
                  : "";

                if (streamUrl) {
                  stories.push({
                    storyNumber: idx + 1,
                    mediaIndex: idx,
                    type: isVid ? "video" : "photo",
                    duration: node.video_duration || (isVid ? 15 : null),
                    thumbnail: itemThumb,
                    createdAt: node.taken_at_timestamp
                      ? new Date(node.taken_at_timestamp * 1000).toISOString().split("T")[0]
                      : new Date().toISOString().split("T")[0],
                    url: streamUrl,
                    downloadUrl: dlUrl,
                  });

                  media.push({
                    url: streamUrl,
                    rawUrl: isVid ? rawVid : rawImg,
                    downloadUrl: dlUrl,
                    thumbnail: itemThumb,
                    type: isVid ? "video" : "image",
                    quality: "Full HD · 1080p",
                    format: isVid ? "mp4" : "jpg",
                    width: 1080,
                    height: 1920,
                    aspectRatio: "vertical",
                    hasAudio: isVid,
                  });
                }
              });
            }
          }
        }
      } catch {
        // Fallback to reels_media / mirrors below
      }
    }

    // Engine 2: Public FastDL / SSSInstagram converter mirror fallback
    if (stories.length === 0) {
      try {
        const mirrorRes = await fetch("https://sssinstagram.com/api/convert", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": DESKTOP_UA,
            "X-Requested-With": "XMLHttpRequest",
            Referer: "https://sssinstagram.com/",
          },
          body: JSON.stringify({ target_url: targetUrl }),
          signal: AbortSignal.timeout(8000),
        });

        if (mirrorRes.ok) {
          const mirrorData = await mirrorRes.json();
          const htmlContent = mirrorData?.data?.html || mirrorData?.html;
          if (htmlContent && typeof htmlContent === "string") {
            const $m = cheerio.load(htmlContent);
            const downloadLinks = $m("a.download-file, a[href*='cdninstagram.com'], a[href*='fbcdn.net']");
            downloadLinks.each((idx, el) => {
              const href = $m(el).attr("href");
              if (!href) return;
              const isVid = href.includes(".mp4") || href.includes("video");
              const streamUrl = buildStreamUrl(href, `story-${idx + 1}.${isVid ? "mp4" : "jpg"}`, true);
              const dlUrl = buildStreamUrl(href, `${safeFilename(title, "mp4")}-story-${idx + 1}.${isVid ? "mp4" : "jpg"}`, false);
              stories.push({
                storyNumber: idx + 1,
                mediaIndex: idx,
                type: isVid ? "video" : "photo",
                duration: isVid ? 15 : null,
                thumbnail: streamUrl,
                createdAt: new Date().toISOString().split("T")[0],
                url: streamUrl,
                downloadUrl: dlUrl,
              });
              media.push({
                url: streamUrl,
                rawUrl: href,
                downloadUrl: dlUrl,
                thumbnail: streamUrl,
                type: isVid ? "video" : "image",
                quality: "Full HD · 1080p",
                format: isVid ? "mp4" : "jpg",
                width: 1080,
                height: 1920,
                aspectRatio: "vertical",
                hasAudio: isVid,
              });
            });
          }
        }
      } catch {
        // Fallback to Embed Scraper below
      }
    }

    // Engine 3: Instagram Embed Scraper (/embed/ and /embed/captioned/ with INSTAGRAM_EMBED_UA)
    if (stories.length === 0) {
      const candidateUrls = [
        targetUrl,
        `${targetUrl.replace(/\/$/, "")}/embed/captioned/`,
        `${targetUrl.replace(/\/$/, "")}/embed/`,
      ];
      if (storyId) {
        candidateUrls.push(`https://www.instagram.com/p/${storyId}/embed/captioned/`);
      }

      for (const candidate of candidateUrls) {
        if (stories.length > 0) break;
        try {
          const pageRes = await fetch(candidate, {
            headers: {
              "User-Agent": INSTAGRAM_EMBED_UA,
            },
            signal: AbortSignal.timeout(7500),
          });
          if (!pageRes.ok) continue;

          const html = await pageRes.text();
          const $ = cheerio.load(html);

          const ogTitle = $('meta[property="og:title"]').attr("content");
          const ogImage = $('meta[property="og:image"]').attr("content");
          const ogVideo =
            $('meta[property="og:video"]').attr("content") ||
            $('meta[property="og:video:secure_url"]').attr("content");

          const isLoginGate =
            html.includes('"LoginAndSignupPage"') ||
            (ogTitle && /login\s*•\s*instagram/i.test(ogTitle)) ||
            (!ogVideo && (!ogImage || isGenericInstagramLogo(ogImage)));

          if (isLoginGate) continue;

          if (ogTitle) title = ogTitle.replace(/\s*•\s*Instagram.*$/i, "").trim();
          if (ogImage && !isGenericInstagramLogo(ogImage)) {
            const rawCover = decodeEscapedUrl(ogImage);
            cover = buildStreamUrl(rawCover, "highlight-cover.jpg", true);
          }

          // Direct extraction from internal script JSON payload for authentic story media
          const scriptMatches = html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi);
          for (const sm of scriptMatches) {
            const scriptBody = sm[1];
            if (!scriptBody || (!scriptBody.includes("video_versions") && !scriptBody.includes("image_versions2") && !scriptBody.includes("display_url"))) continue;

            const vidMatch = scriptBody.match(/"video_versions":\s*\[\s*\{\s*"url":\s*"([^"]+)"/);
            const imgMatch = scriptBody.match(/"image_versions2":\s*\{\s*"candidates":\s*\[\s*\{\s*"url":\s*"([^"]+)"/);
            const dispMatch = scriptBody.match(/"display_url":\s*"([^"]+)"/);

            const directVid = vidMatch?.[1] ? decodeEscapedUrl(vidMatch[1]) : null;
            const directImg = (imgMatch?.[1] ? decodeEscapedUrl(imgMatch[1]) : null) || (dispMatch?.[1] ? decodeEscapedUrl(dispMatch[1]) : null);

            if (directVid && !isGenericInstagramLogo(directVid) && stories.length === 0) {
              const streamUrl = buildStreamUrl(directVid, "story-1.mp4", true);
              const dlUrl = buildStreamUrl(directVid, `${safeFilename(title, "mp4")}-story-1.mp4`, false);
              const thumbUrl = directImg && !isGenericInstagramLogo(directImg) ? buildStreamUrl(directImg, "thumb.jpg", true) : null;
              media.push({
                url: streamUrl,
                rawUrl: directVid,
                downloadUrl: dlUrl,
                thumbnail: thumbUrl,
                type: "video",
                quality: "Full HD · 1080p",
                format: "mp4",
                width: 1080,
                height: 1920,
                aspectRatio: "vertical",
                hasAudio: true,
              });
              stories.push({
                storyNumber: 1,
                mediaIndex: 0,
                type: "video",
                duration: 15,
                thumbnail: thumbUrl,
                createdAt: new Date().toISOString().split("T")[0],
                url: streamUrl,
                downloadUrl: dlUrl,
              });
              break;
            } else if (directImg && !isGenericInstagramLogo(directImg) && stories.length === 0) {
              const streamUrl = buildStreamUrl(directImg, "story-1.jpg", true);
              const dlUrl = buildStreamUrl(directImg, `${safeFilename(title, "jpg")}-story-1.jpg`, false);
              media.push({
                url: streamUrl,
                rawUrl: directImg,
                downloadUrl: dlUrl,
                thumbnail: streamUrl,
                type: "image",
                quality: "Original HD",
                format: "jpg",
                width: 1080,
                height: 1920,
                aspectRatio: "vertical",
                hasAudio: false,
              });
              stories.push({
                storyNumber: 1,
                mediaIndex: 0,
                type: "photo",
                duration: null,
                thumbnail: streamUrl,
                createdAt: new Date().toISOString().split("T")[0],
                url: streamUrl,
                downloadUrl: dlUrl,
              });
              break;
            }
          }

          if (ogVideo && stories.length === 0) {
            const rawVid = decodeEscapedUrl(ogVideo);
            const streamUrl = buildStreamUrl(rawVid, "story-1.mp4", true);
            const dlUrl = buildStreamUrl(rawVid, `${safeFilename(title, "mp4")}-story-1.mp4`, false);
            media.push({
              url: streamUrl,
              rawUrl: rawVid,
              downloadUrl: dlUrl,
              thumbnail: cover,
              type: "video",
              quality: "Full HD · 1080p",
              format: "mp4",
              width: 1080,
              height: 1920,
              aspectRatio: "vertical",
              hasAudio: true,
            });
            stories.push({
              storyNumber: 1,
              mediaIndex: 0,
              type: "video",
              duration: 15,
              thumbnail: cover,
              createdAt: new Date().toISOString().split("T")[0],
              url: streamUrl,
              downloadUrl: dlUrl,
            });
          } else if (ogImage && !isGenericInstagramLogo(ogImage) && stories.length === 0) {
            const rawImg = decodeEscapedUrl(ogImage);
            const streamUrl = buildStreamUrl(rawImg, "story-1.jpg", true);
            const dlUrl = buildStreamUrl(rawImg, `${safeFilename(title, "jpg")}-story-1.jpg`, false);
            media.push({
              url: streamUrl,
              rawUrl: rawImg,
              downloadUrl: dlUrl,
              thumbnail: streamUrl,
              type: "image",
              quality: "Original HD",
              format: "jpg",
              width: 1080,
              height: 1920,
              aspectRatio: "vertical",
              hasAudio: false,
            });
            stories.push({
              storyNumber: 1,
              mediaIndex: 0,
              type: "photo",
              duration: null,
              thumbnail: streamUrl,
              createdAt: new Date().toISOString().split("T")[0],
              url: streamUrl,
              downloadUrl: dlUrl,
            });
          }
        } catch {
          // continue
        }
      }
    }

    // Engine 4: Public oEmbed API for Story title & author
    if (!creator.handle && targetUrl) {
      try {
        const oembedRes = await fetch(
          `https://api.instagram.com/oembed/?url=${encodeURIComponent(targetUrl)}`,
          { headers: { "User-Agent": DESKTOP_UA }, signal: AbortSignal.timeout(5000) }
        );
        if (oembedRes.ok) {
          const oembed = await oembedRes.json();
          if (oembed.author_name) {
            creator.handle = oembed.author_name;
            creator.name = oembed.author_name;
            creator.profileUrl = `https://www.instagram.com/${oembed.author_name}/`;
          }
          if (oembed.title && (!title || title === "Instagram Story")) {
            title = oembed.title;
          }
          if (oembed.thumbnail_url && !cover) {
            cover = buildStreamUrl(oembed.thumbnail_url, "cover.jpg", true);
          }
        }
      } catch {
        // ignore
      }
    }

    const downloadId = uuidv4().replace(/-/g, "");

    if (stories.length === 0) {
      const fallbackResponse: HighlightResult = {
        downloadId,
        title: storyUsername ? `@${storyUsername}'s Story` : "Instagram Story",
        cover,
        creator,
        stories: [],
        truncated: false,
        requiresDirectLinkAlert: false,
        alertMessage: "This story or highlight is private, expired, or temporarily unavailable. Make sure the creator's account is public and active.",
      };
      res.json(fallbackResponse);
      return;
    }

    resultCache.set(downloadId, {
      createdAt: Date.now(),
      sourceUrl: targetUrl,
      platform: "instagram",
      media,
      avatarUrl: creator.avatarUrl || cover,
      audioUrl: null,
      title,
      creator,
      audioAvailable: false,
      isHighlight: true,
      stories,
    });

    const responseData: HighlightResult = {
      downloadId,
      title: title || (creator.handle ? `@${creator.handle}'s Stories` : "Instagram Stories"),
      cover: cover || stories[0]?.thumbnail || null,
      creator,
      stories,
      truncated: false,
      requiresDirectLinkAlert: false,
    };

    res.json(responseData);
    return;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to extract highlight";
    res.status(500).json({ error: message });
  }
});

app.post("/api/download", async (req: Request, res: Response) => {
  try {
    pruneCache();
    const { downloadId, url: directUrl, filename, assetType, mediaIndex, format, items } = req.body;

    const cached = downloadId ? resultCache.get(downloadId) : undefined;

    if (assetType === "archive") {
      const archiveItems: Array<{ url: string; type: string; filename?: string }> = [];

      if (Array.isArray(items) && items.length > 0) {
        for (const it of items) {
          if (it?.url) archiveItems.push(it);
        }
      } else if (cached) {
        cached.media.forEach((m, idx) => {
          archiveItems.push({
            url: m.rawUrl || m.url,
            type: m.type,
            filename: `slide-${idx + 1}.${m.type === "video" ? "mp4" : "jpg"}`,
          });
        });
      }

      if (archiveItems.length === 0) {
        res.status(404).json({ error: "No slides available to archive." });
        return;
      }

      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="omnidownloader-slides.zip"`);

      const archive = archiver("zip", { zlib: { level: 9 } });
      archive.pipe(res);

      for (let i = 0; i < archiveItems.length; i++) {
        const item = archiveItems[i];
        try {
          let fetchUrl = item.url;
          if (fetchUrl.startsWith("/api/stream")) {
            const q = new URL(fetchUrl, `http://localhost:${PORT}`).searchParams.get("url");
            if (q) fetchUrl = q;
          }

          const fetchRes = await fetch(fetchUrl, {
            headers: { "User-Agent": DESKTOP_UA },
            signal: AbortSignal.timeout(20000),
          });
          if (fetchRes.ok) {
            const buffer = Buffer.from(await fetchRes.arrayBuffer());
            const ext = item.type === "video" ? "mp4" : "jpg";
            const entryName = item.filename || `slide-${i + 1}.${ext}`;
            archive.append(buffer, { name: entryName });
          }
        } catch {
          // Continue with remaining slides
        }
      }

      await archive.finalize();
      return;
    }

    let targetUrl: string | null = directUrl || null;
    let fallbackExt = format === "webp" ? "webp" : format === "mp3" ? "mp3" : "mp4";

    if (targetUrl && targetUrl.startsWith("/api/stream")) {
      const unwrapped = new URL(targetUrl, `http://localhost:${PORT}`).searchParams.get("url");
      if (unwrapped) targetUrl = unwrapped;
    }

    if (!targetUrl && cached) {
      if (assetType === "avatar") {
        targetUrl = cached.avatarUrl;
        fallbackExt = "jpg";
      } else if (assetType === "audio") {
        targetUrl =
          cached.audioUrl ||
          cached.media.find((m) => m.type === "video")?.rawUrl ||
          cached.media[0]?.rawUrl ||
          null;
        fallbackExt = "mp3";
      } else {
        const idx = mediaIndex != null ? Number(mediaIndex) : 0;
        const mediaItem = cached.media[idx] || cached.media[0];
        if (mediaItem) {
          targetUrl = mediaItem.rawUrl || mediaItem.url;
          fallbackExt =
            mediaItem.type === "video" ? "mp4" : format === "webp" ? "webp" : "jpg";
        }
      }

      if (targetUrl && targetUrl.startsWith("/api/stream")) {
        const unwrapped = new URL(targetUrl, `http://localhost:${PORT}`).searchParams.get("url");
        if (unwrapped) targetUrl = unwrapped;
      }
    }

    if (!targetUrl) {
      res.status(404).json({ error: "Media URL was not found. Paste the link again to refresh." });
      return;
    }

    const downloadName = filename || (cached?.title ? safeFilename(cached.title, fallbackExt) : `media.${fallbackExt}`);

    if (
      cached?.platform === "youtube" ||
      targetUrl.includes("youtube.com") ||
      targetUrl.includes("youtu.be")
    ) {
      const sourceVideoUrl = cached?.sourceUrl || targetUrl;
      const cleanBase = downloadName.replace(/[^\w.\- ]+/g, "_");

      if (assetType === "audio" || format === "mp3") {
        const cleanName = cleanBase.endsWith(".mp3") ? cleanBase : `${cleanBase}.mp3`;
        const tmpAudioPath = `/tmp/omni-audio-${uuidv4()}.mp3`;

        try {
          await execFileAsync("yt-dlp", [
            "-x",
            "--audio-format",
            "mp3",
            "--audio-quality",
            "320k",
            "--no-warnings",
            "-o",
            tmpAudioPath,
            sourceVideoUrl,
          ], { timeout: 120000 });

          if (fs.existsSync(tmpAudioPath)) {
            const stat = fs.statSync(tmpAudioPath);
            res.setHeader("Content-Type", "audio/mpeg");
            res.setHeader("Content-Length", stat.size);
            res.setHeader("Content-Disposition", `attachment; filename="${cleanName}"`);
            const fileStream = fs.createReadStream(tmpAudioPath);
            fileStream.pipe(res);
            fileStream.on("close", () => {
              fs.unlink(tmpAudioPath, () => {});
            });
            fileStream.on("error", () => {
              fs.unlink(tmpAudioPath, () => {});
            });
            return;
          }
        } catch {
          try {
            if (fs.existsSync(tmpAudioPath)) fs.unlinkSync(tmpAudioPath);
          } catch {}
          res.setHeader("Content-Type", "audio/mpeg");
          res.setHeader("Content-Disposition", `attachment; filename="${cleanName}"`);
          const ytdlProcess = spawn("yt-dlp", [
            "-x",
            "--audio-format",
            "mp3",
            "--audio-quality",
            "320k",
            "--no-warnings",
            "-o",
            "-",
            sourceVideoUrl,
          ]);
          ytdlProcess.stdout.pipe(res);
          return;
        }
      }

      if (assetType === "media" || !assetType) {
        const idx = mediaIndex != null ? Number(mediaIndex) : 0;
        const mediaItem = cached?.media[idx] || cached?.media[0];
        const targetHeight = mediaItem?.height || 1080;
        const cleanName = cleanBase.endsWith(".mp4") ? cleanBase : `${cleanBase}.mp4`;
        const tmpVideoPath = `/tmp/omni-vid-${uuidv4()}.mp4`;

        const formatSpec = targetHeight
          ? `bestvideo[height<=${targetHeight}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${targetHeight}]+bestaudio/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best`
          : `bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best`;

        try {
          await execFileAsync("yt-dlp", [
            "-f",
            formatSpec,
            "--merge-output-format",
            "mp4",
            "--no-warnings",
            "-o",
            tmpVideoPath,
            sourceVideoUrl,
          ], { timeout: 180000 });

          if (fs.existsSync(tmpVideoPath)) {
            const stat = fs.statSync(tmpVideoPath);
            res.setHeader("Content-Type", "video/mp4");
            res.setHeader("Content-Length", stat.size);
            res.setHeader("Content-Disposition", `attachment; filename="${cleanName}"`);
            res.setHeader("Accept-Ranges", "bytes");

            const fileStream = fs.createReadStream(tmpVideoPath);
            fileStream.pipe(res);
            fileStream.on("close", () => {
              fs.unlink(tmpVideoPath, () => {});
            });
            fileStream.on("error", () => {
              fs.unlink(tmpVideoPath, () => {});
            });
            return;
          }
        } catch {
          try {
            if (fs.existsSync(tmpVideoPath)) fs.unlinkSync(tmpVideoPath);
          } catch {}
          res.setHeader("Content-Type", "video/mp4");
          res.setHeader("Content-Disposition", `attachment; filename="${cleanName}"`);
          const ytdlProcess = spawn("yt-dlp", [
            "-f",
            "best[ext=mp4]/best",
            "--no-warnings",
            "-o",
            "-",
            sourceVideoUrl,
          ]);
          ytdlProcess.stdout.pipe(res);
          return;
        }
      }
    }

    const parsedTarget = new URL(targetUrl);
    const referer = parsedTarget.hostname.includes("tiktok")
      ? "https://www.tiktok.com/"
      : parsedTarget.hostname.includes("instagram") || parsedTarget.hostname.includes("fbcdn")
      ? "https://www.instagram.com/"
      : parsedTarget.origin;

    const mediaFetch = await fetch(targetUrl, {
      headers: {
        "User-Agent": DESKTOP_UA,
        Referer: referer,
      },
      signal: AbortSignal.timeout(25000),
    });

    if (!mediaFetch.ok) {
      res.status(502).json({ error: "Media source could not be reached or downloaded." });
      return;
    }

    const contentType =
      format === "mp3"
        ? "audio/mpeg"
        : mediaFetch.headers.get("content-type") || "application/octet-stream";

    res.setHeader("Content-Type", contentType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${downloadName.replace(/[^\w.\- ]+/g, "_")}"`
    );

    const arrayBuffer = await mediaFetch.arrayBuffer();
    res.send(Buffer.from(arrayBuffer));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Download failed";
    res.status(500).json({ error: message });
  }
});

async function startServer() {
  if (!isProd) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(import.meta.dirname, "dist");
    app.use(express.static(distPath));
    app.get("*", (_req: Request, res: Response) => {
      res.sendFile(path.resolve(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`OmniDownloader server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
