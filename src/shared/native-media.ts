import type { AssetRef, SessionEvent } from './session.js';

export type NativeMediaPreviewError = 'not_mounted' | 'not_loaded' | 'ambiguous' | 'tainted' | 'oversized' | 'invalid' | 'quota' | 'removed';
export interface NativeMediaItem {
  kind: 'image' | 'video';
  sessionId: string;
  messageId: string;
  providerAssetId: string;
  providerRole: 'tool' | 'assistant';
  providerStatus?: 'in_progress' | 'finished_successfully';
  time: number;
  width?: number;
  height?: number;
  durationMs?: number;
  mimeType?: 'video/mp4' | 'video/webm';
  previewStatus: 'pending' | 'available' | 'unavailable';
  previewError?: NativeMediaPreviewError;
  previewWidth?: number;
  previewHeight?: number;
  asset?: AssetRef;
}

export interface NativeMediaSaveResult {
  kind: 'image' | 'video';
  projectId: string;
  relativePath: string;
  bytes: number;
  mimeType: string;
}
export interface NativeVideoPlayback { token: string; mimeType: 'video/mp4' | 'video/webm'; bytes: number }
export interface NativeVideoPlaybackChunk { data: string; offset: number; nextOffset: number; totalBytes: number; done: boolean }

export function nativeMediaItem(sessionId: string, event: Extract<SessionEvent, { kind: 'native_image' | 'native_video' }>): NativeMediaItem {
  return { kind: event.kind === 'native_video' ? 'video' : 'image', sessionId, messageId: event.messageId, providerAssetId: event.providerAssetId,
    providerRole: event.providerRole, providerStatus: event.providerStatus, time: event.time, width: event.width, height: event.height,
    ...(event.kind === 'native_video' ? { durationMs: event.durationMs, mimeType: event.mimeType } : {}), previewStatus: event.previewStatus,
    previewError: event.previewError, previewWidth: event.previewWidth, previewHeight: event.previewHeight, asset: event.asset };
}
