import type { ChatProvider } from './chat-provider.js';
import type { AssetRef } from './session.js';

/** A durable, session-owned presentation. Status is explicit, never inferred from prose. */
export interface ArtifactPresentation {
  id: string;
  title: string;
  kind: ArtifactKind | 'image';
  status: 'generating' | 'ready' | 'failed';
  provider: ChatProvider;
  artifactId?: string;
  revision?: number;
  asset?: AssetRef;
  openId?: string;
}

export const ARTIFACT_KINDS = ['code', 'web', 'markdown', 'document', 'diagram', 'data'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export type ArtifactRevisionSource = 'provider' | 'user' | 'model' | 'filesystem';

export interface ArtifactOrigin {
  provider: ChatProvider;
  conversationId?: string;
  turnId?: string;
  messageId?: string;
  providerArtifactId?: string;
  /** Response-scoped rendered surface, without an invented provider artifact/revision id. */
  nativeSurface?: string;
}

export interface ArtifactCapabilities {
  preview: boolean;
  edit: boolean;
  export: boolean;
  providerWriteback: boolean;
}

/** Exact retained source for one logical file in an artifact revision. */
export interface ArtifactFile {
  path: string;
  text: string;
  bytes: number;
  sha256: string;
  mimeType?: string;
  language?: string;
}

export interface ArtifactRevision {
  artifactId: string;
  revision: number;
  parentRevision?: number;
  /** Immutable revision identity supplied by a native provider artifact, when imported. */
  providerRevisionId?: string;
  /** Provider-native parent revision identity; never inferred from local revision numbers. */
  providerParentRevisionId?: string;
  source: ArtifactRevisionSource;
  createdAt: number;
  files: ArtifactFile[];
  messageId?: string;
}

export interface Artifact {
  id: string;
  sessionId: string;
  projectId?: string;
  title: string;
  kind: ArtifactKind;
  origin: ArtifactOrigin;
  headRevision: number;
  retainedFromRevision: number;
  entrypoint?: string;
  createdAt: number;
  updatedAt: number;
  capabilities: ArtifactCapabilities;
}

export interface ArtifactSnapshot {
  artifact: Artifact;
  revision: ArtifactRevision;
}

export interface ArtifactSummary {
  id: string;
  sessionId: string;
  projectId?: string;
  title: string;
  kind: ArtifactKind;
  headRevision: number;
  retainedFromRevision: number;
  entrypoint?: string;
  updatedAt: number;
  origin: ArtifactOrigin;
  capabilities: ArtifactCapabilities;
}

export interface ArtifactOpenRequest {
  sessionId: string;
  artifactId: string;
  /** Exact retained revision selected by a revision-aware opener. Legacy UI opens may omit it. */
  revision?: number;
}

export interface ArtifactExportResult {
  artifactId: string;
  revision: number;
  projectId: string;
  /** Project-relative directory created exclusively for this export. */
  directory: string;
  files: string[];
}

export type ArtifactPatchOperation =
  | { op: 'upsert'; path: string; text: string; mimeType?: string; language?: string }
  | { op: 'delete'; path: string };
