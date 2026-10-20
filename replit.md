# Social Media Downloader

Ad-free downloads for public TikTok, Instagram, and Pinterest media that users are authorized to save.

## Run & Operate

- `uv run python -m uvicorn main:app --app-dir artifacts/api-server --host 0.0.0.0 --port 8080 --reload` — run the FastAPI service
- `pnpm --filter @workspace/social-media-downloader run dev` — run the web app
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- Required media tools: Python 3.11, yt-dlp, gallery-dl, and ffmpeg

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: FastAPI on Python 3.11
- Validation: Pydantic on the API; OpenAPI/Orval-generated TypeScript clients
- Web: React + Vite
- API runtime: Uvicorn

## Where things live

- `artifacts/social-media-downloader/` — React + Vite downloader UI
- `artifacts/api-server/main.py` — FastAPI media extraction API
- `lib/api-spec/openapi.yaml` — API contract source of truth

## Architecture decisions

- The downloader processes public links only and does not use account cookies, bypass private-account controls, or remove watermarks.
- Video formats are returned only when a direct MP4 source is available; gallery-dl is used for image posts and carousels.

## Product

Paste a supported public social-media link to retrieve a preview and direct media download links. No account or ad network is used.

## User preferences

Keep the product ad-free and avoid popup ads, fake controls, and intermediary redirect sites.

## Gotchas

- Source URLs are provided by the platforms and may expire; rerun extraction if a link stops working.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
