import { useEffect, useRef, useState } from 'react';
import { Maximize2, Pause, Play, Video, Volume2, VolumeX } from 'lucide-react';

function formatTimecode(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

export interface CupertinoPlayerProps {
  src: string;
  poster?: string | null;
  title: string;
  initialAspectRatio?: 'vertical' | 'horizontal' | 'square';
}

export function CupertinoPlayer({
  src,
  poster,
  title,
  initialAspectRatio,
}: CupertinoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [hasError, setHasError] = useState(false);
  const [aspectMode, setAspectMode] = useState<'vertical' | 'horizontal' | 'square'>(
    initialAspectRatio || 'vertical'
  );
  const [showControls, setShowControls] = useState(true);

  useEffect(() => {
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setHasError(false);
    if (initialAspectRatio) {
      setAspectMode(initialAspectRatio);
    }
  }, [src, initialAspectRatio]);

  const togglePlay = () => {
    const vid = videoRef.current;
    if (!vid) return;
    if (vid.paused) {
      void vid.play().catch(() => setHasError(true));
    } else {
      vid.pause();
    }
  };

  const toggleMute = () => {
    const vid = videoRef.current;
    if (!vid) return;
    vid.muted = !vid.muted;
    setIsMuted(vid.muted);
  };

  const handleScrub = (value: number) => {
    const vid = videoRef.current;
    if (!vid || !Number.isFinite(duration) || duration <= 0) return;
    vid.currentTime = value;
    setCurrentTime(value);
  };

  const handleFullscreen = () => {
    const vid = videoRef.current as (HTMLVideoElement & {
      webkitEnterFullscreen?: () => void;
    }) | null;
    if (!vid) return;
    if (vid.requestFullscreen) {
      void vid.requestFullscreen();
    } else if (vid.webkitEnterFullscreen) {
      vid.webkitEnterFullscreen();
    }
  };

  const aspectClass =
    aspectMode === 'horizontal'
      ? 'aspect-video w-full max-w-[460px]'
      : aspectMode === 'square'
      ? 'aspect-square w-full max-w-[380px]'
      : 'aspect-[9/16] w-full max-w-[310px] max-h-[530px]';

  return (
    <div
      className={`relative group mx-auto overflow-hidden rounded-2xl bg-black/95 ring-1 ring-white/15 shadow-2xl flex items-center justify-center select-none ${aspectClass}`}
      onMouseEnter={() => setShowControls(true)}
      data-testid="preview-media"
    >
      {hasError || !src ? (
        <div className="relative w-full h-full flex flex-col items-center justify-center p-5 text-center overflow-hidden">
          {poster && (
            <img
              src={poster}
              alt={title || 'Video preview'}
              referrerPolicy="no-referrer"
              className="absolute inset-0 w-full h-full object-cover opacity-45 filter blur-xs"
            />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/55 to-black/75 backdrop-blur-md" />
          <div className="relative z-10 flex flex-col items-center gap-2.5 max-w-[260px]">
            <div className="w-13 h-13 rounded-2xl bg-white/10 backdrop-blur-2xl border border-white/20 flex items-center justify-center text-white/85 shadow-lg">
              <Video size={24} />
            </div>
            <div className="text-sm font-semibold text-white/95">Stream Preview Ready</div>
            <p className="text-[12px] text-white/70 leading-relaxed">
              Direct preview stream not rendered in this browser engine. Your full-resolution media is available to save below.
            </p>
          </div>
        </div>
      ) : (
        <video
          ref={videoRef}
          src={src}
          poster={poster || undefined}
          playsInline
          preload="none"
          onClick={togglePlay}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onEnded={() => setIsPlaying(false)}
          onError={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setHasError(true);
          }}
          onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            if (v.duration && Number.isFinite(v.duration)) {
              setDuration(v.duration);
            }
            if (v.videoWidth && v.videoHeight) {
              const ratio = v.videoWidth / v.videoHeight;
              if (ratio > 1.15) setAspectMode('horizontal');
              else if (ratio < 0.85) setAspectMode('vertical');
              else setAspectMode('square');
            }
          }}
          className="w-full h-full object-contain bg-black/95 rounded-2xl cursor-pointer"
          aria-label={`Preview of ${title || 'selected video'}`}
          data-testid="video-preview"
        />
      )}

      {!hasError && src && !isPlaying && (
        <button
          type="button"
          onClick={togglePlay}
          aria-label="Play video"
          className="absolute inset-0 m-auto w-16 h-16 rounded-full bg-black/55 backdrop-blur-2xl border border-white/25 text-white flex items-center justify-center shadow-2xl transition-transform duration-150 hover:scale-105 active:scale-95"
        >
          <Play size={26} className="ml-1 fill-white text-white" />
        </button>
      )}

      {!hasError && src && (
        <div
          className={`absolute inset-x-3 bottom-3 z-10 flex flex-col gap-2 rounded-2xl bg-zinc-900/70 backdrop-blur-2xl border border-white/15 px-3.5 py-2.5 shadow-xl transition-opacity duration-200 ${
            showControls || !isPlaying ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          }`}
        >
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={togglePlay}
              aria-label={isPlaying ? 'Pause' : 'Play'}
              className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white transition-colors shrink-0"
            >
              {isPlaying ? (
                <Pause size={15} className="fill-white" />
              ) : (
                <Play size={15} className="ml-0.5 fill-white" />
              )}
            </button>

            <input
              type="range"
              min={0}
              max={duration > 0 ? duration : 100}
              step={0.1}
              value={currentTime}
              onChange={(e) => handleScrub(Number(e.target.value))}
              aria-label="Seek video timeline"
              className="ios-scrubber flex-1"
            />

            <span className="text-[11px] font-mono tabular-nums text-white/85 shrink-0">
              {formatTimecode(currentTime)} / {formatTimecode(duration)}
            </span>

            <button
              type="button"
              onClick={toggleMute}
              aria-label={isMuted ? 'Unmute' : 'Mute'}
              className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white transition-colors shrink-0"
            >
              {isMuted ? <VolumeX size={15} /> : <Volume2 size={15} />}
            </button>

            <button
              type="button"
              onClick={handleFullscreen}
              aria-label="Fullscreen"
              className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white transition-colors shrink-0"
            >
              <Maximize2 size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default CupertinoPlayer;
