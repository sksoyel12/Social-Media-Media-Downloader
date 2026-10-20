import { useMemo, useState, type FormEvent } from 'react';
import { QueryClient, QueryClientProvider, type UseMutationResult } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import * as ApiClient from '@workspace/api-client-react';
import type { DownloadResult } from '@workspace/api-client-react';
import {
  ArrowDownToLine,
  AudioLines,
  BadgeCheck,
  Check,
  ChevronDown,
  CircleAlert,
  Clipboard,
  Copy,
  ExternalLink,
  Image as ImageIcon,
  Link2,
  LockKeyhole,
  Music2,
  ShieldCheck,
  UserRound,
  Video,
} from 'lucide-react';

const queryClient = new QueryClient();
type Mode = 'post' | 'profile';
type Platform = 'instagram' | 'tiktok' | 'pinterest';
type PlatformChoice = Platform | 'auto';
type ExtractVariables = { data: { url: string; mode: Mode; platform: Platform | null } };
type HighlightResult = {
  downloadId: string;
  title: string;
  cover: string | null;
  creator: DownloadResult['creator'];
  stories: Array<{ storyNumber: number; mediaIndex: number; type: 'photo' | 'video'; duration: number | null; thumbnail: string | null; createdAt: string | null }>;
  truncated: boolean;
};
type HighlightVariables = { data: { url: string } };
type FileVariables = { data: { downloadId: string; assetType: 'media' | 'avatar' | 'audio'; mediaIndex: number | null; format: 'original' | 'webp' | 'mp3'; bitrate: 128 | 320 } };
type CurrentApiHooks = {
  useExtractMedia: () => UseMutationResult<DownloadResult, unknown, ExtractVariables>;
  useDownloadHighlight: () => UseMutationResult<HighlightResult, unknown, HighlightVariables>;
  useDownloadFile: () => UseMutationResult<Blob, unknown, FileVariables>;
};
const currentApi = ApiClient as unknown as CurrentApiHooks & typeof ApiClient;
const useExtractMedia = currentApi.useExtractMedia;
const useDownloadHighlight = currentApi.useDownloadHighlight;
const useDownloadFile = currentApi.useDownloadFile;

function errorText(error: unknown): string {
  if (error && typeof error === 'object') {
    const candidate = error as { message?: string; error?: string; data?: { error?: string }; response?: { data?: { error?: string } } };
    return candidate.response?.data?.error || candidate.data?.error || candidate.error || candidate.message || 'The service could not prepare this download. Please try again.';
  }
  return 'The service could not prepare this download. Please try again.';
}

