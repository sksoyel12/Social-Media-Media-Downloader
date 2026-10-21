import { motion } from 'framer-motion';
import {
  Archive,
  ArrowDownToLine,
  Check,
  CircleAlert,
  Image as ImageIcon,
  Sparkles,
  UserRound,
  Video,
} from 'lucide-react';
import type { DownloadResult, HighlightResult, HighlightStory } from '../types/api';

export interface HighlightPackageProps {
  highlight: HighlightResult;
  downloadState: Record<string, 'loading' | 'done' | 'error'>;
  downloadErrors: Record<string, string>;
  onDownloadStory: (story: HighlightStory) => void;
  onDownloadAllStories: () => void;
  onDownloadAvatar: (
    downloadId: string,
    creator: DownloadResult['creator'],
    title: string
  ) => void;
}

export function HighlightPackage({
  highlight,
  downloadState,
  downloadErrors,
  onDownloadStory,
  onDownloadAllStories,
  onDownloadAvatar,
}: HighlightPackageProps) {
  if (highlight.requiresDirectLinkAlert || highlight.stories.length === 0) {
    return (
      <motion.div
        className="ios-alert-card"
        role="alert"
        data-testid="alert-highlight-direct-link"
        initial={{ opacity: 0, y: 12, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8 }}
        transition={{ type: 'spring', stiffness: 300, damping: 26 }}
      >
        <div className="w-12 h-12 rounded-2xl bg-[#a9c2ff]/15 border border-[#a9c2ff]/30 text-[#dce7ff] flex items-center justify-center mx-auto mb-3.5">
          <Sparkles size={22} />
        </div>
        <h2 className="text-base font-semibold text-white tracking-tight">
          Story / Highlight Notice
        </h2>
        <p className="mt-2 text-sm text-[#c5cad3] leading-relaxed">
          {highlight.alertMessage ||
            'This story or highlight is private, expired, or temporarily unavailable.'}
        </p>
        <p className="mt-2 text-xs text-[#8e949f]">
          Verify that the user profile is public and active. For 24-hour stories, ensure the post has not expired.
        </p>
      </motion.div>
    );
  }

  return (
    <motion.section
      className="result-card highlight-card"
      aria-label="Instagram highlight stories"
      data-testid="result-highlight"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      transition={{ type: 'spring', stiffness: 280, damping: 27 }}
    >
      <div className="result-top">
        <div className="ready-label">
          <span className="check-mark">
            <Check size={13} />
          </span>
          Story package ready
        </div>
        <span className="platform-label">INSTAGRAM</span>
      </div>

      <div className="highlight-content">
        <div className="highlight-heading">
          <div className="highlight-cover">
            {highlight.cover ? (
              <img src={highlight.cover} alt="" referrerPolicy="no-referrer" />
            ) : (
              <ImageIcon size={22} />
            )}
          </div>
          <div className="highlight-title-block">
            <h2 className="result-title">{highlight.title || 'Instagram story'}</h2>
            <div className="creator-handle">
              {highlight.creator.name || highlight.creator.handle || 'Public Instagram story'}
            </div>
            <div className="highlight-story-count">
              {highlight.stories.length} {highlight.stories.length === 1 ? 'story' : 'stories'}{' '}
              available
            </div>
          </div>
          {highlight.creator.avatarUrl && (
            <button
              className="creator-link"
              type="button"
              onClick={() =>
                onDownloadAvatar(highlight.downloadId, highlight.creator, highlight.title)
              }
              disabled={downloadState[`avatar-${highlight.downloadId}`] === 'loading'}
              data-testid="button-save-highlight-avatar"
            >
              {downloadState[`avatar-${highlight.downloadId}`] === 'loading' ? (
                <span className="loader" />
              ) : (
                <UserRound size={13} />
              )}
              Save DP
            </button>
          )}
        </div>

        <button
          className="download-button"
          type="button"
          onClick={onDownloadAllStories}
          disabled={downloadState['all-stories'] === 'loading'}
          data-testid="button-save-all-stories"
        >
          {downloadState['all-stories'] === 'loading' ? (
            <>
              <span className="loader" /> Bundling stories…
            </>
          ) : downloadState['all-stories'] === 'done' ? (
            <>
              <Check size={15} /> All stories saved (ZIP)
            </>
          ) : (
            <>
              <Archive size={15} /> Download All ({highlight.stories.length} Stories ZIP)
            </>
          )}
        </button>

        {downloadErrors['all-stories'] && (
          <div className="download-error" role="alert">
            <CircleAlert size={14} />
            {downloadErrors['all-stories']}
          </div>
        )}

        <div className="stories-list">
          {highlight.stories.map((story) => {
            const key = `story-${story.storyNumber}`;
            return (
              <div
                className="story-row"
                key={story.storyNumber}
                data-testid={`row-story-${story.storyNumber}`}
              >
                <div className="story-thumb">
                  {story.thumbnail ? (
                    <img src={story.thumbnail} alt="" referrerPolicy="no-referrer" />
                  ) : story.type === 'video' ? (
                    <Video size={17} />
                  ) : (
                    <ImageIcon size={17} />
                  )}
                </div>
                <div className="story-meta">
                  <strong>Story #{story.storyNumber}</strong>
                  <span>
                    {story.type === 'video' ? 'Video' : 'Photo'}
                    {story.duration ? ` · ${Math.round(story.duration)}s` : ''}
                    {story.createdAt ? ` · ${story.createdAt}` : ''}
                  </span>
                  {downloadErrors[key] && (
                    <span className="story-error">{downloadErrors[key]}</span>
                  )}
                </div>
                <button
                  className="story-download"
                  type="button"
                  onClick={() => onDownloadStory(story)}
                  disabled={downloadState[key] === 'loading'}
                  data-testid={`button-save-story-${story.storyNumber}`}
                >
                  {downloadState[key] === 'loading' ? (
                    <>
                      <span className="loader" /> Saving
                    </>
                  ) : downloadState[key] === 'done' ? (
                    <>
                      <Check size={13} /> Saved
                    </>
                  ) : (
                    <>
                      Save <ArrowDownToLine size={13} />
                    </>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </motion.section>
  );
}

export default HighlightPackage;
