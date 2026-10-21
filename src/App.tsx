import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import {
  useExtractMedia,
  useDownloadHighlight,
  useDownloadFile,
  useHealthCheck,
} from './api/client';
import type {
  DownloadMedia,
  DownloadResult,
  HighlightStory,
  Mode,
  Platform,
  PlatformChoice,
} from './types/api';
import { CarouselViewer } from './components/CarouselViewer';
import { HighlightPackage } from './components/HighlightPackage';
import {
  Archive,
  ArrowDownToLine,
  AudioLines,
  BadgeCheck,
  Check,
  ChevronDown,
  CircleAlert,
  Clipboard,
  Copy,
  ExternalLink,
  Link2,
  LockKeyhole,
  Music2,
  ShieldCheck,
  UserRound,
  Video,
} from 'lucide-react';

const queryClient = new QueryClient();

function errorText(error: unknown): string {
  if (error && typeof error === 'object') {
    const candidate = error as {
      message?: string;
      error?: string;
      data?: { error?: string };
      response?: { data?: { error?: string } };
    };
    return (
      candidate.response?.data?.error ||
      candidate.data?.error ||
      candidate.error ||
      candidate.message ||
      'The service could not prepare this download. Please try again.'
    );
  }
  return 'The service could not prepare this download. Please try again.';
}

function safeName(value: string) {
  return (
    value
      .trim()
      .replace(/[^\w\- ]+/g, '')
      .replace(/\s+/g, '-')
      .slice(0, 52) || 'omnidownloader-media'
  );
}

function saveBlob(blob: Blob, name: string) {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = name;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
}

async function triggerDirectBrowserDownload(downloadUrl: string, filename: string): Promise<void> {
  try {
    const response = await fetch(downloadUrl);
    if (!response.ok) {
      throw new Error('Could not fetch media stream');
    }
    const blob = await response.blob();
    saveBlob(blob, filename);
  } catch {
    const anchor = document.createElement('a');
    anchor.href = downloadUrl;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }
}

function resultTypeLabel(result: DownloadResult) {
  if (result.type === 'carousel') return 'Carousel · Multi-Slide';
  if (result.type === 'profile') return 'HD Profile Photo';
  return result.type === 'video' ? 'Video' : 'Image';
}

function qualityLabel(media: DownloadMedia) {
  const height = media.height ?? Number.parseInt(media.quality, 10);
  if (height >= 2160) return `4K · ${height}p`;
  if (height >= 1440) return `QHD · ${height}p`;
  if (height >= 1080 && media.type === 'video') return `Full HD · 1080p`;
  if (height >= 720 && media.type === 'video') return `HD · 720p`;
  if (height >= 480 && media.type === 'video') return `SD · 480p`;
  if (height >= 360 && media.type === 'video') return `SD · 360p`;
  return media.quality || 'Original HD';
}

