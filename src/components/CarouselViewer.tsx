import {
  ArrowDownToLine,
  BadgeCheck,
  Check,
  ChevronLeft,
  ChevronRight,
  Image as ImageIcon,
  UserRound,
  Video,
} from 'lucide-react';
import type { DownloadMedia, DownloadResult } from '../types/api';
import { CupertinoPlayer } from './CupertinoPlayer';

export interface CarouselViewerProps {
  result: DownloadResult;
  activeIndex: number;
  onSelectSlide: (index: number) => void;
  onDownloadSlide: (index: number) => void;
  downloadStatus?: 'loading' | 'done' | 'error';
}

export function CarouselViewer({
  result,
  activeIndex,
  onSelectSlide,
  onDownloadSlide,
  downloadStatus,
}: CarouselViewerProps) {
  const mediaItems = result.media ?? [];
  const activeMedia: DownloadMedia | undefined = mediaItems[activeIndex];
  const isProfileResult = result.type === 'profile' || activeMedia?.type === 'profile';
  const isCarousel = result.type === 'carousel' && mediaItems.length > 1;
  const isImage = activeMedia?.type === 'image' || activeMedia?.type === 'profile';
  const previewUrl = isImage
    ? activeMedia?.url || result.creator.avatarUrl || result.thumbnail
    : result.thumbnail;

  if (isProfileResult) {
    return (
      <div
        className="flex flex-col items-center justify-center py-6 px-4 text-center w-full"
        data-testid="preview-profile-dp"
      >
        <div className="relative group">
          <div className="absolute -inset-3 rounded-full bg-gradient-to-tr from-[#a9c2ff]/30 via-[#d4c4ff]/20 to-transparent blur-2xl pointer-events-none" />
          <div className="relative w-44 h-44 rounded-full overflow-hidden ring-4 ring-white/15 shadow-2xl bg-black/80 flex items-center justify-center">
            {previewUrl ? (
              <img
                src={previewUrl}
                alt={`${result.creator.name || result.creator.handle || 'User'} HD profile avatar`}
                referrerPolicy="no-referrer"
                className="w-full h-full object-cover"
                data-testid="img-preview"
              />
            ) : (
              <UserRound size={52} className="text-white/40" />
            )}
          </div>
        </div>

        <div className="mt-5">
          <div className="inline-flex items-center gap-1.5 text-base font-semibold text-white">
            <span>{result.creator.name || result.creator.handle || result.title}</span>
            {result.creator.verified && (
              <BadgeCheck size={16} color="#9bd9b7" aria-label="Verified creator" />
            )}
          </div>
          {result.creator.handle && (
            <div className="text-xs text-[#989da5] mt-0.5">
              @{result.creator.handle.replace(/^@/, '')}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => onDownloadSlide(0)}
          disabled={downloadStatus === 'loading'}
          className="download-button mt-5 max-w-[260px]"
          data-testid="button-download-hd-dp"
        >
          {downloadStatus === 'loading' ? (
            <>
              <span className="loader" /> Preparing HD photo
            </>
          ) : downloadStatus === 'done' ? (
            <>
              <Check size={15} /> HD Profile Photo Saved
            </>
          ) : (
            <>
              Download HD Profile Photo <ArrowDownToLine size={15} />
            </>
          )}
        </button>
      </div>
    );
  }

  return (
    <div className="w-full flex flex-col items-center">
      {activeMedia?.type === 'video' ? (
        <div className="w-full relative">
          <CupertinoPlayer
            src={activeMedia.url}
            poster={activeMedia.thumbnail || result.thumbnail}
            title={result.title}
            initialAspectRatio={activeMedia.aspectRatio}
          />
          {isCarousel && (
            <>
              <button
                type="button"
                onClick={() =>
                  onSelectSlide((activeIndex - 1 + mediaItems.length) % mediaItems.length)
                }
                aria-label="Previous slide"
                className="absolute left-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/65 backdrop-blur-xl border border-white/20 text-white flex items-center justify-center hover:bg-black/85 active:scale-95 transition-all"
              >
                <ChevronLeft size={18} />
              </button>
              <button
                type="button"
                onClick={() => onSelectSlide((activeIndex + 1) % mediaItems.length)}
                aria-label="Next slide"
                className="absolute right-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/65 backdrop-blur-xl border border-white/20 text-white flex items-center justify-center hover:bg-black/85 active:scale-95 transition-all"
              >
                <ChevronRight size={18} />
              </button>
            </>
          )}
        </div>
      ) : (
        <div
          className="relative w-full flex items-center justify-center rounded-2xl overflow-hidden bg-black/95 ring-1 ring-white/15 shadow-2xl aspect-[4/5] max-h-[500px]"
          data-testid="preview-media"
        >
          {previewUrl ? (
            <img
              src={previewUrl}
              alt={`Slide ${activeIndex + 1} of ${result.title || 'selected post'}`}
              referrerPolicy="no-referrer"
              className="w-full h-full object-contain bg-black/95 rounded-2xl"
              data-testid="img-preview"
            />
          ) : (
            <div className="flex flex-col items-center gap-2 p-6 text-center text-xs text-[#969ba3]">
              <ImageIcon size={24} />
              <span>Preview unavailable</span>
            </div>
          )}

          {isCarousel && (
            <>
              <button
                type="button"
                onClick={() =>
                  onSelectSlide((activeIndex - 1 + mediaItems.length) % mediaItems.length)
                }
                aria-label="Previous slide"
                className="absolute left-3 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/65 backdrop-blur-xl border border-white/20 text-white flex items-center justify-center hover:bg-black/85 active:scale-95 transition-all"
              >
                <ChevronLeft size={18} />
              </button>
              <button
                type="button"
                onClick={() => onSelectSlide((activeIndex + 1) % mediaItems.length)}
                aria-label="Next slide"
                className="absolute right-3 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-black/65 backdrop-blur-xl border border-white/20 text-white flex items-center justify-center hover:bg-black/85 active:scale-95 transition-all"
              >
                <ChevronRight size={18} />
              </button>
              <span className="absolute right-3 bottom-3 px-2.5 py-1 rounded-lg bg-black/70 backdrop-blur-xl border border-white/15 text-[11px] font-mono tabular-nums text-white">
                {activeIndex + 1} / {mediaItems.length}
              </span>
            </>
          )}
        </div>
      )}

      {isCarousel && (
        <div className="preview-nav w-full" aria-label="Select carousel slide">
          {mediaItems.map((item, index) => (
            <button
              className={`preview-thumb ${index === activeIndex ? 'active' : ''}`}
              key={`${item.url}-${index}`}
              type="button"
              onClick={() => onSelectSlide(index)}
              aria-label={`Select slide ${index + 1}, ${item.quality || item.type}`}
              aria-pressed={index === activeIndex}
              data-testid={`button-select-media-${index}`}
            >
              {item.type === 'image' || item.type === 'profile' ? (
                <img src={item.thumbnail || item.url} alt="" referrerPolicy="no-referrer" />
              ) : item.thumbnail ? (
                <img src={item.thumbnail} alt="" referrerPolicy="no-referrer" />
              ) : (
                <span className="thumb-placeholder">
                  <Video size={16} />
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default CarouselViewer;
