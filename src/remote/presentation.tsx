import { useEffect, useRef, useState } from 'react';
import type { ArtifactSnapshot } from '../shared/artifact.js';
import type { ControlApiEvent } from '../shared/control-api.js';
import { createArtifactPreview } from '../renderer/artifact-preview.js';
import { request } from './api.js';
import type { NativeVideoPlayback, NativeVideoPlaybackChunk } from '../shared/native-media.js';
import { Icon } from './composer-controls.js';

function InlineVideo({ sessionId, event, poster }: { sessionId: string; event: ControlApiEvent; poster: string }) {
  const [source, setSource] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const lease = useRef({ retired: false, objectUrl: '' });
  useEffect(() => { const current: { retired: boolean; objectUrl: string } = { retired: false, objectUrl: '' }; lease.current = current; return () => { current.retired = true; if (current.objectUrl) URL.revokeObjectURL(current.objectUrl); }; }, [sessionId, event.messageId, event.providerAssetId]);
  const play = async () => {
    const current = lease.current; if (busy || current.retired) return; setBusy(true); setError(''); let token = '';
    try {
      const value = await request<NativeVideoPlayback>('video/prepare', { sessionId, messageId: event.messageId, assetId: event.providerAssetId }); token = value.token;
      if (value.bytes > 128 * 1024 * 1024) throw new Error('This video is too large for an inline remote preview.');
      const parts: ArrayBuffer[] = []; let offset = 0;
      while (offset < value.bytes && !current.retired) {
        const chunk = await request<NativeVideoPlaybackChunk>('video/chunk', { token, offset });
        if (chunk.offset !== offset || chunk.totalBytes !== value.bytes || chunk.nextOffset <= offset || chunk.nextOffset > value.bytes) throw new Error('Invalid video transfer');
        const decoded = atob(chunk.data), bytes = new Uint8Array(new ArrayBuffer(decoded.length));
        for (let index = 0; index < bytes.length; index++) bytes[index] = decoded.charCodeAt(index);
        if (bytes.length !== chunk.nextOffset - offset) throw new Error('Incomplete video transfer');
        parts.push(bytes.buffer); offset = chunk.nextOffset;
      }
      if (current.retired) return;
      if (offset !== value.bytes) throw new Error('Incomplete video transfer');
      current.objectUrl = URL.createObjectURL(new Blob(parts, { type: value.mimeType })); setSource(current.objectUrl);
    } catch (error) { if (!current.retired) setError((error as Error).message); }
    finally { if (token) void request('video/release', { token }).catch(() => undefined); if (!current.retired) setBusy(false); }
  };
  return <div className="inline-video">{source ? <video src={source} poster={poster} controls autoPlay /> : <><img src={poster || undefined} alt="Generated video" /><button type="button" disabled={busy} onClick={() => { void play(); }}>{busy ? 'Loading video…' : 'Play video'}</button></>}{error && <p role="alert">{error}</p>}</div>;
}

export function RichPresentation({ event, sessionId, ended = false, openRequestId = null }: { event: ControlApiEvent; sessionId: string; ended?: boolean; openRequestId?: string | null }) {
  const presentation = event.presentation;
  const [image, setImage] = useState(''), [error, setError] = useState(''), [expanded, setExpanded] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const previewControls = useRef<HTMLSpanElement>(null);
  const asset = presentation?.asset ?? event.asset;
  const generating = presentation?.status === 'generating' || event.providerStatus === 'in_progress';
  useEffect(() => {
    if (openRequestId && presentation?.openId === openRequestId) setExpanded(true);
  }, [openRequestId, presentation?.openId]);
  useEffect(() => {
    let alive = true;
    setImage(''); setError('');
    if (asset && !generating) void request<string | null>(`sessions/${sessionId}/images/${encodeURIComponent(asset.id)}`)
      .then(value => { if (alive) { if (value) setImage(value); else setError('Image preview unavailable'); } }).catch(error => alive && setError(error.message));
    return () => { alive = false; };
  }, [sessionId, asset?.id, generating]);
  useEffect(() => {
    if (!presentation?.artifactId || generating || !stage.current) return;
    setError('');
    let alive = true; let handle: ReturnType<typeof createArtifactPreview> | undefined;
    const artifactId = presentation.artifactId, parent = stage.current;
    void request<ArtifactSnapshot | null>(`sessions/${sessionId}/artifacts/${artifactId}?revision=${presentation.revision ?? 1}`).then(snapshot => {
      if (!alive) return;
      if (!snapshot) { setError('Artifact preview unavailable'); return; }
      handle = createArtifactPreview({ parent, controls: previewControls.current ?? undefined, files: snapshot.revision.files, kind: snapshot.artifact.kind, entrypoint: snapshot.artifact.entrypoint,
        createDocument: document => request<{ id: string; url: string }>('previews', { sessionId, artifactId, revision: snapshot.revision.revision, document }),
        releaseDocument: id => { void request('previews/release', { id }).catch(() => undefined); } });
    }).catch(error => alive && setError(error.message));
    return () => { alive = false; handle?.destroy(); };
  }, [sessionId, presentation?.artifactId, presentation?.revision, generating]);
  if (generating) return <div className={`generation-placeholder ${ended ? 'is-interrupted' : ''}`} role="status" aria-busy={!ended} aria-label={ended ? 'Generation interrupted' : 'Generating'} title={ended ? 'Generation interrupted' : 'Generating'} />;
  if (presentation?.status === 'failed') return <p role="status">Generation failed</p>;
  return <section className={`rich-presentation ${expanded ? 'is-expanded' : ''}`}>
    {presentation?.artifactId && <header><strong>{presentation.title}</strong><span className="rich-preview-actions"><span ref={previewControls} /><button type="button" aria-label={expanded ? 'Collapse preview' : 'Expand preview'} onClick={() => setExpanded(value => !value)}><Icon name={expanded ? 'collapse' : 'expand'} /></button></span></header>}
    {event.kind === 'native_video' ? <InlineVideo sessionId={sessionId} event={event} poster={image} /> : image && <img src={image} alt={presentation?.title ?? 'Generated image'} />}
    {event.kind === 'native_image' && !asset && <p role="status">Image preview unavailable</p>}
    {presentation?.artifactId && <div className="rich-artifact" ref={stage} />}
    {error && <p role="alert">{error}</p>}
  </section>;
}