function hashtagUrl(platform: Platform, tag: string) {
  const value = encodeURIComponent(tag.replace(/^#/, ''));
  if (platform === 'instagram') return `https://www.instagram.com/explore/tags/${value}/`;
  if (platform === 'tiktok') return `https://www.tiktok.com/tag/${value}`;
  if (platform === 'youtube') return `https://www.youtube.com/results?search_query=${value}`;
  return `https://www.pinterest.com/search/pins/?q=${value}`;
}

function Avatar({ creator }: { creator: DownloadResult['creator'] }) {
  const [imgError, setImgError] = useState(false);
  const initials = (creator.name || creator.handle || '?')
    .replace(/^@/, '')
    .slice(0, 1)
    .toUpperCase();

  useEffect(() => {
    setImgError(false);
  }, [creator.avatarUrl]);

  return (
    <div className="avatar" aria-label={creator.name || creator.handle || 'Creator'}>
      {creator.avatarUrl && !imgError ? (
        <img
          src={creator.avatarUrl}
          alt={creator.name || creator.handle || 'Creator avatar'}
          referrerPolicy="no-referrer"
          onError={() => setImgError(true)}
        />
      ) : (
        initials
      )}
    </div>
  );
}

function UnifiedCaptionBox({
  caption,
  tags = [],
  platform,
  onCopy,
  copied,
}: {
  caption?: string | null;
  tags?: string[];
  platform: Platform;
  onCopy: (text: string, label: string) => void;
  copied: string;
}) {
  const [expanded, setExpanded] = useState(false);

  const fullText = useMemo(() => {
    const trimmedCap = (caption || '').trim();
    const existingInCap = new Set(
      (trimmedCap.match(/#([\w\u0080-\uffff]+)/g) || []).map((t) => t.toLowerCase())
    );
    const unmentionedTags = (tags || [])
      .map((t) => (t.startsWith('#') ? t : `#${t}`))
      .filter((t) => !existingInCap.has(t.toLowerCase()));

    if (unmentionedTags.length > 0) {
      return trimmedCap ? `${trimmedCap}\n\n${unmentionedTags.join(' ')}` : unmentionedTags.join(' ');
    }
    return trimmedCap;
  }, [caption, tags]);

  if (!fullText) return null;

  const isLong = fullText.length > 180;
  const displayText = !expanded && isLong ? `${fullText.slice(0, 180).trim()}…` : fullText;
  const tokens = displayText.split(/(#[\w\u0080-\uffff]+)/g);

  return (
    <div className="ios-unified-caption" data-testid="unified-caption-box">
      <div className="ios-unified-caption-head">
        <span className="text-[11px] font-semibold tracking-wide uppercase text-white/70">
          Caption &amp; Hashtags
        </span>
        <button
          type="button"
          onClick={() => onCopy(fullText, 'caption')}
          className="ios-copy-btn"
          aria-label="Copy caption and hashtags"
          data-testid="button-copy-text"
        >
          {copied === 'caption' ? <Check size={12} /> : <Clipboard size={12} />}
          <span>{copied === 'caption' ? 'Copied' : 'Copy Text'}</span>
        </button>
      </div>

      <div className="whitespace-pre-line text-[13px] leading-relaxed text-[#c9ccd2]">
        {tokens.map((token, idx) => {
          if (token.startsWith('#')) {
            const rawTag = token.slice(1);
            return (
              <a
                key={idx}
                href={hashtagUrl(platform, rawTag)}
                target="_blank"
                rel="noreferrer"
                className="ios-tag"
              >
                {token}
              </a>
            );
          }
          return <span key={idx}>{token}</span>;
        })}
      </div>

      {isLong && (
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="mt-2 text-xs font-medium text-[#a9c2ff] hover:text-white transition-colors"
          data-testid="button-expand-caption"
        >
          {expanded ? 'Show less' : '... more'}
        </button>
      )}
    </div>
  );
}

function Downloader() {
  const [url, setUrl] = useState('');
  const [mode, setMode] = useState<Mode>('post');
  const [platformChoice, setPlatformChoice] = useState<PlatformChoice>('auto');
  const [clipboardMessage, setClipboardMessage] = useState('');
  const [selectedMedia, setSelectedMedia] = useState(0);
  const [imageFormat, setImageFormat] = useState<'original' | 'webp'>('original');
  const [audioBitrate, setAudioBitrate] = useState<128 | 320>(320);
  const [downloadState, setDownloadState] = useState<Record<string, 'loading' | 'done' | 'error'>>(
    {}
  );
  const [downloadErrors, setDownloadErrors] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState('');

  const extractMutation = useExtractMedia();
  const highlightMutation = useDownloadHighlight();
  const fileMutation = useDownloadFile();
  const healthQuery = useHealthCheck();

  const result = extractMutation.data;
  const highlight = highlightMutation.data;

  // Detect Instagram Stories & Base64 Mobile Share Highlights (/stories/... or /s/aGlnaGxpZ2h0...)
  const isStoryUrl = useMemo(() => {
    try {
      const trimmed = url.trim();
      const normalized = trimmed.includes('://') ? trimmed : `https://${trimmed}`;
      const parsed = new URL(normalized);
      const host = parsed.hostname.toLowerCase();
      const isIg =
        host === 'instagram.com' ||
        host.endsWith('.instagram.com') ||
        host === 'instagr.am' ||
        host.endsWith('.instagr.am');
      if (!isIg) return false;
      return /\/stories\//i.test(parsed.pathname) || /^\/s\/[A-Za-z0-9+/=_-]+/.test(parsed.pathname);
    } catch {
      return false;
    }
  }, [url]);

  // Auto-detect platform from pasted or typed URL
  const detectedPlatform = useMemo<Platform | null>(() => {
    try {
      const trimmed = url.trim();
      const normalized = trimmed.includes('://') ? trimmed : `https://${trimmed}`;
      const parsed = new URL(normalized);
      const host = parsed.hostname.toLowerCase();
      if (host.includes('instagram.com') || host.includes('instagr.am')) return 'instagram';
      if (host.includes('tiktok.com')) return 'tiktok';
      if (host.includes('youtube.com') || host.includes('youtu.be')) return 'youtube';
      if (host.includes('pinterest.') || host.includes('pin.it')) return 'pinterest';
      return null;
    } catch {
      return null;
    }
  }, [url]);

  const loading = extractMutation.isPending || highlightMutation.isPending;
  const mediaItems = result?.media ?? [];
  const activeIndex = Math.min(selectedMedia, Math.max(0, mediaItems.length - 1));
  const activeMedia = mediaItems[activeIndex];
  const isProfileResult = result?.type === 'profile' || activeMedia?.type === 'profile';
  const isImage = activeMedia?.type === 'image' || activeMedia?.type === 'profile';
  const audioAvailable = Boolean(result?.audioAvailable);
  const serviceUnavailable =
    healthQuery.isError || (healthQuery.data !== undefined && healthQuery.data.status !== 'ok');
  const extractionError = extractMutation.isError
    ? errorText(extractMutation.error)
    : highlightMutation.isError
    ? errorText(highlightMutation.error)
    : '';

  const qualityOptions = useMemo(() => {
    if (!result) return [];
    return result.media
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.type === 'video');
  }, [result]);

  const currentQuality =
    qualityOptions.find(({ index }) => index === activeIndex)?.item ?? qualityOptions[0]?.item;

  const [selectedQualityKey, setSelectedQualityKey] = useState<string>('0');

  useEffect(() => {
    if (result) {
      setSelectedMedia(0);
      setSelectedQualityKey('0');
    }
  }, [result]);

  const handleQualityChange = (val: string) => {
    setSelectedQualityKey(val);
    if (val === 'audio-mp3') {
      // Audio MP3 selected
    } else if (val === 'image-original') {
      setImageFormat('original');
    } else if (val === 'image-webp') {
      setImageFormat('webp');
    } else {
      const idx = Number(val);
      if (!isNaN(idx)) {
        setSelectedMedia(idx);
      }
    }
  };

  const handleMainDownload = () => {
    if (selectedQualityKey === 'audio-mp3') {
      downloadAudio();
    } else {
      downloadMedia(activeIndex);
    }
  };

  const setLocalStatus = (key: string, status: 'loading' | 'done' | 'error', message = '') => {
    setDownloadState((current) => ({ ...current, [key]: status }));
    setDownloadErrors((current) => ({ ...current, [key]: message }));
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setClipboardMessage('');
    const trimmed = url.trim();
    if (!trimmed) return;

    const isHandle = /^@?[\w.-]{1,60}$/.test(trimmed) && !trimmed.includes('/');
    const isDomainWithoutProtocol =
      /^(?:www\.|m\.|vt\.|vm\.)?(?:instagram\.com|tiktok\.com|pinterest\.com|pin\.it|instagr\.am|youtube\.com|youtu\.be)\//i.test(
        trimmed
      );

    if (!isHandle && !isDomainWithoutProtocol) {
      try {
        const parsed = new URL(trimmed);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid');
      } catch {
        extractMutation.reset();
        highlightMutation.reset();
        setClipboardMessage('Enter a full public URL (https://...) or a @username handle.');
        return;
      }
    }

    setSelectedMedia(0);
    setDownloadState({});
    setDownloadErrors({});
    extractMutation.reset();
    highlightMutation.reset();

    if (isStoryUrl) {
      highlightMutation.mutate({ data: { url: trimmed } });
    } else {
      extractMutation.mutate({
        data: {
          url: trimmed,
          mode,
          platform: platformChoice === 'auto' ? null : platformChoice,
        },
      });
    }
  };

  const pasteFromClipboard = async () => {
    setClipboardMessage('');
    try {
      const value = await navigator.clipboard.readText();
      if (value.trim()) {
        setUrl(value.trim());
        setClipboardMessage('Link pasted from clipboard');
      } else {
        setClipboardMessage('Your clipboard is empty');
      }
    } catch {
      setClipboardMessage('Clipboard access is unavailable. Paste the link into the field.');
    }
  };

  const copyText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      window.setTimeout(() => setCopied(''), 1800);
    } catch {
      setClipboardMessage('Clipboard access is unavailable on this device.');
    }
  };

  const downloadMedia = async (index: number) => {
    if (!result) return;
    const media = result.media[index];
    if (!media) return;

    const key = `media-${index}-${
      media.type === 'image' || media.type === 'profile' ? imageFormat : 'original'
    }`;
    setLocalStatus(key, 'loading');

    const extension =
      media.type === 'video'
        ? media.format === 'unknown'
          ? 'mp4'
          : media.format
        : imageFormat === 'webp'
        ? 'webp'
        : media.format === 'unknown'
        ? 'jpg'
        : media.format;
    const postfix = result.type === 'carousel' && result.media.length > 1 ? `-slide-${index + 1}` : '';
    const filename = `${safeName(result.title)}${postfix}.${extension}`;

    try {
      const isYouTube = result.platform === 'youtube';
      if (media.downloadUrl && imageFormat === 'original' && !isYouTube) {
        await triggerDirectBrowserDownload(media.downloadUrl, filename);
        setLocalStatus(key, 'done');
        return;
      }

      const blob = await fileMutation.mutateAsync({
        data: {
          downloadId: result.downloadId,
          url: media.rawUrl || media.url,
          filename,
          assetType: 'media',
          mediaIndex: index,
          format: media.type === 'image' || media.type === 'profile' ? imageFormat : 'original',
          bitrate: audioBitrate,
        },
      });
      saveBlob(blob, filename);
      setLocalStatus(key, 'done');
    } catch (error) {
      setLocalStatus(key, 'error', errorText(error));
    }
  };

  const downloadAllCarouselSlides = async () => {
    if (!result || result.media.length <= 1) return;
    const key = 'all-carousel-slides';
    setLocalStatus(key, 'loading');
    try {
      const items = result.media.map((item, idx) => ({
        url: item.rawUrl || item.url,
        type: item.type,
        filename: `${safeName(result.title)}-slide-${idx + 1}.${
          item.type === 'video' ? 'mp4' : 'jpg'
        }`,
      }));
      const blob = await fileMutation.mutateAsync({
        data: {
          downloadId: result.downloadId,
          assetType: 'archive',
          mediaIndex: null,
          format: 'original',
          bitrate: 320,
          items,
        },
      });
      saveBlob(blob, `${safeName(result.title)}-all-slides.zip`);
      setLocalStatus(key, 'done');
    } catch (error) {
      setLocalStatus(key, 'error', errorText(error));
    }
  };

  const downloadAvatar = async (
    downloadId: string,
    creator: DownloadResult['creator'],
    title: string
  ) => {
    const avatarSource = creator.avatarUrl || activeMedia?.rawUrl || activeMedia?.url;
    if (!avatarSource) return;
    const key = `avatar-${downloadId}`;
    setLocalStatus(key, 'loading');
    const filename = `${safeName(creator.handle || creator.name || title)}-hd-profile-photo.jpg`;

    try {
      const blob = await fileMutation.mutateAsync({
        data: {
          downloadId,
          url: avatarSource,
          filename,
          assetType: 'avatar',
          mediaIndex: null,
          format: 'original',
          bitrate: 320,
        },
      });
      saveBlob(blob, filename);
      setLocalStatus(key, 'done');
    } catch (error) {
      setLocalStatus(key, 'error', errorText(error));
    }
  };

  const downloadAudio = async () => {
    if (!result || !audioAvailable) return;
    const key = `audio-${audioBitrate}`;
    setLocalStatus(key, 'loading');
    const filename = `${safeName(result.title)}-${audioBitrate}kbps.mp3`;

    try {
      const isPureMp3 = Boolean(result.audioUrl && (result.audioUrl.toLowerCase().includes('.mp3') || result.audioUrl.includes('mime=audio')));
      if (isPureMp3 && result.audioUrl && result.platform !== 'youtube') {
        await triggerDirectBrowserDownload(result.audioUrl, filename);
        setLocalStatus(key, 'done');
        return;
      }

      const blob = await fileMutation.mutateAsync({
        data: {
          downloadId: result.downloadId,
          url: activeMedia?.rawUrl || activeMedia?.url,
          filename,
          assetType: 'audio',
          mediaIndex: null,
          format: 'mp3',
          bitrate: audioBitrate,
        },
      });
      saveBlob(blob, filename);
      setLocalStatus(key, 'done');
    } catch (error) {
      setLocalStatus(key, 'error', errorText(error));
    }
  };

  const downloadStory = async (story: HighlightStory) => {
    if (!highlight) return;
    const key = `story-${story.storyNumber}`;
    setLocalStatus(key, 'loading');
    const filename = `${safeName(highlight.title)}-story-${story.storyNumber}.${
      story.type === 'video' ? 'mp4' : 'jpg'
    }`;

    try {
      if (story.downloadUrl) {
        await triggerDirectBrowserDownload(story.downloadUrl, filename);
        setLocalStatus(key, 'done');
        return;
      }
      const blob = await fileMutation.mutateAsync({
        data: {
          downloadId: highlight.downloadId,
          url: story.url,
          filename,
          assetType: 'media',
          mediaIndex: story.mediaIndex,
          format: 'original',
          bitrate: 320,
        },
      });
      saveBlob(blob, filename);
      setLocalStatus(key, 'done');
    } catch (error) {
      setLocalStatus(key, 'error', errorText(error));
    }
  };

  const downloadAllStories = async () => {
    if (!highlight) return;
    setLocalStatus('all-stories', 'loading');
    try {
      const items = highlight.stories
        .filter((s) => Boolean(s.url))
        .map((s) => ({
          url: s.url!,
          type: s.type === 'video' ? 'video' : 'image',
          filename: `story-${s.storyNumber}.${s.type === 'video' ? 'mp4' : 'jpg'}`,
        }));
      const blob = await fileMutation.mutateAsync({
        data: {
          downloadId: highlight.downloadId,
          assetType: 'archive',
          mediaIndex: null,
          format: 'original',
          bitrate: 320,
          items,
        },
      });
      saveBlob(blob, `${safeName(highlight.title)}-stories.zip`);
      setLocalStatus('all-stories', 'done');
    } catch (error) {
      setLocalStatus('all-stories', 'error', errorText(error));
    }
  };

  const activeDownloadKey = `media-${activeIndex}-${isImage ? imageFormat : 'original'}`;
  const avatarDownloadKey = result ? `avatar-${result.downloadId}` : '';
  const audioDownloadKey = `audio-${audioBitrate}`;
  const carouselZipKey = 'all-carousel-slides';
  const resultHasMetadata = Boolean(
    result &&
      (result.title ||
        result.caption ||
        result.description ||
        result.hashtags.length ||
        result.creator.name ||
        result.creator.handle)
  );

  return (
    <div className="app-shell relative overflow-hidden">
      {/* Subtle Ambient Blurred Gradient Orbs on OLED Black */}
      <div
        className="pointer-events-none fixed -top-32 left-1/4 w-[480px] h-[480px] rounded-full bg-[#6d8cff] blur-3xl opacity-15"
        aria-hidden="true"
      />
      <div
        className="pointer-events-none fixed top-1/3 -right-32 w-[420px] h-[420px] rounded-full bg-[#a882ff] blur-3xl opacity-10"
        aria-hidden="true"
      />

      <header className="topbar relative z-10">
        <div className="brand" aria-label="OmniDownloader">
          <span className="brand-mark" aria-hidden="true">
            <ArrowDownToLine size={18} strokeWidth={2.3} />
          </span>
          <span className="brand-name">OmniDownloader</span>
        </div>
        <div className="topbar-note" data-testid="status-service">
          {healthQuery.isLoading
            ? 'Checking service'
            : serviceUnavailable
            ? 'Service unavailable'
            : 'Ready for a public link'}
        </div>
      </header>

      <main className="main relative z-10">
        <section className="intro">
          <div className="eyebrow">Cupertino social media archiver</div>
          <h1 className="hero-title">
            Your saved posts,<br />
            <span>without the noise.</span>
          </h1>
          <p className="hero-copy">
            Bring a public Instagram, TikTok, or Pinterest link—or enter a @username for 1080p HD
            profile photos.
          </p>
        </section>

        <form className="composer" onSubmit={submit} data-testid="form-download">
          <div className="composer-controls-row">
            <div className="mode-control" role="group" aria-label="Link type">
              <button
                className={`mode-option ${mode === 'post' ? 'active' : ''}`}
                type="button"
                aria-pressed={mode === 'post'}
                onClick={() => setMode('post')}
                data-testid="button-mode-post"
              >
                <Video size={14} /> Post / Carousel
              </button>
              <button
                className={`mode-option ${mode === 'profile' ? 'active' : ''}`}
                type="button"
                aria-pressed={mode === 'profile'}
                onClick={() => setMode('profile')}
                data-testid="button-mode-profile"
              >
                <UserRound size={14} /> Profile photo (DP)
              </button>
            </div>

            <div className="platform-control" role="group" aria-label="Choose source platform">
              <span className="platform-control-label">Platform</span>
              {(['auto', 'instagram', 'tiktok', 'youtube', 'pinterest'] as PlatformChoice[]).map(
                (platform) => {
                  const isAuto = platform === 'auto';
                  const isActive = platformChoice === platform;
                  const label = isAuto
                    ? detectedPlatform && platformChoice === 'auto'
                      ? `Auto · ${detectedPlatform === 'youtube' ? 'YouTube' : detectedPlatform[0].toUpperCase() + detectedPlatform.slice(1)}`
                      : 'Auto'
                    : platform === 'youtube'
                    ? 'YouTube'
                    : platform[0].toUpperCase() + platform.slice(1);

                  return (
                    <button
                      className={`platform-option ${isActive ? 'active' : ''}`}
                      type="button"
                      key={platform}
                      onClick={() => setPlatformChoice(platform)}
                      aria-pressed={isActive}
                      data-testid={`button-platform-${platform}`}
                    >
                      {label}
                    </button>
                  );
                }
              )}
            </div>
          </div>

          <div className="form-row">
            <div className="url-wrap border border-white/10 focus-within:border-white/30 rounded-2xl">
              <Link2 className="url-icon shrink-0" size={17} aria-hidden="true" />
              <label className="sr-only" htmlFor="post-url">
                {mode === 'profile'
                  ? 'Public profile URL or @handle'
                  : 'Public post or profile URL'}
              </label>
              <input
                id="post-url"
                className="url-input"
                type="text"
                autoComplete="url"
                inputMode="url"
                placeholder={
                  mode === 'profile'
                    ? 'Paste a profile link (e.g. instagram.com/netflixph, @handle, or youtube.com/@channel)'
                    : 'Paste a public TikTok, Instagram, YouTube, or Pinterest link (or @handle)'
                }
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value);
                  setClipboardMessage('');
                  if (extractMutation.isError || extractMutation.data) extractMutation.reset();
                  if (highlightMutation.isError || highlightMutation.data)
                    highlightMutation.reset();
                }}
                disabled={loading}
                aria-describedby="permission-note"
                data-testid="input-post-url"
              />
              <button
                className="paste-button"
                type="button"
                onClick={pasteFromClipboard}
                disabled={loading}
                aria-label="Paste link from clipboard"
                data-testid="button-paste"
              >
                Paste
              </button>
            </div>
            <button
              className="submit-button"
              type="submit"
              disabled={loading || !url.trim()}
              data-testid="button-download"
            >
              {loading ? (
                <>
                  <span className="loader" aria-hidden="true" /> Looking it up
                </>
              ) : (
                <>
                  Show available media <ArrowDownToLine size={15} />
                </>
              )}
            </button>
          </div>

          <div className="composer-foot">
            <div className="permission" id="permission-note">
              <LockKeyhole size={13} aria-hidden="true" /> Public posts &amp; HD avatars you’re
              authorized to keep
            </div>
            <div className="platforms" aria-label="Supported platforms">
              <span>Instagram</span>
              <span>TikTok</span>
              <span>YouTube</span>
              <span>Pinterest</span>
            </div>
          </div>
        </form>

        <div
          className="status-line"
          aria-live="polite"
          role={extractionError ? 'alert' : 'status'}
        >
          {serviceUnavailable && !loading && (
            <div className="error-message" data-testid="status-unavailable">
              <CircleAlert size={16} /> The service health check could not confirm availability. You
              can still try your link; any request failure will be shown here.
            </div>
          )}
          {loading && (
            <div className="loading-message" data-testid="status-loading">
              <span className="loader" />
              <span>
                {isStoryUrl
                  ? 'Unshortening link and checking public story availability…'
                  : 'Sanitizing URL and extracting full-resolution media…'}
              </span>
            </div>
          )}
          {!loading && extractionError && (
            <div className="error-message" data-testid="status-error">
              <CircleAlert size={16} />
              <span>{extractionError}</span>
            </div>
          )}
          {!loading && !extractionError && clipboardMessage && (
            <div className="notice-message" data-testid="status-clipboard">
              <Clipboard size={14} />
              {clipboardMessage}
            </div>
          )}
          {loading && (
            <div className="loading-skeleton" aria-label="Loading result">
              <span />
              <span />
              <span />
            </div>
          )}
        </div>

        {!result && !highlight && !loading && !extractionError && (
          <div className="empty-state" data-testid="empty-state">
            <span className="empty-state-mark">
              <Link2 size={17} />
            </span>
            <div>
              <strong>Start with a public link or @username</strong>
              <p>
                Paste a TikTok video or slideshow (including vt.tiktok.com), an Instagram Reel,
                Carousel, or profile link (e.g. instagram.com/netflixph), or a Pinterest pin.
              </p>
            </div>
          </div>
        )}

        {/* MAIN EXTRACTION RESULT CARD: CLEAN APPLE iOS COMPACT CARD */}
        <AnimatePresence mode="wait">
          {result && !loading && (
            <motion.section
              className="ios-compact-card mx-auto w-full max-w-xl"
              aria-label="Download result"
              data-testid="card-download-result"
              initial={{ opacity: 0, y: 16, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ type: 'spring', stiffness: 280, damping: 27 }}
            >
              {/* 1. Video Player or Carousel on top with native aspect ratio */}
              <div className="w-full">
                <CarouselViewer
                  result={result}
                  activeIndex={activeIndex}
                  onSelectSlide={setSelectedMedia}
                  onDownloadSlide={downloadMedia}
                  downloadStatus={downloadState[activeDownloadKey]}
                />
              </div>

              {/* 2. Clean Author Row (Avatar + username + verified + platform badge) */}
              <div className="ios-author-row pt-1">
                <div className="flex items-center gap-3 min-w-0">
                  <Avatar creator={result.creator} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 text-sm font-semibold text-white truncate">
                      <span className="truncate">
                        {result.creator.name || result.creator.handle || result.title || 'Creator'}
                      </span>
                      {result.creator.verified && (
                        <BadgeCheck size={15} color="#9bd9b7" className="shrink-0" aria-label="Verified creator" />
                      )}
                    </div>
                    {result.creator.handle && (
                      <div className="text-xs text-[#989da5] truncate">
                        {result.creator.handle.startsWith('@')
                          ? result.creator.handle
                          : `@${result.creator.handle}`}
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <span className="px-2.5 py-1 rounded-full text-[11px] font-mono uppercase tracking-wider bg-white/[0.08] text-[#a9c2ff] border border-white/[0.08]">
                    {result.platform}
                  </span>
                  {result.creator.profileUrl && (
                    <a
                      href={result.creator.profileUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="w-8 h-8 rounded-full bg-white/[0.06] border border-white/[0.08] hover:bg-white/[0.12] text-white/80 hover:text-white flex items-center justify-center transition-all"
                      title="Open profile"
                      data-testid="link-creator-profile"
                    >
                      <ExternalLink size={13} />
                    </a>
                  )}
                </div>
              </div>

              {/* 3. Combined Caption + #tags box (with inline highlighted hashtags and single Copy Text button) */}
              <UnifiedCaptionBox
                caption={result.caption || result.description}
                tags={result.hashtags || []}
                platform={result.platform}
                onCopy={copyText}
                copied={copied}
              />

              {/* 4. Streamlined Controls: Single clean "Quality" dropdown & ONE main high-contrast iOS action button */}
              <div className="ios-controls-bar pt-1">
                <div className="ios-quality-dropdown">
                  <label className="block text-[11px] font-medium text-[#989da5] mb-1.5 px-1">
                    Quality &amp; Format
                  </label>
                  <div className="relative">
                    <select
                      aria-label="Media Quality"
                      value={selectedQualityKey}
                      onChange={(e) => handleQualityChange(e.target.value)}
                      className="ios-dropdown-display appearance-none pr-10 cursor-pointer"
                      data-testid="select-quality"
                    >
                      {/* Video resolutions */}
                      {qualityOptions.map(({ item, index }) => (
                        <option value={String(index)} key={`video-${index}`}>
                          {qualityLabel(item)} · MP4
                        </option>
                      ))}

                      {/* Image formats */}
                      {isImage && (
                        <>
                          <option value="image-original">Original HD · JPG</option>
                          <option value="image-webp">WebP Optimized</option>
                        </>
                      )}

                      {/* Audio MP3 (320kbps) */}
                      {audioAvailable && (
                        <option value="audio-mp3">Audio · MP3 (320 kbps)</option>
                      )}
                    </select>
                    <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-white/70">
                      <ChevronDown size={16} />
                    </div>
                  </div>
                </div>

                {/* ONE main high-contrast iOS action button: "Download Media" */}
                <button
                  type="button"
                  onClick={handleMainDownload}
                  disabled={
                    (selectedQualityKey === 'audio-mp3'
                      ? downloadState[audioDownloadKey]
                      : downloadState[activeDownloadKey]) === 'loading'
                  }
                  className="ios-primary-btn"
                  data-testid="button-save-media"
                >
                  {(selectedQualityKey === 'audio-mp3'
                    ? downloadState[audioDownloadKey]
                    : downloadState[activeDownloadKey]) === 'loading' ? (
                    <>
                      <span className="loader" /> Preparing Download…
                    </>
                  ) : (selectedQualityKey === 'audio-mp3'
                    ? downloadState[audioDownloadKey]
                    : downloadState[activeDownloadKey]) === 'done' ? (
                    <>
                      <Check size={16} /> Saved to Downloads
                    </>
                  ) : selectedQualityKey === 'audio-mp3' ? (
                    <>
                      <Music2 size={16} /> Download Audio (MP3 320kbps)
                    </>
                  ) : isProfileResult ? (
                    <>
                      <ArrowDownToLine size={16} /> Download HD Profile Photo
                    </>
                  ) : result.type === 'carousel' && mediaItems.length > 1 ? (
                    <>
                      <ArrowDownToLine size={16} /> Download Slide {activeIndex + 1} (
                      {isImage ? 'HD Image' : 'HD Video'})
                    </>
                  ) : (
                    <>
                      <ArrowDownToLine size={16} /> Download Media (
                      {isImage
                        ? imageFormat === 'webp'
                          ? 'WebP'
                          : 'HD Image'
                        : activeMedia
                        ? qualityLabel(activeMedia)
                        : 'HD Media'}
                      )
                    </>
                  )}
                </button>

                {/* Inline error notice if download failed */}
                {(selectedQualityKey === 'audio-mp3'
                  ? downloadErrors[audioDownloadKey]
                  : downloadErrors[activeDownloadKey]) && (
                  <div
                    className="download-error text-xs flex items-center gap-2 p-2.5 rounded-xl bg-red-500/10 border border-red-500/20 text-red-300"
                    role="alert"
                  >
                    <CircleAlert size={14} className="shrink-0" />
                    <span>
                      {selectedQualityKey === 'audio-mp3'
                        ? downloadErrors[audioDownloadKey]
                        : downloadErrors[activeDownloadKey]}
                    </span>
                  </div>
                )}

                {/* Carousel all-slides bundle if multiple slides */}
                {result.type === 'carousel' && mediaItems.length > 1 && (
                  <button
                    type="button"
                    onClick={downloadAllCarouselSlides}
                    disabled={downloadState[carouselZipKey] === 'loading'}
                    className="w-full text-center text-xs text-[#a9c2ff] hover:text-white transition-colors py-1 flex items-center justify-center gap-1.5"
                    data-testid="button-download-all-slides"
                  >
                    {downloadState[carouselZipKey] === 'loading' ? (
                      <>
                        <span className="loader" /> Bundling all slides (ZIP)…
                      </>
                    ) : downloadState[carouselZipKey] === 'done' ? (
                      <>
                        <Check size={12} /> All Slides Downloaded
                      </>
                    ) : (
                      <>
                        <Archive size={12} /> Download All Slides as ZIP
                      </>
                    )}
                  </button>
                )}
              </div>
            </motion.section>
          )}
        </AnimatePresence>

        {/* INSTAGRAM HIGHLIGHTS / STORIES RESULT OR FRIENDLY iOS ALERT */}
        <AnimatePresence mode="wait">
          {highlight && !loading && (
            <HighlightPackage
              highlight={highlight}
              downloadState={downloadState}
              downloadErrors={downloadErrors}
              onDownloadStory={downloadStory}
              onDownloadAllStories={downloadAllStories}
              onDownloadAvatar={downloadAvatar}
            />
          )}
        </AnimatePresence>

        <section className="disclaimer" aria-label="Usage notice">
          <div className="disclaimer-icon" aria-hidden="true">
            <ShieldCheck size={15} />
          </div>
          <div>
            <strong>Respect creators and platform terms</strong>
            <p>
              OmniDownloader is for personal archiving and content you own or have permission to
              save. Private accounts and login-protected media are not accessed.
            </p>
          </div>
        </section>
      </main>

      <footer className="footer relative z-10">
        <span>OmniDownloader</span>
        <span>Public links only · Ad-free</span>
      </footer>
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Downloader />
    </QueryClientProvider>
  );
}
