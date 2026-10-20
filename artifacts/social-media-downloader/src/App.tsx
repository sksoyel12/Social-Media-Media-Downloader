import { useState, type FormEvent } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useDownloadMedia, useHealthCheck } from '@workspace/api-client-react';
import type { DownloadResult } from '@workspace/api-client-react';
import {
  ArrowDownToLine,
  Check,
  CircleAlert,
  Clipboard,
  Download,
  Image as ImageIcon,
  Link2,
  LockKeyhole,
  ShieldCheck,
  Video,
} from 'lucide-react';

const queryClient = new QueryClient();

function errorText(error: unknown): string {
  if (error && typeof error === 'object') {
    const candidate = error as { message?: string; error?: string; data?: { error?: string }; response?: { data?: { error?: string } } };
    return candidate.response?.data?.error || candidate.data?.error || candidate.error || candidate.message || 'We couldn’t retrieve this post. Check the link and try again.';
  }
  return 'We couldn’t retrieve this post. Check the link and try again.';
}

function fileName(result: DownloadResult, format: string, index: number) {
  const title = result.title.trim().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-').slice(0, 48) || 'saved-media';
  return `${title}${result.media.length > 1 ? `-${index + 1}` : ''}.${format.toLowerCase()}`;
}

function Downloader() {
  const [url, setUrl] = useState('');
  const [clipboardMessage, setClipboardMessage] = useState('');
  const downloadMutation = useDownloadMedia();
  const healthQuery = useHealthCheck();
  const result = downloadMutation.data;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setClipboardMessage('');
    const trimmed = url.trim();
    if (!trimmed) return;
    try {
      const parsed = new URL(trimmed);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid');
    } catch {
      downloadMutation.reset();
      setClipboardMessage('Enter a complete post URL starting with http:// or https://');
      return;
    }
    downloadMutation.mutate({ data: { url: trimmed } });
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
      setClipboardMessage('Clipboard access is unavailable. Paste your link into the field.');
    }
  };

  const isLoading = downloadMutation.isPending;
  const extractionError = downloadMutation.isError ? errorText(downloadMutation.error) : '';
  const serviceUnavailable = healthQuery.isError || healthQuery.data?.status !== 'ok';
  const typeLabel = result?.type === 'carousel' ? 'Carousel' : result?.type === 'video' ? 'Video' : 'Image';

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand" aria-label="stillframe home">
          <span className="brand-mark" aria-hidden="true"><ArrowDownToLine size={18} strokeWidth={2.2} /></span>
          <span className="brand-name">stillframe</span>
        </div>
        <div className="topbar-note" data-testid="status-service">
          <span className="live-dot" />
          {healthQuery.isLoading ? 'Checking service' : serviceUnavailable ? 'Service connection' : 'Ready when you are'}
        </div>
      </header>

      <main className="main">
        <div className="eyebrow">Save what you’re allowed to keep</div>
        <h1 className="hero-title">A post link.<br /><span>Your file.</span></h1>
        <p className="hero-copy">
          Paste a public post link and get the original media, ready to save. No ads, no detours, no account needed.
        </p>

        <form className="drop-panel" onSubmit={submit} data-testid="form-download">
          <div className="input-row">
            <div className="url-wrap">
              <Link2 className="url-icon" size={18} aria-hidden="true" />
              <label className="sr-only" htmlFor="post-url">Public post URL</label>
              <input
                id="post-url"
                className="url-input"
                type="url"
                autoComplete="url"
                inputMode="url"
                placeholder="Paste a post link here"
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value);
                  if (clipboardMessage) setClipboardMessage('');
                  if (downloadMutation.isError || downloadMutation.data) downloadMutation.reset();
                }}
                disabled={isLoading}
                aria-describedby="url-hint"
                data-testid="input-post-url"
              />
              <button
                className="paste-button"
                type="button"
                onClick={pasteFromClipboard}
                disabled={isLoading}
                aria-label="Paste link from clipboard"
                data-testid="button-paste"
              >
                Paste
              </button>
            </div>
            <button className="submit-button" type="submit" disabled={isLoading || !url.trim()} data-testid="button-download">
              {isLoading ? <><span className="loader" aria-hidden="true" /> Finding media</> : <>Get media <Download size={16} /></>}
            </button>
          </div>
          <div className="panel-foot">
            <div className="supported" id="url-hint"><LockKeyhole size={13} aria-hidden="true" /> Public posts you’re authorized to download</div>
            <div className="platform-list" aria-label="Supported platforms">
              <span>Instagram</span><span>TikTok</span><span>Pinterest</span>
            </div>
          </div>
        </form>

        <div className="status-line" aria-live="polite" role={extractionError ? 'alert' : 'status'}>
          {isLoading && (
            <div className="loading-message" data-testid="status-loading">
              <span className="loader" aria-hidden="true" />
              <span>Checking the public post and preparing available media…</span>
            </div>
          )}
          {!isLoading && extractionError && (
            <div className="error-message" data-testid="status-error">
              <CircleAlert size={16} aria-hidden="true" />
              <span>{extractionError}</span>
            </div>
          )}
          {!isLoading && !extractionError && clipboardMessage && (
            <div className="loading-message" data-testid="status-clipboard"><Clipboard size={14} aria-hidden="true" />{clipboardMessage}</div>
          )}
        </div>

        {result && !isLoading && (
          <section className="result-card" aria-label="Download result" data-testid="result-card">
            <div className="result-head">
              <div className="result-label"><span className="success-mark"><Check size={13} strokeWidth={2.8} /></span> Media is ready</div>
              <span className="platform-tag" data-testid="text-platform">{result.platform}</span>
            </div>
            <div className="result-body">
              <div className="preview" data-testid="preview-media">
                {result.thumbnail ? (
                  <img src={result.thumbnail} alt={`Preview of ${result.title || 'the selected post'}`} data-testid="img-preview" />
                ) : (
                  <div className="preview-placeholder">
                    {result.type === 'video' ? <Video size={21} /> : <ImageIcon size={21} />}
                    <span>{typeLabel} preview</span>
                  </div>
                )}
              </div>
              <div className="result-info">
                <h2 className="result-title" data-testid="text-result-title">{result.title || 'Untitled post'}</h2>
                <div className="result-meta" data-testid="text-result-type">{result.platform} <span className="divider" /> {typeLabel} <span className="divider" /> {result.media.length} {result.media.length === 1 ? 'file' : 'files'}</div>
              </div>
            </div>
            <div className="download-list">
              {result.media.map((media, index) => {
                const format = media.format === 'unknown' ? 'file' : media.format;
                const downloadLabel = result.type === 'video'
                  ? 'Download MP4'
                  : format === 'file'
                    ? 'Download file'
                    : 'Download image';
                return (
                  <a
                    className="download-action"
                    key={`${media.url}-${index}`}
                    href={media.url}
                    download={fileName(result, format, index)}
                    rel="noreferrer"
                    referrerPolicy="no-referrer"
                    aria-label={`Download ${media.format} ${media.quality}`}
                    data-testid={`link-download-${index}`}
                  >
                    <span className="download-details">
                      <span className="format-chip">{format.toUpperCase()}</span>
                      <span className="quality-text">{media.quality || 'Original quality'}</span>
                    </span>
                    <span className="download-link-label">{downloadLabel} <ArrowDownToLine size={14} /></span>
                  </a>
                );
              })}
            </div>
          </section>
        )}

        <div className="privacy-note" data-testid="text-privacy-note">
          <ShieldCheck size={14} aria-hidden="true" />
          <span>Private by design</span>
          <span className="divider" />
          <span>No account required</span>
          <span className="divider" />
          <span>Public media only</span>
        </div>
      </main>

      <footer className="footer">
        <span><strong>stillframe</strong> — a quieter way to save.</span>
        <span>Only download public media you have permission to keep.</span>
      </footer>
    </div>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Downloader />
    </QueryClientProvider>
  );
}

export default App;
