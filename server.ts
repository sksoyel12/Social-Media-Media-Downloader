import express, { type Request, type Response } from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { execFile, spawn } from "child_process";
import { Readable } from "stream";
import { promisify } from "util";
import { v4 as uuidv4 } from "uuid";
import * as cheerio from "cheerio";
// @ts-ignore
import archiver from "archiver";
import type {
  DownloadCreator,
  DownloadMedia,
  DownloadResult,
  HighlightResult,
  HighlightStory,
  Platform,
} from "./src/types/api";

const PORT = 3000;
const isProd = process.env.NODE_ENV === "production";

const binDir = path.resolve(process.cwd(), "bin");
export const ytDlpPath = fs.existsSync(path.resolve(binDir, "yt-dlp"))
  ? path.resolve(binDir, "yt-dlp")
  : "yt-dlp";

try {
  if (fs.existsSync(ytDlpPath)) {
    fs.chmodSync(ytDlpPath, 0o755);
  }
} catch {}

if (!process.env.PATH?.includes(binDir)) {
  process.env.PATH = `${binDir}:${process.env.PATH || ""}`;
}

const execFileAsync = promisify(execFile);

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

function idToShortcode(idStr: string | null | undefined): string {
  if (!idStr) return "";
  try {
    const cleanDigits = idStr.split("_")[0]?.replace(/\D+/g, "") || "";
    if (!cleanDigits) return "";
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let id = BigInt(cleanDigits);
    let shortcode = "";
    while (id > 0n) {
      const remainder = Number(id % 64n);
      shortcode = alphabet[remainder] + shortcode;
      id = id / 64n;
    }
    return shortcode;
  } catch {
    return "";
  }
}

function isGenericInstagramLogo(url: string | null | undefined): boolean {
  if (!url) return true;
  const lower = url.toLowerCase();
  // Legitimate user media uploaded to Instagram's CDN should never be marked as generic logo
  if (
    lower.includes("/v/t51.") ||
    lower.includes("/v/t50.") ||
    lower.includes("/t51.") ||
    lower.includes("/t50.") ||
    lower.includes("/o1/v/") ||
    lower.includes("/e35/") ||
    lower.includes("/p1080x1080/") ||
    lower.includes("/p750x750/")
  ) {
    return false;
  }
  return (
    lower.includes("instagram_logo") ||
    lower.includes("instagram-logo") ||
    lower.includes("instagramlogo") ||
    lower.includes("brand_assets") ||
    lower.includes("brand-assets") ||
    lower.includes("brandassets") ||
    lower.includes("4168x4168") ||
    lower.includes("static.cdninstagram.com") ||
    lower.includes("/rsrc.php/") ||
    lower.includes("/static/images/") ||
    lower.includes("/static/rsrc/") ||
    lower.includes("favicon") ||
    lower.includes("apple-touch-icon") ||
    lower.includes("transparent.png") ||
    lower.includes("spacer.gif") ||
    lower.includes("meta_logo") ||
    lower.includes("fbcdn.net/rsrc.php") ||
    /instagram[_-]?(?:glyph|brand|wordmark|logo)\.(?:png|jpg|svg|webp)/i.test(lower)
  );
}

