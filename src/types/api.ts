export type Mode = 'post' | 'profile';
export type Platform = 'instagram' | 'tiktok' | 'pinterest' | 'youtube';
export type PlatformChoice = Platform | 'auto';

export interface DownloadCreator {
  handle: string | null;
  name: string | null;
  avatarUrl: string | null;
  profileUrl: string | null;
  verified: boolean;
}

export interface DownloadMedia {
  url: string;
  rawUrl?: string;
  downloadUrl?: string;
  thumbnail?: string | null;
  type: 'video' | 'image' | 'profile';
  quality: string;
  format: string;
  width: number | null;
  height: number | null;
  aspectRatio?: 'vertical' | 'horizontal' | 'square';
  hasAudio: boolean;
}

export interface DownloadResult {
  downloadId: string;
  status: 'success';
  platform: Platform;
  type: 'video' | 'image' | 'carousel' | 'profile';
  /** TikTok: 'video' (watermark-free MP4) or 'slideshow' (photo slides). */
  mediaType?: 'video' | 'slideshow';
  title: string;
  caption: string;
  description: string;
  uploadDate: string | null;
  boardName: string | null;
  hashtags: string[];
  thumbnail: string | null;
  audioUrl?: string | null;
  creator: DownloadCreator;
  media: DownloadMedia[];
  audioAvailable: boolean;
}

export interface HighlightStory {
  storyNumber: number;
  mediaIndex: number;
  type: 'photo' | 'video';
  duration: number | null;
  thumbnail: string | null;
  createdAt: string | null;
  url?: string;
  downloadUrl?: string;
}

export interface HighlightResult {
  downloadId: string;
  title: string;
  cover: string | null;
  creator: DownloadCreator;
  stories: HighlightStory[];
  truncated: boolean;
  requiresDirectLinkAlert?: boolean;
  alertMessage?: string;
  /** Which pipeline stage produced the media (graphql, reels_media, embed, mirror:<name>). */
  source?: string;
}

export interface HealthStatus {
  status: string;
}

export interface DownloadInput {
  url: string;
  mode?: Mode;
  platform?: Platform | null;
}

export interface HighlightInput {
  url: string;
}

export interface DownloadFileInput {
  downloadId?: string;
  url?: string;
  filename?: string;
  assetType: 'media' | 'avatar' | 'audio' | 'archive';
  mediaIndex: number | null;
  format: 'original' | 'webp' | 'mp3';
  bitrate: 128 | 320;
  items?: Array<{ url: string; type: string; filename?: string }>;
  platform?: Platform;
  title?: string;
}
