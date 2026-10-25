# OmniDownloader

Ad-free, streamlined media downloader for public Instagram, TikTok, and Pinterest posts you are authorized to keep.

## Features

- **Public Link Support**: Extract videos, photos, carousels, and profile photos from public Instagram, TikTok, and Pinterest links.
- **Instagram Stories & Highlights**: View and download available stories from public highlights.
- **Resolution & Format Selection**: Choose video resolutions, original image or WebP format, and MP3 audio bitrates.
- **Batch Archiving**: Download all listed highlight stories as a single ZIP archive.
- **Privacy & Permissions**: Dedicated exclusively to public media with clear permission reminders and no intrusive ads or redirects.

## Tech Stack

- **Frontend**: React 18, TypeScript, Tailwind CSS, TanStack Query, Framer Motion, Lucide React
- **Backend / Server**: Express, Cheerio, Archiver, Node.js
- **Tooling**: Vite

## Stories, Highlights & TikTok Stories (public mirror pipeline)

Instagram Stories/Highlights and TikTok Stories sit behind login gates, so the HTML is never scraped.
The same pipeline exists in `server.ts` and `artifacts/api-server/main.py`:

**TikTok** (`vt.tiktok.com/ZS…`, `vm.tiktok.com/…`, `/t/…`, `/story/`, `/photo/`)
1. Shortlinks are followed hop-by-hop with the mobile UA `Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X)`
   to the canonical `tiktok.com/@user/(video|photo|story)/<id>` URL (geo/login redirect traps are ignored).
2. `GET https://www.tikwm.com/api/?url={canonical}` (POST fallback, one retry on TikWM's 1 req/s limit).
   `data.images` → `mediaType: "slideshow"` (photo slides); otherwise `data.play` → `mediaType: "video"`
   (watermark-free MP4 shown in the player, plus HD when different).

**Instagram** (`/stories/<user>/<id>/`, `/stories/highlights/<id>/`, Base64 `/s/aGlnaGxpZ2h0OjE4…` links)
1. `/s/` tokens are Base64-decoded (URL-safe, padded) to the numeric highlight id.
2. Stage 1: anonymous GraphQL reel query + `reels_media`, then the public `/embed/` page (login shells are detected and skipped).
3. Stage 2: public story-downloader mirrors (the story/highlight URL is POSTed; the media list is parsed from the JSON/HTML reply).
4. Placeholder graphics (`instagram_logo`, `brand_assets`, favicons, sprites, `.svg`/`.ico`) are filtered out.
   The API returns `stories[]` with direct `.mp4`/`.jpg` URLs; the UI mounts them immediately with an active
   preview, per-story **Download** and **Download All (ZIP)**. `source` in the response says which stage succeeded.

Third-party mirrors change endpoints and anti-bot tokens frequently. To swap or add one without code changes:

```bash
IG_MIRROR_ENDPOINTS='[{"name":"mine","endpoint":"https://example.com/api/story","encoding":"json","urlField":"url","referer":"https://example.com/"}]'
IG_GRAPHQL_HASHES="hash1,hash2"      # optional GraphQL query_hash overrides
TIKWM_BASE="https://www.tikwm.com"   # optional TikWM base URL
```
Mirror fields: `name`, `endpoint`, `method` (`POST`|`GET`), `encoding` (`json`|`form`), `urlField`, `fields`, `tokenPage` (hidden inputs are echoed back), `referer`.