function isAuthenticStoryMedia(url: string | null | undefined): boolean {
  if (!url) return false;
  if (isGenericInstagramLogo(url)) return false;
  const lower = url.toLowerCase();
  if (
    lower.includes("instagram_logo") ||
    lower.includes("brand_assets") ||
    lower.includes("static.cdninstagram.com") ||
    lower.includes("/rsrc.php/") ||
    lower.includes("/static/")
  ) {
    return false;
  }
  const isCdn =
    lower.includes("cdninstagram.com") ||
    lower.includes("fbcdn.net") ||
    lower.includes("instagram.");
  if (!isCdn) return false;
  return (
    lower.includes(".mp4") ||
    lower.includes(".jpg") ||
    lower.includes(".jpeg") ||
    lower.includes("/v/t51.") ||
    lower.includes("_nc_cat") ||
    lower.includes("_nc_sid") ||
    lower.includes("/o1/v/") ||
    lower.includes("video")
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
      if (storyMediaId && (parsed.pathname.includes("/stories/") || parsed.pathname.startsWith("/s/"))) {
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

  try {
    const first = new URL(current);
    if (isTikTokShortlink(first)) {
      return sanitizeTrackingParams(await unshortenTikTok(current));
    }
  } catch {
    // not a parseable URL; fall through to the generic resolver
  }

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

// ============================================================================
// TIKTOK: SHORTLINK UNSHORTENER + TIKWM PUBLIC API MIRROR
// ============================================================================

/** Mobile UA used for every TikTok shortlink hop (vt./vm./ /t/ links). */
const TIKTOK_SHORTLINK_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X)";
const TIKWM_BASE = (process.env.TIKWM_BASE || "https://www.tikwm.com").replace(/\/+$/, "");
const TIKTOK_CONTENT_PATH = /^\/@[^/]+\/(?:video|photo|story)\/\d+/i;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isTikTokShortlink(u: URL): boolean {
  const host = u.hostname.toLowerCase();
  return (
    host === "vt.tiktok.com" ||
    host === "vm.tiktok.com" ||
    (host.endsWith("tiktok.com") && /^\/t\//.test(u.pathname))
  );
}

/**
 * Fully unshortens a TikTok shortlink (vt.tiktok.com/ZS..., vm.tiktok.com/..., tiktok.com/t/...)
 * by following the redirect chain by hand with a mobile User-Agent, and returns the canonical
 * https://www.tiktok.com/@user/(video|photo|story)/<id> URL. If the chain ends in a geo / consent /
 * login trap (/about, /login, "/") the last useful URL is returned instead of the trap.
 */
async function unshortenTikTok(rawUrl: string): Promise<string> {
  let current = rawUrl.trim();
  let best = current;

  for (let hop = 0; hop < 8; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      break;
    }
    if (TIKTOK_CONTENT_PATH.test(parsed.pathname)) {
      best = current;
      break;
    }
    if (!parsed.hostname.toLowerCase().endsWith("tiktok.com")) break;

    try {
      const res = await fetch(current, {
        method: "GET",
        redirect: "manual",
        headers: {
          "User-Agent": TIKTOK_SHORTLINK_UA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: AbortSignal.timeout(8000),
      });

      const location = res.headers.get("location");
      if (location && [301, 302, 303, 307, 308].includes(res.status)) {
        await res.body?.cancel().catch(() => {});
        const next = new URL(location, current);
        if (/\/(?:about|login)(?:\/|$)/i.test(next.pathname) || next.pathname === "/") break;
        current = next.toString();
        best = current;
        continue;
      }

      if (res.status === 200) {
        const html = await res.text();
        const found =
          html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1] ||
          html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
          html.match(/https?:\/\/(?:www\.|m\.)?tiktok\.com\/@[^"'\s<>\\]+\/(?:video|photo|story)\/\d+/i)?.[0];
        if (found) best = found.replace(/&amp;/g, "&");
      } else {
        await res.body?.cancel().catch(() => {});
      }
      break;
    } catch {
      break;
    }
  }

  try {
    const u = new URL(best);
    if (TIKTOK_CONTENT_PATH.test(u.pathname)) {
      u.search = "";
      u.hash = "";
      return u.toString();
    }
  } catch {
    // fall through
  }
  return best;
}

function absoluteTikWmUrl(u: unknown): string | null {
  if (typeof u !== "string" || !u) return null;
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith("//")) return `https:${u}`;
  return `${TIKWM_BASE}${u.startsWith("/") ? "" : "/"}${u}`;
}

function tikWmHasMedia(d: any): boolean {
  return Boolean(d && (d.play || d.hdplay || (Array.isArray(d.images) && d.images.length > 0)));
}

/**
 * GET https://www.tikwm.com/api/?url={url}  (POST form fallback). TikWM's free tier allows
 * ~1 request/second, so one rate-limited response is retried after a short pause.
 */
async function callTikWm(videoUrl: string): Promise<any | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let rateLimited = false;

    try {
      const res = await fetch(`${TIKWM_BASE}/api/?url=${encodeURIComponent(videoUrl)}&hd=1`, {
        headers: {
          "User-Agent": TIKTOK_SHORTLINK_UA,
          Accept: "application/json, text/javascript, */*; q=0.01",
        },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const json: any = await res.json();
        if (tikWmHasMedia(json?.data)) return json.data;
        if (/limit/i.test(String(json?.msg || ""))) rateLimited = true;
      }
    } catch {
      // try POST below
    }

    try {
      const form = new URLSearchParams({ url: videoUrl, hd: "1" });
      const res = await fetch(`${TIKWM_BASE}/api/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "User-Agent": DESKTOP_UA,
          Accept: "application/json, text/javascript, */*; q=0.01",
          Origin: TIKWM_BASE,
          Referer: `${TIKWM_BASE}/`,
        },
        body: form.toString(),
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const json: any = await res.json();
        if (tikWmHasMedia(json?.data)) return json.data;
        if (/limit/i.test(String(json?.msg || ""))) rateLimited = true;
      }
    } catch {
      // ignore
    }

    if (!rateLimited) break;
    await sleep(1300);
  }
  return null;
}

/**
 * Dedicated TikTok post / Story / slideshow extractor built on TikWM.
 *  - data.images present  -> mediaType "slideshow" (one image item per slide; audio exposed separately)
 *  - else data.play       -> mediaType "video"     (watermark-free MP4, plus HD when different)
 */
async function extractTikTokViaTikWm(
  canonicalUrl: string,
  originalUrl: string
): Promise<(PlatformExtractResult & { mediaType: "video" | "slideshow" }) | null> {
  const storyToVid1 = canonicalUrl.replace(/\/story\//i, "/video/");
  const storyToVid2 = originalUrl.replace(/\/story\//i, "/video/");
  const storyIdMatch =
    canonicalUrl.match(/\/story\/(\d+)/i) ||
    originalUrl.match(/\/story\/(\d+)/i) ||
    canonicalUrl.match(/\/video\/(\d+)/i) ||
    originalUrl.match(/\/video\/(\d+)/i);
  const candidates = Array.from(
    new Set(
      [
        canonicalUrl,
        storyToVid1,
        storyToVid2,
        originalUrl,
        storyIdMatch?.[1] ? `https://www.tiktok.com/@tiktok/video/${storyIdMatch[1]}` : "",
        storyIdMatch?.[1] || "",
      ].filter(Boolean)
    )
  );
  let d: any = null;
  for (const candidate of candidates) {
    d = await callTikWm(candidate);
    if (d) break;
  }
  if (!d) return null;

  const isStory =
    /\/story\//i.test(canonicalUrl) ||
    /\/story\//i.test(originalUrl) ||
    Boolean(d.is_story);
  const images: string[] = Array.isArray(d.images) ? d.images.filter(Boolean) : [];
  const isSlideshow = images.length > 0;
  const title: string = d.title || (isStory ? "TikTok Story" : isSlideshow ? "TikTok Slideshow" : "TikTok Post");

  const creator: DownloadCreator = {
    handle: d.author?.unique_id || null,
    name: d.author?.nickname || d.author?.unique_id || null,
    avatarUrl: null,
    profileUrl: d.author?.unique_id ? `https://www.tiktok.com/@${d.author.unique_id}` : null,
    verified: false,
  };
  const rawAvatar = absoluteTikWmUrl(d.author?.avatar);
  if (rawAvatar) creator.avatarUrl = buildStreamUrl(rawAvatar, `${creator.handle || "creator"}-avatar.jpg`, true);

  const rawCover = absoluteTikWmUrl(d.origin_cover || d.cover);
  let thumbnail: string | null = rawCover ? buildStreamUrl(rawCover, "thumbnail.jpg", true) : null;

  const rawMusic = absoluteTikWmUrl(typeof d.music === "string" ? d.music : d.music_info?.play);
  const media: DownloadMedia[] = [];

  if (isSlideshow) {
    images.forEach((img, idx) => {
      const full = absoluteTikWmUrl(img);
      if (!full) return;
      const preview = buildStreamUrl(full, `slide-${idx + 1}.jpg`, true);
      media.push({
        url: preview,
        rawUrl: full,
        downloadUrl: buildStreamUrl(full, safeFilename(`${title}-slide-${idx + 1}`, "jpg"), false),
        thumbnail: preview,
        type: "image",
        quality: `Slide ${idx + 1} · Full HD`,
        format: "jpg",
        width: 1080,
        height: 1440,
        aspectRatio: "vertical",
        hasAudio: false,
      });
    });
  } else {
    const sd = absoluteTikWmUrl(d.play);
    const hd = absoluteTikWmUrl(d.hdplay);
    const width = Number(d.width) || 1080;
    const height = Number(d.height) || 1920;
    const aspectRatio = computeAspectRatio(width, height, "vertical");
    const push = (raw: string, quality: string, suffix: string) =>
      media.push({
        url: buildStreamUrl(raw, safeFilename(title, "mp4"), true),
        rawUrl: raw,
        downloadUrl: buildStreamUrl(raw, safeFilename(`${title}-${suffix}`, "mp4"), false),
        thumbnail,
        type: "video",
        quality,
        format: "mp4",
        width,
        height,
        aspectRatio,
        hasAudio: true,
      });
    if (sd) {
      push(sd, isStory ? "Clean Story Video (Watermark-Free) · 1080p" : "Clean Video (Watermark-Free) · 1080p", "watermark-free");
    }
    if (hd && hd !== sd) push(hd, "Full HD · 1080p", "hd-1080p");
  }

  if (!media.length) return null;
  if (!thumbnail) thumbnail = media[0].thumbnail || media[0].url;

  return {
    title,
    caption: d.title || "",
    thumbnail,
    uploadDate: d.create_time ? new Date(Number(d.create_time) * 1000).toISOString().split("T")[0] : null,
    audioUrl: rawMusic,
    audioAvailable: Boolean(rawMusic) || !isSlideshow,
    isCarousel: isSlideshow && media.length > 1,
    creator,
    media,
    mediaType: isSlideshow ? "slideshow" : "video",
  };
}

// ============================================================================
// INSTAGRAM STORIES & HIGHLIGHTS: multi-stage public pipeline (never scrapes the login-gated HTML)
//   Stage 1  anonymous GraphQL / reels_media + public /embed/ pages
//   Stage 2  public story-downloader mirrors (POST the story/highlight URL, parse the media list)
// ============================================================================

const IG_APP_ID = "936619743392459";
const IG_GRAPHQL_HASHES = (
  process.env.IG_GRAPHQL_HASHES ||
  "452461e2dc7e6744e242663777b9d502,c9155116936e523553ea52a0d5415202,07212581b4d2482e54c1ff0302b86f01,d52c9d88452200c412f6e1304ce38612"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

interface StoryTarget {
  kind: "highlight" | "story";
  highlightId: string | null;
  username: string | null;
  storyId: string | null;
  storyMediaId: string | null;
  userId: string | null;
  canonicalUrl: string;
}

interface StoryItem {
  type: "video" | "photo";
  url: string;
  thumbnail: string | null;
  duration: number | null;
  takenAt: string | null;
}

interface StoryFetch {
  engine: string;
  items: StoryItem[];
  title?: string;
  cover?: string | null;
  creator?: Partial<DownloadCreator>;
}

/**
 * Parses /stories/<user>/<id>/, /stories/highlights/<id>/ and Base64 mobile-share links
 * (/s/aGlnaGxpZ2h0OjE4MTQ0... -> "highlight:18144533410375920").
 */
function parseStoryTarget(rawUrl: string): StoryTarget | null {
  let parsed: URL;
  try {
    parsed = new URL(decodeInstagramShareHighlight(rawUrl));
  } catch {
    return null;
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  const rawSm = parsed.searchParams.get("story_media_id"); // "<mediaId>_<userId>"
  const [smMedia, smUser] = rawSm ? rawSm.split("_") : [null, null];

  if (parts[0] === "stories" && parts[1] === "highlights" && /^\d+$/.test(parts[2] || "")) {
    return {
      kind: "highlight",
      highlightId: parts[2],
      username: null,
      storyId: null,
      storyMediaId: smMedia || null,
      userId: smUser || null,
      canonicalUrl: `https://www.instagram.com/stories/highlights/${parts[2]}/`,
    };
  }
  if (parts[0] === "stories" && parts[1] && parts[1] !== "highlights") {
    const storyId = /^\d+$/.test(parts[2] || "") ? parts[2] : smMedia || null;
    return {
      kind: "story",
      highlightId: null,
      username: parts[1],
      storyId,
      storyMediaId: smMedia || null,
      userId: smUser || null,
      canonicalUrl: `https://www.instagram.com/stories/${parts[1]}/${storyId ? `${storyId}/` : ""}`,
    };
  }
  return null;
}

/** Placeholder / chrome graphics that must never be presented as story media. */
function isPlaceholderAsset(url: string | null | undefined): boolean {
  if (!url) return true;
  if (!/^https?:\/\//i.test(url)) return true;
  const lower = url.toLowerCase();
  return (
    isGenericInstagramLogo(url) ||
    /\.(?:svg|ico|gif)(?:[?#]|$)/.test(lower) ||
    /(?:instagram[_-]?logo|brand[_-]?assets|favicon|apple-touch-icon|\/static\/|\/assets\/(?:img|images|icons?)\/|\/(?:logo|icons?)\/|sprite|placeholder|loading\.)/.test(
      lower
    )
  );
}

function bestImageUrl(node: any): string | null {
  const cands: Array<{ url?: string; width?: number }> =
    node?.image_versions2?.candidates ||
    (node?.display_resources || []).map((r: any) => ({ url: r.src, width: r.config_width })) ||
    [];
  const sorted = [...cands].filter((c) => c?.url).sort((a, b) => (b.width || 0) - (a.width || 0));
  return sorted[0]?.url || node?.display_url || null;
}

/** Understands both the legacy GraphQL reel shape and the v1 reels_media shape. */
function parseReelItems(reel: any): { items: StoryItem[]; reel: any } {
  const raw = reel?.items || (reel?.edge_highlight_reel_to_media?.edges || []).map((e: any) => e?.node) || [];
  const items: StoryItem[] = [];
  for (const node of raw) {
    if (!node) continue;
    const vids: any[] = node.video_resources || node.video_versions || [];
    const rawVid: string | undefined = vids[0]?.src || vids[0]?.url || node.video_url;
    const rawImg = bestImageUrl(node);
    const isVid = Boolean(rawVid) && Boolean(node.is_video || vids.length || node.video_url);
    const mediaUrl = isVid ? rawVid! : rawImg;
    if (!mediaUrl || isPlaceholderAsset(mediaUrl)) continue;
    const ts = node.taken_at_timestamp || node.taken_at;
    items.push({
      type: isVid ? "video" : "photo",
      url: mediaUrl,
      thumbnail: rawImg && !isPlaceholderAsset(rawImg) ? rawImg : null,
      duration: node.video_duration ? Number(node.video_duration) : null,
      takenAt: ts ? new Date(Number(ts) * 1000).toISOString().split("T")[0] : null,
    });
  }
  return { items, reel };
}

function reelToFetch(engine: string, reel: any): StoryFetch | null {
  const { items } = parseReelItems(reel);
  if (!items.length) return null;
  const u = reel?.user || reel?.owner;
  const coverRaw = reel?.cover_media?.cropped_image_version?.url;
  return {
    engine,
    items,
    title: reel?.title || undefined,
    cover: coverRaw && !isPlaceholderAsset(coverRaw) ? coverRaw : null,
    creator: u
      ? {
          handle: u.username || null,
          name: u.full_name || u.username || null,
          verified: Boolean(u.is_verified),
          avatarUrl: u.profile_pic_url || null,
          profileUrl: u.username ? `https://www.instagram.com/${u.username}/` : null,
        }
      : undefined,
  };
}

/** Stage 1a: anonymous/session GraphQL reel query + v1 reels_media. */
async function igStageGraphQL(t: StoryTarget, customCookie?: string): Promise<StoryFetch | null> {
  const rawCookie = customCookie || process.env.IG_COOKIE || process.env.INSTAGRAM_COOKIE || "";
  const igCookie = rawCookie.includes("=") ? rawCookie : rawCookie ? `sessionid=${rawCookie}` : "";
  const headers: Record<string, string> = {
    "User-Agent": INSTAGRAM_EMBED_UA,
    "x-ig-app-id": IG_APP_ID,
    Accept: "application/json",
    "X-Requested-With": "XMLHttpRequest",
    Referer: "https://www.instagram.com/",
    ...(igCookie ? { Cookie: igCookie } : {}),
  };
  const getJson = async (url: string): Promise<any | null> => {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return null;
      }
      return await res.json();
    } catch {
      return null;
    }
  };

  let targetUserId = t.userId;
  if (!targetUserId && t.username) {
    try {
      const embedRes = await fetch(`https://www.instagram.com/${encodeURIComponent(t.username)}/embed/`, {
        headers: { "User-Agent": INSTAGRAM_EMBED_UA },
        signal: AbortSignal.timeout(5000),
      });
      if (embedRes.ok) {
        const html = await embedRes.text();
        const parsedContext = parseInstagramContextJson(html);
        if (parsedContext?.context?.id) {
          targetUserId = String(parsedContext.context.id);
        }
      }
    } catch {}
  }

  const reelId = t.highlightId ? `highlight:${t.highlightId}` : targetUserId;
  for (const hash of IG_GRAPHQL_HASHES) {
    const variables = {
      reel_ids: targetUserId ? [targetUserId] : [],
      tag_names: [],
      location_ids: [],
      highlight_reel_ids: t.highlightId ? [t.highlightId] : [],
      precomposed_overlay: false,
      show_story_viewer_list: false,
    };
    if (!variables.reel_ids.length && !variables.highlight_reel_ids.length) break;
    const json = await getJson(
      `https://www.instagram.com/graphql/query/?query_hash=${hash}&variables=${encodeURIComponent(JSON.stringify(variables))}`
    );
    const reel =
      json?.data?.reels_media?.[0] || json?.data?.user?.reel || json?.data?.highlight_reel || null;
    const out = reel ? reelToFetch("graphql", reel) : null;
    if (out) return out;
  }

  if (reelId) {
    const json = await getJson(
      `https://i.instagram.com/api/v1/feed/reels_media/?reel_ids=${encodeURIComponent(reelId)}`
    );
    const reel = json?.reels?.[reelId] || json?.reels_media?.[0] || null;
    const out = reel ? reelToFetch("reels_media", reel) : null;
    if (out) return out;
  }
  return null;
}

/** Stage 1b: public /embed/ page for the story's media shortcode (login shell is detected and skipped). */
async function igStageEmbed(t: StoryTarget): Promise<StoryFetch | null> {
  const shortcodes = Array.from(
    new Set([t.storyId, t.storyMediaId].map((id) => idToShortcode(id)).filter(Boolean))
  );
  const candidates = shortcodes.flatMap((sc) => [
    `https://www.instagram.com/p/${sc}/embed/captioned/`,
    `https://www.instagram.com/p/${sc}/embed/`,
  ]);

  for (const candidate of candidates) {
    try {
      const res = await fetch(candidate, {
        headers: {
          "User-Agent": INSTAGRAM_EMBED_UA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        continue;
      }
      const html = await res.text();
      const $ = cheerio.load(html);
      const ogImage = $('meta[property="og:image"]').attr("content");
      const ogVideo =
        $('meta[property="og:video"]').attr("content") ||
        $('meta[property="og:video:secure_url"]').attr("content");
      if (
        html.includes('"LoginAndSignupPage"') ||
        (!ogVideo && !html.includes(".mp4") && (!ogImage || isPlaceholderAsset(ogImage)))
      ) {
        continue;
      }

      let video: string | null = null;
      const mp4Idx = html.indexOf(".mp4");
      if (mp4Idx !== -1) {
        const start = html.lastIndexOf("https:", mp4Idx);
        const end = html.indexOf('"', mp4Idx);
        if (start !== -1 && end > start) video = decodeEscapedUrl(html.slice(start, end));
      }
      if (!video && ogVideo) video = decodeEscapedUrl(ogVideo);
      if (video && isPlaceholderAsset(video)) video = null;

      const embedImg = $("img.EmbeddedMediaImage").first();
      let image: string | null =
        parseBestSrcsetUrl(embedImg.attr("srcset")) ||
        (embedImg.attr("src") ? decodeEscapedUrl(embedImg.attr("src")!) : null) ||
        (ogImage ? decodeEscapedUrl(ogImage) : null) ||
        (html.match(/"display_url":\s*"([^"]+)"/)?.[1] ? decodeEscapedUrl(html.match(/"display_url":\s*"([^"]+)"/)![1]) : null);
      if (image && isPlaceholderAsset(image)) image = null;

      const mediaUrl = video || image;
      if (!mediaUrl) continue;

      const user = $(".Username").text().trim().split(/\s+/)[0]?.replace(/Verified.*$/i, "") || "";
      return {
        engine: "embed",
        items: [{ type: video ? "video" : "photo", url: mediaUrl, thumbnail: image, duration: null, takenAt: null }],
        cover: image,
        creator: user
          ? { handle: user, name: user, profileUrl: `https://www.instagram.com/${user}/`, verified: false }
          : undefined,
      };
    } catch {
      // next candidate
    }
  }
  return null;
}

// ---- Stage 2: public mirrors -------------------------------------------------

interface MirrorConfig {
  name: string;
  endpoint: string;
  method?: "POST" | "GET";
  encoding?: "form" | "json";
  /** Field that carries the story/highlight URL. */
  urlField?: string;
  /** Extra static fields to send. */
  fields?: Record<string, string>;
  /** If set, this page is fetched first and its hidden <input>s (CSRF tokens etc.) are echoed back. */
  tokenPage?: string;
  referer?: string;
}

/**
 * Default public story-downloader mirrors. These third-party sites change their endpoints and
 * anti-bot tokens often; override or extend the list without touching code by setting
 * IG_MIRROR_ENDPOINTS to a JSON array of MirrorConfig objects.
 */
const DEFAULT_IG_MIRRORS: MirrorConfig[] = [
  {
    name: "sssinstagram",
    endpoint: "https://sssinstagram.com/api/convert",
    encoding: "json",
    urlField: "target_url",
    referer: "https://sssinstagram.com/",
  },
  {
    name: "indown",
    endpoint: "https://indown.io/download",
    encoding: "form",
    urlField: "link",
    tokenPage: "https://indown.io/",
    referer: "https://indown.io/",
  },
  {
    name: "snapinsta",
    endpoint: "https://snapinsta.app/action2.php",
    encoding: "form",
    urlField: "url",
    fields: { action: "post", lang: "en" },
    tokenPage: "https://snapinsta.app/",
    referer: "https://snapinsta.app/",
  },
  {
    name: "fastdl",
    endpoint: "https://fastdl.app/api/convert",
    encoding: "json",
    urlField: "target_url",
    referer: "https://fastdl.app/",
  },
];

function loadMirrorConfigs(): MirrorConfig[] {
  const raw = process.env.IG_MIRROR_ENDPOINTS;
  if (!raw) return DEFAULT_IG_MIRRORS;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length) return parsed as MirrorConfig[];
  } catch {
    // fall back to defaults
  }
  return DEFAULT_IG_MIRRORS;
}

interface RawMirrorLink {
  url: string;
  type?: "video" | "photo";
  thumb?: string | null;
}

const MIRROR_VIDEO_HINT = /\.mp4(?:[?#]|$)|video|\bmp4\b/i;
const MIRROR_IMAGE_HINT = /\.(?:jpe?g|webp|png|heic)(?:[?#]|$)|photo|image|\bjpe?g\b/i;
const MIRROR_THUMB_KEY = /thumb|cover|poster|preview|avatar|profile|logo|icon/i;

/** Explicit file extensions win over loose words like "video"/"photo". */
function guessMirrorType(hay: string): "video" | "photo" | undefined {
  if (/\.mp4(?:[?#\s]|$)/i.test(hay)) return "video";
  if (/\.(?:jpe?g|webp|png|heic)(?:[?#\s]|$)/i.test(hay)) return "photo";
  if (MIRROR_VIDEO_HINT.test(hay)) return "video";
  if (MIRROR_IMAGE_HINT.test(hay)) return "photo";
  return undefined;
}

/** Pulls candidate media links out of whatever a mirror returned (JSON, JSON-wrapped HTML, or HTML). */
function extractMirrorLinks(body: string, baseUrl: string): RawMirrorLink[] {
  const out: RawMirrorLink[] = [];
  const abs = (u: string): string | null => {
    try {
      return new URL(decodeEscapedUrl(u.trim()), baseUrl).toString();
    } catch {
      return null;
    }
  };

  const fromHtml = (html: string) => {
    const $ = cheerio.load(html);
    $("a[href], video[src], video source[src]").each((_: number, el: any) => {
      const $el = $(el);
      const href = $el.attr("href") || $el.attr("src");
      const url = href ? abs(href) : null;
      if (!url) return;
      const text = `${$el.text()} ${$el.attr("download") || ""} ${$el.attr("class") || ""} ${$el.attr("title") || ""}`;
      const tag = (el as any).tagName?.toLowerCase();
      const looksLikeDownload =
        tag !== "a" ||
        $el.attr("download") !== undefined ||
        /download|save|video|photo|image|\bhd\b/i.test(text) ||
        MIRROR_VIDEO_HINT.test(url) ||
        MIRROR_IMAGE_HINT.test(url) ||
        /cdninstagram|fbcdn/i.test(url);
      if (!looksLikeDownload) return;
      const scope = $el.closest("div, li, article, section, tr");
      const thumbRaw = scope.find("img").first().attr("src") || scope.find("video").first().attr("poster");
      const type: "video" | "photo" | undefined = tag !== "a" ? "video" : guessMirrorType(`${url} ${text}`);
      out.push({ url, type, thumb: thumbRaw ? abs(thumbRaw) : null });
    });
  };

  const walk = (node: any, key = "") => {
    if (typeof node === "string") {
      if (/<(?:a|video|source)\b/i.test(node)) {
        fromHtml(node);
      } else if (/^https?:\/\//i.test(node) && !MIRROR_THUMB_KEY.test(key)) {
        const url = abs(node);
        if (url && (MIRROR_VIDEO_HINT.test(url) || MIRROR_IMAGE_HINT.test(url) || /cdninstagram|fbcdn|download|\/get\?/i.test(url))) {
          out.push({ url, type: guessMirrorType(`${url} ${key}`) });
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((n) => walk(n, key));
    } else if (node && typeof node === "object") {
      const thumbKey = Object.keys(node).find((k) => MIRROR_THUMB_KEY.test(k) && typeof node[k] === "string");
      const before = out.length;
      for (const [k, v] of Object.entries(node)) walk(v, k);
      if (thumbKey) {
        const thumb = abs(node[thumbKey]);
        for (let i = before; i < out.length; i++) if (!out[i].thumb) out[i].thumb = thumb;
      }
    }
  };

  const trimmed = body.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      walk(JSON.parse(trimmed));
    } catch {
      fromHtml(body);
    }
  } else {
    fromHtml(body);
  }
  return out;
}

/** Resolves a mirror link whose type is unknown by asking the server for the first byte. */
async function probeMediaType(url: string): Promise<"video" | "photo" | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": DESKTOP_UA, Range: "bytes=0-0" },
      signal: AbortSignal.timeout(6000),
    });
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    await res.body?.cancel().catch(() => {});
    if (ct.startsWith("video/")) return "video";
    if (ct.startsWith("image/")) return "photo";
  } catch {
    // unknown
  }
  return null;
}

async function runMirror(cfg: MirrorConfig, targetUrl: string): Promise<StoryItem[]> {
  const fields: Record<string, string> = { ...(cfg.fields || {}) };
  const headers: Record<string, string> = {
    "User-Agent": DESKTOP_UA,
    Accept: "application/json, text/html, */*;q=0.8",
    "X-Requested-With": "XMLHttpRequest",
  };
  if (cfg.referer) {
    headers.Referer = cfg.referer;
    headers.Origin = new URL(cfg.referer).origin;
  }

  if (cfg.tokenPage) {
    try {
      const page = await fetch(cfg.tokenPage, { headers: { "User-Agent": DESKTOP_UA }, signal: AbortSignal.timeout(8000) });
      const cookie = page.headers.get("set-cookie")?.split(";")[0];
      if (cookie) headers.Cookie = cookie;
      const $ = cheerio.load(await page.text());
      $("form input[type=hidden][name]").each((_: number, el: any) => {
        const name = $(el).attr("name");
        const value = $(el).attr("value");
        if (name && value !== undefined && !(name in fields)) fields[name] = value;
      });
    } catch {
      // continue without tokens
    }
  }
  fields[cfg.urlField || "url"] = targetUrl;

  const method = cfg.method || "POST";
  let endpoint = cfg.endpoint;
  let init: RequestInit = { method, headers, signal: AbortSignal.timeout(15000) };
  if (method === "GET") {
    endpoint += (endpoint.includes("?") ? "&" : "?") + new URLSearchParams(fields).toString();
  } else if (cfg.encoding === "json") {
    headers["Content-Type"] = "application/json";
    init = { ...init, body: JSON.stringify(fields) };
  } else {
    headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
    init = { ...init, body: new URLSearchParams(fields).toString() };
  }

  const res = await fetch(endpoint, init);
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return [];
  }
  const links = extractMirrorLinks(await res.text(), endpoint);

  const seen = new Set<string>();
  const items: StoryItem[] = [];
  for (const link of links) {
    if (seen.has(link.url) || isPlaceholderAsset(link.url)) continue;
    // a thumbnail-only <img> that was picked up as a link must not become a story of its own
    if (links.some((other) => other !== link && other.thumb === link.url)) continue;
    seen.add(link.url);
    const type = link.type || (await probeMediaType(link.url));
    if (!type) continue;
    items.push({
      type,
      url: link.url,
      thumbnail: link.thumb && !isPlaceholderAsset(link.thumb) ? link.thumb : type === "photo" ? link.url : null,
      duration: null,
      takenAt: null,
    });
  }
  return items;
}

/** Stage 2: try each public mirror in order until one returns real media. */
async function igStageMirrors(t: StoryTarget): Promise<StoryFetch | null> {
  for (const cfg of loadMirrorConfigs()) {
    try {
      const items = await runMirror(cfg, t.canonicalUrl);
      if (items.length) return { engine: `mirror:${cfg.name}`, items };
    } catch {
      // next mirror
    }
  }
  return null;
}

/** Stage 3: yt-dlp scraper fallback (with optional IG_COOKIE header) */
async function igStageYtDlp(t: StoryTarget, customCookie?: string): Promise<StoryFetch | null> {
  try {
    const rawCookie = customCookie || process.env.IG_COOKIE || process.env.INSTAGRAM_COOKIE || "";
    const igCookie = rawCookie.includes("=") ? rawCookie : rawCookie ? `sessionid=${rawCookie}` : "";
    const args = ["--dump-single-json", "--no-warnings", t.canonicalUrl];
    if (igCookie) {
      args.push("--add-header", `Cookie:${igCookie}`);
    }
    const { stdout } = await execFileAsync(ytDlpPath, args, { maxBuffer: 30 * 1024 * 1024, timeout: 15000 });
    if (stdout) {
      const ytd = JSON.parse(stdout);
      const entries = Array.isArray(ytd.entries) ? ytd.entries : [ytd];
      const items: StoryItem[] = [];
      for (const entry of entries) {
        if (!entry) continue;
        const vidUrl = entry.url || entry.requested_formats?.[0]?.url || entry.formats?.find((f: any) => f.url && f.ext === "mp4")?.url;
        const thumb = entry.thumbnail || null;
        const isVid = Boolean(vidUrl && (entry.ext === "mp4" || entry.vcodec !== "none"));
        const mediaUrl = isVid ? vidUrl : (thumb || entry.url);
        if (mediaUrl && !isPlaceholderAsset(mediaUrl)) {
          items.push({
            type: isVid ? "video" : "photo",
            url: mediaUrl,
            thumbnail: thumb && !isPlaceholderAsset(thumb) ? thumb : null,
            duration: entry.duration ? Number(entry.duration) : null,
            takenAt: entry.timestamp ? new Date(entry.timestamp * 1000).toISOString().split("T")[0] : null,
          });
        }
      }
      if (items.length) {
        return {
          engine: "yt-dlp",
          items,
          title: ytd.title || (t.username ? `@${t.username}'s Story` : "Instagram Story"),
          creator: ytd.uploader ? { handle: ytd.uploader, name: ytd.uploader } : undefined,
        };
      }
    }
  } catch {}
  return null;
}

async function fetchInstagramStoryMedia(t: StoryTarget, customCookie?: string): Promise<StoryFetch | null> {
  const stages: Array<() => Promise<StoryFetch | null>> = [
    () => igStageGraphQL(t, customCookie),
    () => igStageEmbed(t),
    () => igStageMirrors(t),
    () => igStageYtDlp(t, customCookie),
  ];
  for (const stage of stages) {
    const out = await stage();
    if (out?.items.length) return out;
  }
  return null;
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
  mediaType?: "video" | "slideshow";
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
      // Strategy 1: TikTok embed page scraper (bypasses Cloudflare & datacenter IP blocks, extracts 1080p DP)
      try {
        const embedRes = await fetch(
          `https://www.tiktok.com/embed/@${encodeURIComponent(handle)}`,
          {
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
            },
            signal: AbortSignal.timeout(8000),
          }
        );
        if (embedRes.ok) {
          const html = await embedRes.text();
          const avatarMatch = html.match(
            /https:\/\/[^"'\s]+(?:avt|avatar|tiktokcdn)[^"'\s]+tplv-tiktokx-cropcenter:[^"'\s]+/i
          );
          if (avatarMatch?.[0]) {
            const rawAvatar = avatarMatch[0].replace(/&amp;/g, "&");
            const hdAvatar = rawAvatar.replace(/cropcenter:\d+:\d+/, "cropcenter:1080:1080");
            creator.handle = handle;
            creator.name = handle;
            creator.profileUrl = `https://www.tiktok.com/@${handle}`;
            const proxiedAvatar = buildStreamUrl(hdAvatar, `${handle}-avatar.jpg`, true);
            creator.avatarUrl = proxiedAvatar;
            thumbnail = proxiedAvatar;
            title = `${handle} (@${handle})`;
            media.push({
              url: proxiedAvatar,
              rawUrl: hdAvatar,
              downloadUrl: buildStreamUrl(hdAvatar, `${handle}-profile-photo.jpg`, false),
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
        // Fallback to TikWM user info below
      }

      if (media.length === 0) {
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

  // Strategy A: dedicated TikTok unshortener + TikWM public API (videos, Stories, slideshows)
  const canonicalUrl = await unshortenTikTok(targetUrl);
  const viaTikWm = await extractTikTokViaTikWm(canonicalUrl, targetUrl);
  if (viaTikWm) return viaTikWm;
  targetUrl = canonicalUrl;

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
  profileHandle: string | null,
  customCookie?: string
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

  // 0. Story / Highlight Mode
  const storyTarget = parseStoryTarget(targetUrl);
  if (storyTarget) {
    const fetched = await fetchInstagramStoryMedia(storyTarget, customCookie);
    if (fetched && fetched.items.length) {
      const storyTitle =
        fetched.title ||
        (storyTarget.kind === "highlight" ? "Instagram Highlight" : `@${storyTarget.username}'s Story`);
      creator.handle = fetched.creator?.handle || storyTarget.username || creator.handle;
      creator.name = fetched.creator?.name || creator.handle;
      creator.verified = Boolean(fetched.creator?.verified);
      creator.profileUrl = creator.handle ? `https://www.instagram.com/${creator.handle}/` : null;
      if (fetched.creator?.avatarUrl) {
        creator.avatarUrl = buildStreamUrl(fetched.creator.avatarUrl, `${creator.handle || "creator"}-avatar.jpg`, true);
      }
      fetched.items.forEach((it, idx) => {
        const n = idx + 1;
        const isVid = it.type === "video";
        const ext = isVid ? "mp4" : "jpg";
        const streamUrl = buildStreamUrl(it.url, `story-${n}.${ext}`, true);
        const dlUrl = buildStreamUrl(it.url, safeFilename(`${storyTitle}-story-${n}`, ext), false);
        const thumb = it.thumbnail
          ? buildStreamUrl(it.thumbnail, `story-thumb-${n}.jpg`, true)
          : isVid
          ? null
          : streamUrl;
        media.push({
          url: streamUrl,
          rawUrl: it.url,
          downloadUrl: dlUrl,
          thumbnail: thumb,
          type: isVid ? "video" : "image",
          quality: isVid ? `Story Video ${n} · HD` : `Story Photo ${n} · HD`,
          format: ext,
          width: 1080,
          height: 1920,
          aspectRatio: "vertical",
          hasAudio: isVid,
        });
        if (isVid) {
          audioAvailable = true;
          if (!audioUrl) audioUrl = it.url;
        }
      });
      return {
        title: storyTitle,
        caption: `Instagram Story / Highlight (${media.length} items)`,
        thumbnail: media[0]?.thumbnail || media[0]?.url || null,
        uploadDate: fetched.items[0]?.takenAt || null,
        audioUrl,
        audioAvailable,
        isCarousel: media.length > 1,
        creator,
        media,
      };
    }
  }

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

        // Reel MP4 Video Scan from Embed HTML
        if ((isReel || targetUrl.includes("/reel/") || html.includes(".mp4")) && media.every((m) => m.type !== "video")) {
          const mp4Idx = html.indexOf(".mp4");
          if (mp4Idx !== -1) {
            const start = html.lastIndexOf("https:", mp4Idx);
            const end = html.indexOf('"', mp4Idx);
            if (start !== -1 && end !== -1 && end > start) {
              let raw = html.slice(start, end);
              try {
                raw = JSON.parse(`"${raw}"`);
              } catch {
                raw = raw.replace(/\\\//g, "/").replace(/\\u0026/g, "&").replace(/\\/g, "");
              }
              if (isAuthenticStoryMedia(raw)) {
                const proxiedVid = buildStreamUrl(raw, safeFilename(title || "instagram-reel", "mp4"), true);
                const dlVid = buildStreamUrl(raw, safeFilename(title || "instagram-reel", "mp4"), false);
                media.unshift({
                  url: proxiedVid,
                  rawUrl: raw,
                  downloadUrl: dlVid,
                  thumbnail: thumbnail || proxiedVid,
                  type: "video",
                  quality: "Full HD · 1080p",
                  format: "mp4",
                  width: 1080,
                  height: 1920,
                  aspectRatio: "vertical",
                  hasAudio: true,
                });
                audioAvailable = true;
                audioUrl = raw;
              }
            }
          }
        }
      }
    } catch {
      // Fallback below
    }
  }

  // Fallback: yt-dlp scraper for Instagram Reels if video is missing
  if (media.length === 0 || (isReel && media.every((m) => m.type !== "video"))) {
    try {
      const { stdout } = await execFileAsync(
        ytDlpPath,
        ["--dump-single-json", "--no-warnings", targetUrl],
        { maxBuffer: 30 * 1024 * 1024, timeout: 15000 }
      );
      if (stdout) {
        const ytd = JSON.parse(stdout);
        const vidUrl = ytd.url || ytd.requested_formats?.[0]?.url || ytd.formats?.find((f: any) => f.url && f.ext === "mp4")?.url;
        if (vidUrl) {
          const proxiedVid = buildStreamUrl(vidUrl, safeFilename(title || ytd.title || "instagram-reel", "mp4"), true);
          const dlVid = buildStreamUrl(vidUrl, safeFilename(title || ytd.title || "instagram-reel", "mp4"), false);
          media.unshift({
            url: proxiedVid,
            rawUrl: vidUrl,
            downloadUrl: dlVid,
            thumbnail: ytd.thumbnail ? buildStreamUrl(ytd.thumbnail, "thumb.jpg", true) : thumbnail,
            type: "video",
            quality: "Full HD · 1080p",
            format: "mp4",
            width: ytd.width || 1080,
            height: ytd.height || 1920,
            aspectRatio: "vertical",
            hasAudio: true,
          });
          audioAvailable = true;
          audioUrl = vidUrl;
          if (!title || title === "Instagram Post") title = ytd.title || title;
          if (!caption) caption = ytd.description || "";
        }
      }
    } catch {}
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

function getYtDlpCookieArgs(): string[] {
  const ytCookie = process.env.YOUTUBE_COOKIE || process.env.YT_COOKIE || "";
  if (ytCookie) {
    const tmpCookiePath = "/tmp/omni-yt-cookie.txt";
    try {
      fs.writeFileSync(tmpCookiePath, ytCookie);
      return ["--cookies", tmpCookiePath];
    } catch {}
  }
  if (fs.existsSync("./cookies.txt")) {
    return ["--cookies", "./cookies.txt"];
  }
  return [];
}

// ============================================================================
// YOUTUBE EXTRACTOR (Videos, Shorts, 4K/1440p/1080p/720p/480p, MP3 Audio & Channel DP)
// ============================================================================

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
    const cookieArgs = getYtDlpCookieArgs();

    // Strategy A: Full progressive/merged format extraction via standard yt-dlp (up to 4K / 2160p)
    try {
      const { stdout } = await execFileAsync(
        ytDlpPath,
        ["--dump-single-json", "--no-warnings", ...cookieArgs, targetUrl],
        { maxBuffer: 50 * 1024 * 1024, timeout: 20000 }
      );
      if (stdout) {
        ytData = JSON.parse(stdout);
      }
    } catch {
      // Strategy B: yt-dlp with android player client for clean bot bypass fallback
      try {
        const { stdout } = await execFileAsync(
          ytDlpPath,
          [
            "--dump-single-json",
            "--no-warnings",
            "--extractor-args",
            "youtube:player_client=android",
            ...cookieArgs,
            targetUrl,
          ],
          { maxBuffer: 50 * 1024 * 1024, timeout: 20000 }
        );
        if (stdout) {
          ytData = JSON.parse(stdout);
        }
      } catch {
        // Strategy C: yt-dlp with android,web client
        try {
          const { stdout } = await execFileAsync(
            ytDlpPath,
            [
              "--dump-single-json",
              "--no-warnings",
              "--extractor-args",
              "youtube:player_client=android,web",
              ...cookieArgs,
              targetUrl,
            ],
            { maxBuffer: 50 * 1024 * 1024, timeout: 20000 }
          );
          if (stdout) {
            ytData = JSON.parse(stdout);
          }
        } catch {}
      }
    }

    // Strategy D: Public Invidious / Piped API fallback
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

      const rawFormats: any[] = ytData.formats || ytData.formatStreams || [];
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

      const previewStreamUrl = progressiveFormat?.url || rawFormats.find((f) => f.url && f.vcodec !== "none")?.url || targetUrl;

      // Extract available heights or default ladder
      const heightsFound = rawFormats
        .map((f: any) => f.height || 0)
        .filter((h: number) => h > 0);
      const maxHeight = heightsFound.length > 0 ? Math.max(...heightsFound) : 1080;

      // Query yt-dlp format list properly to extract all progressive/merged video streams: 4K (2160p), 1440p, 1080p, 720p, 480p, 360p
      const targetHeights = [2160, 1440, 1080, 720, 480, 360].filter(
        (h) => h <= maxHeight || h === 720 || h === 360
      );
      if (maxHeight >= 1080 && !targetHeights.includes(1080)) {
        targetHeights.push(1080);
      }
      targetHeights.sort((a, b) => b - a);

      targetHeights.forEach((h, idx) => {
        let qName = `${h}p`;
        if (h >= 2160) qName = "4K · 2160p";
        else if (h >= 1440) qName = "QHD · 1440p";
        else if (h >= 1080) qName = "Full HD · 1080p";
        else if (h >= 720) qName = "HD · 720p";
        else if (h >= 480) qName = "SD · 480p";
        else qName = "SD · 360p";

        const width = isShorts
          ? (h === 2160 ? 1215 : h === 1440 ? 810 : h === 1080 ? 608 : h === 720 ? 405 : 270)
          : (h === 2160 ? 3840 : h === 1440 ? 2560 : h === 1080 ? 1920 : h === 720 ? 1280 : 854);

        media.push({
          url: buildStreamUrl(previewStreamUrl, safeFilename(`${title}-${h}p`, "mp4"), true),
          rawUrl: targetUrl,
          downloadUrl: `/api/download?downloadId=pending&format=mp4&assetType=media&mediaIndex=${idx}`,
          thumbnail,
          type: "video",
          quality: qName,
          format: "mp4",
          width,
          height: h,
          aspectRatio: computeAspectRatio(width, h, defaultAspect),
          hasAudio: true,
        });
      });

      audioAvailable = true;
      audioUrl = targetUrl;
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

        const targetLadder = [1080, 720, 480, 360];
        targetLadder.forEach((h, idx) => {
          let qName = `${h}p`;
          if (h >= 1080) qName = "Full HD · 1080p";
          else if (h >= 720) qName = "HD · 720p";
          else if (h >= 480) qName = "SD · 480p";
          else qName = "SD · 360p";

          const width = h === 1080 ? 1920 : h === 720 ? 1280 : 854;

          media.push({
            url: buildStreamUrl(targetUrl, safeFilename(`${title}-${h}p`, "mp4"), true),
            rawUrl: targetUrl,
            downloadUrl: `/api/download?downloadId=pending&format=mp4&assetType=media&mediaIndex=${idx}`,
            thumbnail,
            type: "video",
            quality: qName,
            format: "mp4",
            width,
            height: h,
            aspectRatio: "horizontal",
            hasAudio: true,
          });
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
    const { url: rawInput, mode: requestedMode = "post", platform: requestedPlatform, cookie: userCookie } = req.body;

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
      extracted = await extractInstagram(targetUrl, isProfile, detectedHandle, userCookie);
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
    extracted.media = extracted.media.map((m) => ({
      ...m,
      downloadUrl: m.downloadUrl && m.downloadUrl.includes("downloadId=pending")
        ? m.downloadUrl.replace("downloadId=pending", `downloadId=${downloadId}`)
        : m.downloadUrl,
    }));
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
      mediaType: extracted.mediaType,
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
    const { url: rawUrl, cookie: userCookie } = req.body;

    if (!rawUrl || typeof rawUrl !== "string") {
      res.status(400).json({ error: "Paste an Instagram Story or Highlight link." });
      return;
    }

    let normalized = rawUrl.trim();
    if (!normalized.includes("://")) normalized = `https://${normalized}`;
    const resolvedUrl = await resolveShortUrl(normalized);

    if (detectPlatform(resolvedUrl) !== "instagram") {
      res.status(400).json({ error: "Instagram Stories and Highlights links are supported here." });
      return;
    }

    const target = parseStoryTarget(resolvedUrl);
    if (!target) {
      res.status(400).json({
        error:
          "Paste an Instagram Story (/stories/username/…) or Highlight (/stories/highlights/… or /s/…) link.",
      });
      return;
    }

    const downloadId = uuidv4().replace(/-/g, "");
    let title = target.kind === "highlight" ? "Instagram Highlight" : `@${target.username}'s Story`;
    const creator: DownloadCreator = {
      handle: target.username,
      name: target.username,
      avatarUrl: null,
      profileUrl: target.username ? `https://www.instagram.com/${target.username}/` : null,
      verified: false,
    };

    const fetched = await fetchInstagramStoryMedia(target, userCookie);

    if (!fetched) {
      const fallbackResponse: HighlightResult = {
        downloadId,
        title,
        cover: null,
        creator,
        stories: [],
        truncated: false,
        requiresDirectLinkAlert: true,
        alertMessage:
          "This story or highlight is private, expired, or temporarily unavailable. Make sure the creator's account is public and active.",
      };
      res.json(fallbackResponse);
      return;
    }

    if (fetched.title) title = fetched.title;
    if (fetched.creator) {
      const c = fetched.creator;
      creator.handle = c.handle || creator.handle;
      creator.name = c.name || creator.name || creator.handle;
      creator.verified = Boolean(c.verified);
      creator.profileUrl = c.profileUrl || creator.profileUrl;
      if (c.avatarUrl) {
        creator.avatarUrl = buildStreamUrl(c.avatarUrl, `${creator.handle || "creator"}-avatar.jpg`, true);
      }
    }

    const stories: HighlightStory[] = [];
    const media: DownloadMedia[] = [];
    const today = new Date().toISOString().split("T")[0];

    fetched.items
      .filter((it) => !isPlaceholderAsset(it.url))
      .forEach((it, idx) => {
        const n = idx + 1;
        const isVid = it.type === "video";
        const ext = isVid ? "mp4" : "jpg";
        const streamUrl = buildStreamUrl(it.url, `story-${n}.${ext}`, true);
        const dlUrl = buildStreamUrl(it.url, safeFilename(`${title}-story-${n}`, ext), false);
        const thumb = it.thumbnail
          ? buildStreamUrl(it.thumbnail, `story-thumb-${n}.jpg`, true)
          : isVid
          ? null
          : streamUrl;

        stories.push({
          storyNumber: n,
          mediaIndex: idx,
          type: it.type,
          duration: it.duration ?? (isVid ? 15 : null),
          thumbnail: thumb,
          createdAt: it.takenAt || today,
          url: streamUrl,
          downloadUrl: dlUrl,
        });
        media.push({
          url: streamUrl,
          rawUrl: it.url,
          downloadUrl: dlUrl,
          thumbnail: thumb,
          type: isVid ? "video" : "image",
          quality: isVid ? "Direct CDN video · MP4" : "Direct CDN photo · High-res",
          format: ext,
          width: 1080,
          height: 1920,
          aspectRatio: "vertical",
          hasAudio: isVid,
        });
      });

    if (stories.length === 0) {
      res.json({
        downloadId,
        title,
        cover: null,
        creator,
        stories: [],
        truncated: false,
        requiresDirectLinkAlert: true,
        alertMessage:
          "This story or highlight is private, expired, or temporarily unavailable. Make sure the creator's account is public and active.",
      } satisfies HighlightResult);
      return;
    }

    const cover =
      fetched.cover && !isPlaceholderAsset(fetched.cover)
        ? buildStreamUrl(fetched.cover, "cover.jpg", true)
        : stories.find((s) => s.thumbnail)?.thumbnail || null;

    resultCache.set(downloadId, {
      createdAt: Date.now(),
      sourceUrl: target.canonicalUrl,
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
      cover,
      creator,
      stories,
      truncated: false,
      requiresDirectLinkAlert: false,
      source: fetched.engine,
    };
    res.json(responseData);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to extract highlight";
    res.status(500).json({ error: message });
  }
});

async function handleDownload(req: Request, res: Response) {
  try {
    pruneCache();
    const payload = req.method === "POST" ? req.body : req.query;
    const {
      downloadId,
      url: directUrl,
      filename,
      assetType,
      mediaIndex,
      format,
      items,
      platform: directPlatform,
      title: directTitle,
    } = payload;

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

    if (isGenericInstagramLogo(targetUrl)) {
      res.status(400).json({ error: "Cannot download static logo assets. Story media is not directly downloadable." });
      return;
    }

    const platform =
      cached?.platform ||
      (directPlatform as Platform) ||
      (targetUrl ? detectPlatform(targetUrl) : null);
    const resolvedTitle = cached?.title || directTitle || "omnidownloader-media";
    const downloadName = filename || safeFilename(resolvedTitle, fallbackExt);
    const cleanBase = downloadName.replace(/[^\w.\- ]+/g, "_");

    if (
      platform === "youtube" ||
      targetUrl.includes("youtube.com") ||
      targetUrl.includes("youtu.be")
    ) {
      let sourceVideoUrl = cached?.sourceUrl || targetUrl;
      try {
        const u = new URL(sourceVideoUrl);
        const vId =
          u.searchParams.get("v") ||
          (u.pathname.includes("/shorts/")
            ? u.pathname.split("/shorts/")[1]?.split(/[/?#]/)[0]
            : "");
        if (vId) {
          sourceVideoUrl = `https://www.youtube.com/watch?v=${vId}`;
        }
      } catch {}

      if (assetType === "audio" || format === "mp3") {
        const cleanName = cleanBase.endsWith(".mp3") ? cleanBase : `${cleanBase.replace(/\.[^/.]+$/, "")}.mp3`;
        const tmpAudioPath = `/tmp/omni-audio-${uuidv4()}.mp3`;

        const cookieArgs = getYtDlpCookieArgs();
        try {
          await execFileAsync(
            ytDlpPath,
            [
              "-f",
              "bestaudio/best",
              "-x",
              "--audio-format",
              "mp3",
              "--audio-quality",
              "320k",
              "--ffmpeg-location",
              "/usr/bin/ffmpeg",
              "--extractor-args",
              "youtube:player_client=android,web",
              "--no-warnings",
              "--no-progress",
              ...cookieArgs,
              "-o",
              tmpAudioPath,
              sourceVideoUrl,
            ],
            { timeout: 180000, maxBuffer: 50 * 1024 * 1024 }
          );

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
        } catch (ytAudioErr) {
          try {
            if (fs.existsSync(tmpAudioPath)) fs.unlinkSync(tmpAudioPath);
          } catch {}
          const isBot = String(ytAudioErr).includes("bot") || String(ytAudioErr).includes("Sign in");
          res.status(502).json({
            error: isBot
              ? "YouTube requires verification on this server. Please provide a YOUTUBE_COOKIE in settings, or download from TikTok, Instagram, or Pinterest."
              : "Could not convert YouTube audio. Please try downloading the video instead.",
          });
          return;
        }
      }

      if (assetType === "media" || !assetType) {
        const idx = mediaIndex != null ? Number(mediaIndex) : 0;
        const mediaItem = cached?.media[idx] || cached?.media[0];
        const targetHeight = mediaItem?.height || 1080;
        const cleanName = cleanBase.endsWith(".mp4") ? cleanBase : `${cleanBase.replace(/\.[^/.]+$/, "")}.mp4`;
        const tmpVideoPath = `/tmp/omni-vid-${uuidv4()}.mp4`;
        const cookieArgs = getYtDlpCookieArgs();

        const formatSpec = targetHeight
          ? `bestvideo[height<=${targetHeight}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${targetHeight}]+bestaudio/best[height<=${targetHeight}][ext=mp4]/best[ext=mp4]/best`
          : `bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best[ext=mp4]/best`;

        let lastDlErr: any = null;
        try {
          await execFileAsync(
            ytDlpPath,
            [
              "-f",
              formatSpec,
              "--merge-output-format",
              "mp4",
              "--ffmpeg-location",
              "/usr/bin/ffmpeg",
              "--extractor-args",
              "youtube:player_client=android,web",
              "--no-warnings",
              "--no-progress",
              ...cookieArgs,
              "-o",
              tmpVideoPath,
              sourceVideoUrl,
            ],
            { timeout: 180000, maxBuffer: 50 * 1024 * 1024 }
          );

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
        } catch (err) {
          lastDlErr = err;
          // Robust fallback: download best progressive mp4 format directly
          try {
            await execFileAsync(
              ytDlpPath,
              [
                "-f",
                "18/22/best[ext=mp4]/best",
                "--ffmpeg-location",
                "/usr/bin/ffmpeg",
                "--extractor-args",
                "youtube:player_client=android,web",
                "--no-warnings",
                "--no-progress",
                ...cookieArgs,
                "-o",
                tmpVideoPath,
                sourceVideoUrl,
              ],
              { timeout: 180000, maxBuffer: 50 * 1024 * 1024 }
            );

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
          } catch (fbErr) {
            lastDlErr = fbErr;
          }

          try {
            if (fs.existsSync(tmpVideoPath)) fs.unlinkSync(tmpVideoPath);
          } catch {}
          const isBot = String(lastDlErr).includes("bot") || String(lastDlErr).includes("Sign in");
          res.status(502).json({
            error: isBot
              ? "YouTube requires verification on this server. Please provide a YOUTUBE_COOKIE in settings, or download from TikTok, Instagram, or Pinterest."
              : "Could not download YouTube video. Please try another quality option.",
          });
          return;
        }
      }
    }

    // Pure MP3 audio extraction for non-YouTube video sources
    if (assetType === "audio" || format === "mp3" || downloadName.endsWith(".mp3")) {
      const cleanAudioName = cleanBase.endsWith(".mp3")
        ? cleanBase
        : `${cleanBase.replace(/\.[^/.]+$/, "")}.mp3`;
      const tmpRawPath = `/tmp/omni-raw-${uuidv4()}.mp4`;
      const tmpFfmpegAudio = `/tmp/omni-audio-${uuidv4()}.mp3`;

      try {
        if (
          (platform === "tiktok" || targetUrl.includes("tiktok.com")) &&
          !targetUrl.includes(".mp3") &&
          !targetUrl.includes("tiktokcdn.com")
        ) {
          try {
            const freshData = await callTikWm(cached?.sourceUrl || targetUrl);
            const freshAudio = absoluteTikWmUrl(freshData?.music || freshData?.play || freshData?.hdplay);
            if (freshAudio) {
              targetUrl = freshAudio;
            }
          } catch {}
        }

        const parsedTarget = new URL(targetUrl);
        const referer = parsedTarget.hostname.includes("tiktok")
          ? "https://www.tiktok.com/"
          : parsedTarget.hostname.includes("instagram") || parsedTarget.hostname.includes("fbcdn")
          ? "https://www.instagram.com/"
          : parsedTarget.origin;

        let upstreamRes = await fetch(targetUrl, {
          headers: {
            "User-Agent": DESKTOP_UA,
            Referer: referer,
          },
          signal: AbortSignal.timeout(30000),
        });

        if (
          (upstreamRes.status === 403 || !upstreamRes.ok || upstreamRes.headers.get("content-type")?.includes("text/html")) &&
          (cached?.sourceUrl || targetUrl.includes("tiktok"))
        ) {
          try {
            const freshData = await callTikWm(cached?.sourceUrl || targetUrl);
            const freshPlay = absoluteTikWmUrl(freshData?.music || freshData?.play || freshData?.hdplay);
            if (freshPlay) {
              upstreamRes = await fetch(freshPlay, {
                headers: { "User-Agent": DESKTOP_UA, Referer: "https://www.tiktok.com/" },
                signal: AbortSignal.timeout(30000),
              });
            }
          } catch {}
        }

        if (!upstreamRes.ok) {
          throw new Error("Could not download upstream media for audio extraction");
        }

        const arrayBuf = await upstreamRes.arrayBuffer();
        fs.writeFileSync(tmpRawPath, Buffer.from(arrayBuf));

        await execFileAsync("/usr/bin/ffmpeg", [
          "-i",
          tmpRawPath,
          "-vn",
          "-acodec",
          "libmp3lame",
          "-b:a",
          "320k",
          "-y",
          tmpFfmpegAudio,
        ]);

        if (fs.existsSync(tmpFfmpegAudio)) {
          const stat = fs.statSync(tmpFfmpegAudio);
          res.setHeader("Content-Type", "audio/mpeg");
          res.setHeader("Content-Length", stat.size);
          res.setHeader("Content-Disposition", `attachment; filename="${cleanAudioName}"`);
          const fileStream = fs.createReadStream(tmpFfmpegAudio);
          fileStream.pipe(res);
          const cleanup = () => {
            try {
              if (fs.existsSync(tmpRawPath)) fs.unlinkSync(tmpRawPath);
              if (fs.existsSync(tmpFfmpegAudio)) fs.unlinkSync(tmpFfmpegAudio);
            } catch {}
          };
          fileStream.on("close", cleanup);
          fileStream.on("error", cleanup);
          return;
        }
      } catch {
        try {
          if (fs.existsSync(tmpRawPath)) fs.unlinkSync(tmpRawPath);
          if (fs.existsSync(tmpFfmpegAudio)) fs.unlinkSync(tmpFfmpegAudio);
        } catch {}
        res.status(502).json({ error: "Could not extract MP3 audio from this media. Please try downloading the video instead." });
        return;
      }
    }

    const parsedTarget = new URL(targetUrl);
    const referer = parsedTarget.hostname.includes("tiktok")
      ? "https://www.tiktok.com/"
      : parsedTarget.hostname.includes("instagram") || parsedTarget.hostname.includes("fbcdn")
      ? "https://www.instagram.com/"
      : parsedTarget.origin;

    let mediaFetch = await fetch(targetUrl, {
      headers: {
        "User-Agent": DESKTOP_UA,
        Referer: referer,
      },
      signal: AbortSignal.timeout(25000),
    });

    if (
      mediaFetch.status === 403 &&
      cached?.sourceUrl &&
      (targetUrl.includes("tiktokcdn") || targetUrl.includes("tiktok"))
    ) {
      try {
        const freshData = await callTikWm(cached.sourceUrl);
        const freshPlay = freshData?.play || freshData?.hdplay;
        if (freshPlay) {
          mediaFetch = await fetch(freshPlay, {
            headers: {
              "User-Agent": DESKTOP_UA,
              Referer: "https://www.tiktok.com/",
            },
            signal: AbortSignal.timeout(25000),
          });
        }
      } catch {}
    }

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
}

app.post("/api/download", handleDownload);
app.get("/api/download", handleDownload);

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