function safeName(value: string) {
  return value.trim().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-').slice(0, 52) || 'omnidownloader-media';
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
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

function resultTypeLabel(result: DownloadResult) {
  if (result.type === 'carousel') return 'Carousel';
  if (result.type === 'profile') return 'Profile photo';
  return result.type === 'video' ? 'Video' : 'Image';
}

function Avatar({ creator }: { creator: DownloadResult['creator'] }) {
  const initials = (creator.name || creator.handle || '?').replace(/^@/, '').slice(0, 1).toUpperCase();
  return (
    <div className="avatar" aria-label={creator.name || creator.handle || 'Creator'}>
      {creator.avatarUrl ? <img src={creator.avatarUrl} alt="" /> : initials}
    </div>
  );
}

function Metadata({ result, onCopy, copied }: { result: DownloadResult; onCopy: (text: string, label: string) => void; copied: string }) {
  const caption = result.caption || result.description;
  const tags = result.hashtags || [];
  return (
    <div className="metadata-block">
      <div className="metadata-heading">
        <span>Caption</span>
        <button className="copy-button" type="button" onClick={() => onCopy(caption, 'caption')} disabled={!caption} aria-label="Copy caption" data-testid="button-copy-caption">
          {copied === 'caption' ? <Check size={13} /> : <Copy size={13} />}
          {copied === 'caption' ? 'Copied' : 'Copy'}
        </button>
      </div>
      {caption ? <p className="caption-text expanded">{caption}</p> : <p className="metadata-empty">No caption was returned for this post.</p>}
      <div className="metadata-heading" style={{ marginTop: 13 }}>
        <span>Hashtags</span>
        <button className="copy-button" type="button" onClick={() => onCopy(tags.join(' '), 'hashtags')} disabled={!tags.length} aria-label="Copy hashtags" data-testid="button-copy-hashtags">
          {copied === 'hashtags' ? <Check size={13} /> : <Clipboard size={13} />}
          {copied === 'hashtags' ? 'Copied' : 'Copy'}
        </button>
      </div>
      {tags.length ? <div className="tags">{tags.map((tag, index) => <span className="tag" key={`${tag}-${index}`}>{tag.startsWith('#') ? tag : `#${tag}`}</span>)}</div> : <p className="metadata-empty">No hashtags were returned.</p>}
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
  const [downloadState, setDownloadState] = useState<Record<string, 'loading' | 'done' | 'error'>>({});
  const [downloadErrors, setDownloadErrors] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState('');
  const extractMutation = useExtractMedia();
  const highlightMutation = useDownloadHighlight();
  const fileMutation = useDownloadFile();
  const healthQuery = ApiClient.useHealthCheck();
  const result = extractMutation.data as (DownloadResult & { uploadDate: string | null; boardName: string | null }) | undefined;
  const highlight = highlightMutation.data;
  const isStoryUrl = useMemo(() => {
    try {
      const parsed = new URL(url.trim());
      return parsed.hostname.toLowerCase().includes('instagram.com') && /\/stories\//i.test(parsed.pathname);
    } catch { return false; }
  }, [url]);
  const loading = extractMutation.isPending || highlightMutation.isPending;

  const mediaItems = result?.media ?? [];
  const activeIndex = Math.min(selectedMedia, Math.max(0, mediaItems.length - 1));
  const activeMedia = mediaItems[activeIndex];
  const isImage = activeMedia?.type === 'image' || activeMedia?.type === 'profile';
  const previewUrl = isImage ? activeMedia?.url : result?.thumbnail;
  const audioIndex = mediaItems.findIndex((item) => item.type === 'video' && item.hasAudio);
  const audioAvailable = Boolean(result?.audioAvailable && audioIndex >= 0);
  const serviceUnavailable = healthQuery.isError || (healthQuery.data !== undefined && healthQuery.data.status !== 'ok');
  const extractionError = extractMutation.isError ? errorText(extractMutation.error) : highlightMutation.isError ? errorText(highlightMutation.error) : '';

  const qualityOptions = useMemo(() => {
    if (!result) return [];
    const allowed = ['4k', '1440', '1080', '720', '480'];
    const found = result.media
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.type === 'video' && allowed.some((quality) => item.quality.toLowerCase().includes(quality)));
    return found;
  }, [result]);

  const setLocalStatus = (key: string, status: 'loading' | 'done' | 'error', message = '') => {
    setDownloadState((current) => ({ ...current, [key]: status }));
    setDownloadErrors((current) => ({ ...current, [key]: message }));
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setClipboardMessage('');
    const trimmed = url.trim();
    if (!trimmed) return;
    const handleOnly = mode === 'profile' && platformChoice !== 'auto' && /^@?[\w.-]+$/.test(trimmed);
    if (!handleOnly) {
      try {
        const parsed = new URL(trimmed);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid');
      } catch {
        extractMutation.reset();
        highlightMutation.reset();
        setClipboardMessage('Enter a full public URL, or choose a platform to use a profile handle.');
        return;
      }
    }
    setSelectedMedia(0);
    setDownloadState({});
    setDownloadErrors({});
    extractMutation.reset();
    highlightMutation.reset();
    if (isStoryUrl) highlightMutation.mutate({ data: { url: trimmed } });
    else extractMutation.mutate({ data: { url: trimmed, mode, platform: platformChoice === 'auto' ? null : platformChoice } });
  };

  const pasteFromClipboard = async () => {
    setClipboardMessage('');
    try {
      const value = await navigator.clipboard.readText();
      if (value.trim()) {
        setUrl(value.trim());
        setClipboardMessage('Link pasted from clipboard');
      } else setClipboardMessage('Your clipboard is empty');
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
    const key = `media-${index}-${media.type === 'image' || media.type === 'profile' ? imageFormat : 'original'}`;
    setLocalStatus(key, 'loading');
    try {
      const blob = await fileMutation.mutateAsync({
        data: {
          downloadId: result.downloadId,
          assetType: 'media',
          mediaIndex: index,
          format: media.type === 'image' || media.type === 'profile' ? imageFormat : 'original',
          bitrate: audioBitrate,
        },
      });
      const extension = media.type === 'video' ? (media.format === 'unknown' ? 'mp4' : media.format) : imageFormat === 'webp' ? 'webp' : media.format === 'unknown' ? 'jpg' : media.format;
      const postfix = result.media.length > 1 ? `-${index + 1}` : '';
      saveBlob(blob, `${safeName(result.title)}${postfix}.${extension}`);
      setLocalStatus(key, 'done');
    } catch (error) {
      setLocalStatus(key, 'error', errorText(error));
    }
  };

  const downloadAvatar = async (downloadId: string, creator: DownloadResult['creator'], title: string) => {
    if (!creator.avatarUrl) return;
    const key = `avatar-${downloadId}`;
    setLocalStatus(key, 'loading');
    try {
      const blob = await fileMutation.mutateAsync({ data: { downloadId, assetType: 'avatar', mediaIndex: null, format: 'original', bitrate: 320 } });
      saveBlob(blob, `${safeName(creator.handle || creator.name || title)}-profile-photo`);
      setLocalStatus(key, 'done');
    } catch (error) {
      setLocalStatus(key, 'error', errorText(error));
    }
  };

  const downloadAudio = async () => {
    if (!result || !audioAvailable) return;
    const key = `audio-${audioBitrate}`;
    setLocalStatus(key, 'loading');
    try {
      const blob = await fileMutation.mutateAsync({ data: { downloadId: result.downloadId, assetType: 'audio', mediaIndex: null, format: 'mp3', bitrate: audioBitrate } });
      saveBlob(blob, `${safeName(result.title)}-${audioBitrate}kbps.mp3`);
      setLocalStatus(key, 'done');
    } catch (error) {
      setLocalStatus(key, 'error', errorText(error));
    }
  };

  const downloadStory = async (story: NonNullable<typeof highlight>['stories'][number]) => {
    if (!highlight) return;
    const key = `story-${story.storyNumber}`;
    setLocalStatus(key, 'loading');
    try {
      const blob = await fileMutation.mutateAsync({
        data: { downloadId: highlight.downloadId, assetType: 'media', mediaIndex: story.mediaIndex, format: 'original', bitrate: 320 },
      });
      saveBlob(blob, `${safeName(highlight.title)}-story-${story.storyNumber}.${story.type === 'video' ? 'mp4' : 'jpg'}`);
      setLocalStatus(key, 'done');
    } catch (error) {
      setLocalStatus(key, 'error', errorText(error));
    }
  };

  const downloadAllStories = async () => {
    if (!highlight) return;
    setLocalStatus('all-stories', 'loading');
    try {
      for (const story of highlight.stories) {
        const blob = await fileMutation.mutateAsync({
          data: { downloadId: highlight.downloadId, assetType: 'media', mediaIndex: story.mediaIndex, format: 'original', bitrate: 320 },
        });
        saveBlob(blob, `${safeName(highlight.title)}-story-${story.storyNumber}.${story.type === 'video' ? 'mp4' : 'jpg'}`);
      }
      setLocalStatus('all-stories', 'done');
    } catch (error) {
      setLocalStatus('all-stories', 'error', errorText(error));
    }
  };

  const activeDownloadKey = `media-${activeIndex}-${isImage ? imageFormat : 'original'}`;
  const avatarDownloadKey = result ? `avatar-${result.downloadId}` : '';
  const audioDownloadKey = `audio-${audioBitrate}`;
  const resultHasMetadata = Boolean(result && (result.title || result.caption || result.description || result.hashtags.length || result.creator.name || result.creator.handle));

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand" aria-label="OmniDownloader">
          <span className="brand-mark" aria-hidden="true"><ArrowDownToLine size={18} strokeWidth={2.3} /></span>
          <span className="brand-name">OmniDownloader</span>
        </div>
        <div className="topbar-note" data-testid="status-service">
          <span className={`live-dot ${serviceUnavailable ? 'offline' : ''}`} />
          {healthQuery.isLoading ? 'Checking service' : serviceUnavailable ? 'Service unavailable' : 'Ready for a public link'}
        </div>
      </header>

      <main className="main">
        <section className="intro">
          <div className="eyebrow">A simple place to keep a post</div>
          <h1 className="hero-title">Your saved posts,<br /><span>without the noise.</span></h1>
          <p className="hero-copy">Bring a public Instagram, TikTok, or Pinterest link. We’ll show what’s available to save, with no account or detours.</p>
        </section>

        <form className="composer" onSubmit={submit} data-testid="form-download">
          <div className="mode-control" role="group" aria-label="Link type">
            <button className={`mode-option ${mode === 'post' ? 'active' : ''}`} type="button" aria-pressed={mode === 'post'} onClick={() => setMode('post')} data-testid="button-mode-post"><Video size={14} /> Post</button>
            <button className={`mode-option ${mode === 'profile' ? 'active' : ''}`} type="button" aria-pressed={mode === 'profile'} onClick={() => setMode('profile')} data-testid="button-mode-profile"><UserRound size={14} /> Profile photo</button>
          </div>
          <div className="platform-control" role="group" aria-label="Choose source platform">
            <span className="platform-control-label">Platform</span>
            {(['auto', 'instagram', 'tiktok', 'pinterest'] as PlatformChoice[]).map((platform) => (
              <button className={`platform-option ${platformChoice === platform ? 'active' : ''}`} type="button" key={platform} onClick={() => setPlatformChoice(platform)} aria-pressed={platformChoice === platform} data-testid={`button-platform-${platform}`}>
                {platform === 'auto' ? 'Auto' : platform[0].toUpperCase() + platform.slice(1)}
              </button>
            ))}
          </div>
          <div className="form-row">
            <div className="url-wrap">
              <Link2 className="url-icon" size={17} aria-hidden="true" />
              <label className="sr-only" htmlFor="post-url">{mode === 'profile' ? 'Public profile URL' : 'Public post URL'}</label>
              <input
                id="post-url"
                className="url-input"
                type={mode === 'profile' && platformChoice !== 'auto' ? 'text' : 'url'}
                autoComplete="url"
                inputMode={mode === 'profile' && platformChoice !== 'auto' ? 'text' : 'url'}
                placeholder={mode === 'profile' ? platformChoice === 'auto' ? 'Paste a public profile link' : 'Paste a profile link or @handle' : 'Paste a public post link'}
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value);
                  setClipboardMessage('');
                  if (extractMutation.isError || extractMutation.data) extractMutation.reset();
                  if (highlightMutation.isError || highlightMutation.data) highlightMutation.reset();
                }}
                disabled={loading}
                aria-describedby="permission-note"
                data-testid="input-post-url"
              />
              <button className="paste-button" type="button" onClick={pasteFromClipboard} disabled={loading} aria-label="Paste link from clipboard" data-testid="button-paste">Paste</button>
            </div>
            <button className="submit-button" type="submit" disabled={loading || !url.trim()} data-testid="button-download">
              {loading ? <><span className="loader" aria-hidden="true" /> Looking it up</> : <>Show available media <ArrowDownToLine size={15} /></>}
            </button>
          </div>
          <div className="composer-foot">
            <div className="permission" id="permission-note"><LockKeyhole size={13} aria-hidden="true" /> Public posts you’re authorized to keep</div>
            <div className="platforms" aria-label="Supported platforms"><span>Instagram</span><span>TikTok</span><span>Pinterest</span></div>
          </div>
        </form>

        <div className="status-line" aria-live="polite" role={extractionError ? 'alert' : 'status'}>
          {serviceUnavailable && !loading && (
            <div className="error-message" data-testid="status-unavailable"><CircleAlert size={16} /> The service health check could not confirm availability. You can still try your link; any request failure will be shown here.</div>
          )}
          {loading && <div className="loading-message" data-testid="status-loading"><span className="loader" /><span>{isStoryUrl ? 'Finding public stories in this highlight…' : 'Checking the public link and available media…'}</span></div>}
          {!loading && extractionError && <div className="error-message" data-testid="status-error"><CircleAlert size={16} /><span>{extractionError}</span></div>}
          {!loading && !extractionError && clipboardMessage && <div className="notice-message" data-testid="status-clipboard"><Clipboard size={14} />{clipboardMessage}</div>}
          {loading && <div className="loading-skeleton" aria-label="Loading result"><span /><span /><span /></div>}
        </div>
        {!result && !highlight && !loading && !extractionError && (
          <div className="empty-state" data-testid="empty-state">
            <span className="empty-state-mark"><Link2 size={17} /></span>
            <div><strong>Start with a public link</strong><p>Paste a post, profile, or Instagram highlight above. We’ll show only the files the source makes available.</p></div>
          </div>
        )}

        <AnimatePresence mode="wait">
          {result && !loading && (
            <motion.section
              className="result-card"
              aria-label="Download result"
              data-testid="result-card"
              initial={{ opacity: 0, y: 12, scale: .99 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ type: 'spring', stiffness: 280, damping: 27 }}
            >
              <div className="result-top">
                <div className="ready-label"><span className="check-mark"><Check size={13} strokeWidth={2.8} /></span>{mediaItems.length ? 'Available to save' : 'Post details found'}</div>
                <span className="platform-tag" data-testid="text-platform">{result.platform}</span>
              </div>
              <div className="result-layout">
                <div className="preview-column">
                  <div className="preview" data-testid="preview-media">
                    {previewUrl ? <img src={previewUrl} alt={`Preview of ${result.title || 'the selected post'}`} data-testid="img-preview" /> : (
                      <div className="preview-empty">
                        {activeMedia?.type === 'video' ? <Video size={22} /> : activeMedia ? <ImageIcon size={22} /> : <CircleAlert size={22} />}
                        <span>{activeMedia ? 'Preview unavailable' : 'No media files were returned for this link.'}</span>
                      </div>
                    )}
                    {mediaItems.length > 1 && <span className="media-count">{activeIndex + 1} / {mediaItems.length}</span>}
                  </div>
                  {mediaItems.length > 1 && (
                    <div className="preview-nav" aria-label="Select media item">
                      {mediaItems.map((item, index) => (
                        <button className={`preview-thumb ${index === activeIndex ? 'active' : ''}`} key={`${item.url}-${index}`} type="button" onClick={() => setSelectedMedia(index)} aria-label={`Select item ${index + 1}, ${item.quality || item.type}`} aria-pressed={index === activeIndex} data-testid={`button-select-media-${index}`}>
                          {item.type === 'image' || item.type === 'profile' ? <img src={item.url} alt="" /> : <span className="thumb-placeholder"><Video size={16} /></span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="result-details">
                  <div className="creator-row">
                    <Avatar creator={result.creator} />
                    <div className="creator-copy">
                      <div className="creator-name">
                        {result.creator.name || result.creator.handle || 'Creator details unavailable'}
                        {result.creator.verified && <BadgeCheck size={14} color="#9bd9b7" aria-label="Verified creator" />}
                      </div>
                      {result.creator.handle && <div className="creator-handle">{result.creator.handle.startsWith('@') ? result.creator.handle : `@${result.creator.handle}`}</div>}
                    </div>
                    {result.creator.profileUrl && <a className="creator-link" href={result.creator.profileUrl} target="_blank" rel="noreferrer" data-testid="link-creator-profile"><ExternalLink size={13} /> Profile</a>}
                  </div>
                  <h2 className="result-title" data-testid="text-result-title">{result.title || 'Untitled post'}</h2>
                  <div className="result-meta" data-testid="text-result-type">
                    <span>{resultTypeLabel(result)}</span><span className="meta-dot" /><span>{result.platform}</span><span className="meta-dot" /><span>{mediaItems.length} {mediaItems.length === 1 ? 'file' : 'files'}</span>
                    {result.uploadDate && <><span className="meta-dot" /><span>{result.uploadDate}</span></>}
                    {result.boardName && <><span className="meta-dot" /><span>{result.boardName}</span></>}
                  </div>

                  {!resultHasMetadata && <div className="metadata-empty">Some details were not provided by the source. Available files are listed below.</div>}
                  <div className="desktop-metadata">
                    <Metadata result={result} onCopy={copyText} copied={copied} />
                  </div>
                  <details className="mobile-details">
                    <summary>Caption &amp; tags <ChevronDown size={15} /></summary>
                    <Metadata result={result} onCopy={copyText} copied={copied} />
                  </details>

                  <div className="download-section">
                    <div className="download-section-head"><span>Save to this device</span><span>{mediaItems.length ? `${mediaItems.length} available` : 'Unavailable'}</span></div>
                    {mediaItems.length > 0 && (
                      <>
                        <div className="selection-row">
                          {qualityOptions.length > 0 && !isImage && (
                            <label className="selection-field">Quality
                              <select aria-label="Video quality" value={qualityOptions.some(({ index }) => index === activeIndex) ? String(activeIndex) : String(qualityOptions[0].index)} onChange={(event) => setSelectedMedia(Number(event.target.value))} data-testid="select-quality">
                                {qualityOptions.map(({ item, index }) => <option value={index} key={`${item.quality}-${index}`}>{item.quality}</option>)}
                              </select>
                            </label>
                          )}
                          {isImage && (
                            <label className="selection-field">Image format
                              <select aria-label="Image format" value={imageFormat} onChange={(event) => setImageFormat(event.target.value as 'original' | 'webp')} data-testid="select-image-format">
                                <option value="original">Original</option><option value="webp">WebP</option>
                              </select>
                            </label>
                          )}
                          {audioAvailable && (
                            <label className="selection-field">Audio quality
                              <select aria-label="MP3 bitrate" value={audioBitrate} onChange={(event) => setAudioBitrate(Number(event.target.value) as 128 | 320)} data-testid="select-audio-bitrate">
                                <option value={320}>MP3 · 320 kbps</option><option value={128}>MP3 · 128 kbps</option>
                              </select>
                            </label>
                          )}
                        </div>
                        <button className="download-button" type="button" onClick={() => downloadMedia(activeIndex)} disabled={downloadState[activeDownloadKey] === 'loading'} data-testid="button-save-media">
                          {downloadState[activeDownloadKey] === 'loading' ? <><span className="loader" /> Preparing file</> : downloadState[activeDownloadKey] === 'done' ? <><Check size={15} /> Saved to downloads</> : <>Download {isImage ? 'image' : 'video'} <ArrowDownToLine size={15} /></>}
                        </button>
                        {downloadErrors[activeDownloadKey] && <div className="download-error" role="alert"><CircleAlert size={14} />{downloadErrors[activeDownloadKey]}</div>}
                        <div className="secondary-actions">
                          {result.creator.avatarUrl && (
                            <button className="download-button" type="button" onClick={() => downloadAvatar(result.downloadId, result.creator, result.title)} disabled={downloadState[avatarDownloadKey] === 'loading'} data-testid="button-save-profile-photo">
                              {downloadState[avatarDownloadKey] === 'loading' ? <><span className="loader" /> Preparing</> : downloadState[avatarDownloadKey] === 'done' ? <><Check size={14} /> Profile photo saved</> : <><UserRound size={14} /> Save profile photo</>}
                            </button>
                          )}
                          {audioAvailable && (
                            <button className="download-button primary-subtle" type="button" onClick={downloadAudio} disabled={downloadState[audioDownloadKey] === 'loading'} data-testid="button-save-audio">
                              {downloadState[audioDownloadKey] === 'loading' ? <><span className="loader" /> Preparing</> : downloadState[audioDownloadKey] === 'done' ? <><Check size={14} /> Audio saved</> : <><Music2 size={14} /> MP3 audio</>}
                            </button>
                          )}
                        </div>
                        {downloadErrors[avatarDownloadKey] && <div className="download-error" role="alert"><CircleAlert size={14} />{downloadErrors[avatarDownloadKey]}</div>}
                        {downloadErrors[audioDownloadKey] && <div className="download-error" role="alert"><CircleAlert size={14} />{downloadErrors[audioDownloadKey]}</div>}
                      </>
                    )}
                    {mediaItems.length === 0 && <div className="metadata-empty">No downloadable media was returned for this post. Try a different public link.</div>}
                    {audioAvailable && <div className="metadata-empty" style={{ marginTop: 9 }}><AudioLines size={13} style={{ verticalAlign: 'middle', marginRight: 5 }} />Audio is available from this public video.</div>}
                  </div>
                </div>
              </div>
            </motion.section>
          )}
        </AnimatePresence>

        <AnimatePresence mode="wait">
          {highlight && !loading && (
            <motion.section className="result-card highlight-card" aria-label="Instagram highlight stories" data-testid="result-highlight" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} transition={{ type: 'spring', stiffness: 280, damping: 27 }}>
              <div className="result-top">
                <div className="ready-label"><span className="check-mark"><Check size={13} /></span>Highlight stories are ready</div>
                <span className="platform-tag">Instagram</span>
              </div>
              <div className="highlight-content">
                <div className="highlight-heading">
                  <div className="highlight-cover">
                    {highlight.cover ? <img src={highlight.cover} alt="" /> : <ImageIcon size={22} />}
                  </div>
                  <div className="highlight-title-block">
                    <h2 className="result-title">{highlight.title || 'Instagram highlight'}</h2>
                    <div className="creator-handle">{highlight.creator.name || highlight.creator.handle || 'Creator details unavailable'}</div>
                    <div className="highlight-story-count">{highlight.stories.length} {highlight.stories.length === 1 ? 'story' : 'stories'} available</div>
                  </div>
                  {highlight.creator.avatarUrl && (
                    <button className="creator-link" type="button" onClick={() => downloadAvatar(highlight.downloadId, highlight.creator, highlight.title)} disabled={downloadState[`avatar-${highlight.downloadId}`] === 'loading'} data-testid="button-save-highlight-avatar">
                      {downloadState[`avatar-${highlight.downloadId}`] === 'loading' ? <span className="loader" /> : downloadState[`avatar-${highlight.downloadId}`] === 'done' ? <Check size={13} /> : <UserRound size={13} />}
                      Save profile photo
                    </button>
                  )}
                </div>
                {highlight.truncated && <div className="highlight-notice"><CircleAlert size={14} /> This highlight contains more stories than could be listed. Only the stories shown below are available in this result.</div>}
                {highlight.stories.length > 0 ? (
                  <>
                    <div className="highlight-list-heading"><span>Stories</span><span>Numbered in source order</span></div>
                    <div className="highlight-list">
                      {highlight.stories.map((story) => {
                        const key = `story-${story.storyNumber}`;
                        return (
                          <article className="story-row" key={`${story.storyNumber}-${story.mediaIndex}`} data-testid={`story-row-${story.storyNumber}`}>
                            <div className="story-thumb">
                              {story.thumbnail ? <img src={story.thumbnail} alt="" /> : story.type === 'video' ? <Video size={16} /> : <ImageIcon size={16} />}
                            </div>
                            <div className="story-copy">
                              <div className="story-name">Story {story.storyNumber}<span className="story-type">{story.type}</span></div>
                              <div className="story-meta">
                                {story.duration != null && <span>{story.duration}s</span>}
                                {story.duration != null && story.createdAt && <span className="meta-dot" />}
                                {story.createdAt && <span>{story.createdAt}</span>}
                              </div>
                            </div>
                            <button className="story-download" type="button" onClick={() => downloadStory(story)} disabled={downloadState[key] === 'loading'} aria-label={`Download story ${story.storyNumber}`} data-testid={`button-download-story-${story.storyNumber}`}>
                              {downloadState[key] === 'loading' ? <span className="loader" /> : downloadState[key] === 'done' ? <Check size={15} /> : <ArrowDownToLine size={15} />}
                              <span>{downloadState[key] === 'done' ? 'Saved' : 'Save'}</span>
                            </button>
                            {downloadErrors[key] && <div className="download-error story-error" role="alert"><CircleAlert size={14} />{downloadErrors[key]}</div>}
                          </article>
                        );
                      })}
                    </div>
                    <button className="download-button highlight-download-all" type="button" onClick={downloadAllStories} disabled={downloadState['all-stories'] === 'loading'} data-testid="button-download-all-stories">
                      {downloadState['all-stories'] === 'loading' ? <><span className="loader" /> Preparing stories</> : downloadState['all-stories'] === 'done' ? <><Check size={15} /> All listed stories saved</> : <>Save all listed stories <ArrowDownToLine size={15} /></>}
                    </button>
                    {downloadErrors['all-stories'] && <div className="download-error" role="alert"><CircleAlert size={14} />{downloadErrors['all-stories']}</div>}
                  </>
                ) : <div className="metadata-empty">No stories were returned for this highlight. Try another public highlight link.</div>}
              </div>
            </motion.section>
          )}
        </AnimatePresence>

        <div className="disclaimer" data-testid="text-privacy-note"><ShieldCheck size={14} /> OmniDownloader processes public posts only. You must have permission to keep the content. It does not remove watermarks or bypass private access.</div>
      </main>

      <footer className="footer">
        <span><strong>OmniDownloader</strong> · Nothing extra between the link and your file.</span>
        <span>Public media only. Respect the creator’s rights.</span>
      </footer>
    </div>
  );
}

function App() {
  return <QueryClientProvider client={queryClient}><Downloader /></QueryClientProvider>;
}

export default App;
