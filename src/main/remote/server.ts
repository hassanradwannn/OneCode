import { chatScheduler } from '../chat-schedules.js';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { z } from 'zod';
import { RemoteAuth } from './auth.js';
import { RemoteOperations } from './operations.js';
import { remoteAction, remoteActionSchema } from './actions.js';
import { PrivateServe, RemoteRouteConflict } from '../tunnel/tailscale-serve.js';
import { readDurable, writeDurableNow } from '../durable.js';
import { CHAT_PROVIDERS, chatProviderLabel } from '../../shared/chat-provider.js';
import { APP_VERSION } from '../version.js';
import { getChatModels } from '../chat-models.js';
import { remotePreferences } from './preferences.js';
import { RequestError, projectInput } from '../control-reads.js';
import { listInputs } from '../session/input.js';
import { remoteRead } from './views.js';
import { getSecret, setSecret } from '../secrets.js';
import { readArtifact } from '../artifacts/service.js';
import { getSession, readAsset, readEvents } from '../session/store.js';
import { PreviewDocuments, ARTIFACT_DOCUMENT_CSP } from '../artifacts/preview-documents.js';
import { stageInputAttachment } from '../session/input-attachments.js';
import { listManagedSkills } from '../skills.js';
import { prepareNativeVideoPlayback, preparePresentedVideoPlayback, readNativeVideoPlaybackChunk, releaseNativeVideoPlayback } from '../native-media.js';
import type { RemoteBootstrap, RemoteStatus } from '../../shared/remote.js';
import type { TailscaleSetupAction } from '../../shared/tailscale-setup.js';
import { TailscaleNotReady, TailscaleSetupRequired } from '../tunnel/tailscale-prerequisites.js';
import { requestTailscaleSetup } from '../tunnel/tailscale-setup.js';
import { listProjects } from '../projects.js';

const auth = new RemoteAuth(), operations = new RemoteOperations();
const previews = new PreviewDocuments();
const playbacks = new Map<string, { owner: string; sessionId: string; expires: number }>();
async function retirePlaybacks(owner?: string): Promise<void> {
  for (const [token, row] of playbacks) if (!owner || row.owner === owner || row.expires < Date.now()) {
    playbacks.delete(token); await releaseNativeVideoPlayback(row.sessionId, token).catch(() => undefined);
  }
}
let listener: http.Server | null = null, serve: PrivateServe | null = null, url: string | null = null, ready = false, enabled = false, error: string | null = null;
let watcher: NodeJS.Timeout | null = null, verifying: Promise<void> | null = null, terminal = false;
let accessKey: string | null = null;
let canRefreshLink = false;
let lifecycle = Promise.resolve();
let setup: TailscaleSetupAction | undefined, setupRetry: NodeJS.Timeout | undefined;
let routeRetry = false;
const assetRoot = path.resolve(__dirname, '../remote');
const gzipAsync = promisify(gzip);
const compressedAssets = new Map<string, Promise<Buffer>>();
const COMPRESSIBLE_REMOTE_ASSET = /\.(?:css|js)$/i;
function acceptsGzip(value: string | string[] | undefined): boolean {
  return typeof value === 'string' && value.split(',').some(token => /^\s*gzip(?:\s*;\s*q=(?!0(?:\.0*)?\b)[0-9.]+)?\s*$/i.test(token));
}
export function remoteStaticCacheControl(pathname: string): string {
  return pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store';
}
async function remoteStaticBody(file: string, bytes: Buffer, acceptEncoding: string | string[] | undefined): Promise<{ body: Buffer; gzip: boolean }> {
  if (!COMPRESSIBLE_REMOTE_ASSET.test(file) || bytes.length < 1024 || !acceptsGzip(acceptEncoding)) return { body: bytes, gzip: false };
  let encoded = compressedAssets.get(file);
  if (!encoded) {
    encoded = gzipAsync(bytes, { level: 6 });
    compressedAssets.set(file, encoded);
    encoded.catch(() => compressedAssets.delete(file));
  }
  return { body: await encoded, gzip: true };
}
function json(res: http.ServerResponse, status: number, body: unknown): void { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); }
async function checkRoute(): Promise<void> {
  if (!serve || !listener || !enabled || (!ready && !routeRetry)) throw new Error('Remote access is unavailable.');
  const owner = serve;
  if (!verifying) verifying = owner.verify().then(() => {
    if (serve !== owner || !listener || !enabled || terminal) throw new Error('Remote access is unavailable.');
    // Recovery only verifies the retained route. It never republishes a route or a message.
    routeRetry = false; ready = true; error = null; canRefreshLink = false;
  }).catch(cause => {
    if (serve === owner && listener && enabled && !terminal) {
      ready = false; error = (cause as Error).message;
      routeRetry = cause instanceof TailscaleNotReady;
      // Route errors suspend admission. They do not revoke the user's saved browser grants.
      canRefreshLink = cause instanceof RemoteRouteConflict;
    }
    throw cause;
  }).finally(() => { verifying = null; });
  return verifying;
}
async function body(req: http.IncomingMessage, limit = 128_000): Promise<unknown> {
  if (req.headers['content-type'] !== 'application/json') throw new RequestError(415, 'json_required');
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const raw of req) { const chunk = Buffer.from(raw); bytes += chunk.length; if (bytes > limit) throw new RequestError(413, 'body_too_large'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new RequestError(400, 'invalid_json'); }
}
async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-src 'self' blob:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  if (!url || req.headers.host !== new URL(url).host || !enabled || !ready) throw new RequestError(503, 'remote_unavailable');
  const route = new URL(req.url ?? '/', url);
  if (route.origin !== url || route.search.length > 2048) throw new RequestError(400, 'invalid_route');
  if (req.method === 'GET' && /^\/preview\/[0-9a-f-]{36}$/.test(route.pathname)) {
    await checkRoute(); const row = previews.get(route.pathname.split('/').at(-1)!);
    if (!row || !auth.list().some(device => device.id === row.owner)) throw new RequestError(404, 'preview_expired');
    res.setHeader('Content-Security-Policy', `${ARTIFACT_DOCUMENT_CSP}; frame-ancestors ${url}`);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(row.document); return;
  }
  if (route.pathname.startsWith('/api/')) {
    if (req.headers['x-onecode-remote'] !== '1' || (req.headers.origin !== undefined && req.headers.origin !== url) ||
        (req.method === 'POST' && req.headers.origin !== url)) throw new RequestError(403, 'origin_refused');
    await checkRoute();
    if (route.pathname === '/api/connect' && req.method === 'POST') {
      const connection = z.object({ key: z.string().min(1).max(128), name: z.string().trim().min(1).max(80) }).strict().parse(await body(req));
      await checkRoute(); json(res, 200, await auth.connect(connection.key, connection.name)); return;
    }
    const token = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    const device = auth.authenticate(token); if (!device) throw new RequestError(401, 'connection_required');
    if (req.method === 'POST' && route.pathname === '/api/video/prepare') {
      const sessionId = z.string().regex(/^[0-9a-z-]{8,64}$/);
      const request = z.union([
        z.object({ sessionId, messageId: z.string().min(1).max(512), assetId: z.string().min(1).max(512) }).strict(),
        z.object({ sessionId, presentationId: z.string().uuid() }).strict()
      ]).parse(await body(req));
      for (const [key, row] of playbacks) if (row.expires < Date.now()) { playbacks.delete(key); await releaseNativeVideoPlayback(row.sessionId, key).catch(() => undefined); }
      if (playbacks.size >= 16) throw new RequestError(429, 'too_many_video_transfers');
      const playback = 'presentationId' in request ? await preparePresentedVideoPlayback(request.sessionId, request.presentationId)
        : await prepareNativeVideoPlayback(request.sessionId, request.messageId, request.assetId);
      try { await checkRoute(); if (!auth.authenticate(token)) throw new RequestError(401, 'connection_required'); }
      catch (error) { await releaseNativeVideoPlayback(request.sessionId, playback.token); throw error; }
      playbacks.set(playback.token, { owner: device.id, sessionId: request.sessionId, expires: Date.now() + 5 * 60_000 }); json(res, 200, playback); return;
    }
    if (req.method === 'POST' && ['/api/video/chunk', '/api/video/release'].includes(route.pathname)) {
      const request = z.object({ token: z.string().uuid(), offset: z.number().int().nonnegative().optional() }).strict().parse(await body(req));
      const row = playbacks.get(request.token);
      if (!row || row.owner !== device.id || row.expires < Date.now()) throw new RequestError(404, 'video_expired');
      if (route.pathname.endsWith('/release')) { playbacks.delete(request.token); json(res, 200, await releaseNativeVideoPlayback(row.sessionId, request.token)); return; }
      if (request.offset === undefined) throw new RequestError(400, 'offset_required');
      const chunk = await readNativeVideoPlaybackChunk(row.sessionId, request.token, request.offset); row.expires = Date.now() + 5 * 60_000; json(res, 200, chunk); return;
    }
    if (req.method === 'GET' && route.pathname === '/api/skills') {
      json(res, 200, (await listManagedSkills()).map(({ id, name, description }) => ({ id, name, description }))); return;
    }
    if (req.method === 'POST' && route.pathname === '/api/attachments') {
      const file = z.object({ name: z.string().min(1).max(255).regex(/^[^\\/\x00-\x1f]+$/), data: z.string().max(22_369_624).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) }).strict().parse(await body(req, 23 * 1024 * 1024));
      const bytes = Buffer.from(file.data, 'base64'); if (!bytes.length || bytes.length > 16 * 1024 * 1024) throw new RequestError(413, 'attachment_too_large');
      await checkRoute(); if (!auth.authenticate(token)) throw new RequestError(401, 'connection_required');
      const retained = new Set((await listInputs()).filter(row => !['sent', 'failed', 'cancelled'].includes(row.state)).flatMap(row => row.attachments?.map(file => file.id) ?? []));
      json(res, 200, await stageInputAttachment({ name: file.name, bytes }, retained)); return;
    }
    if (req.method === 'POST' && route.pathname === '/api/previews') {
      const request = z.object({ sessionId: z.string().regex(/^[0-9a-z-]{8,64}$/), artifactId: z.string().uuid(), revision: z.number().int().min(1), document: z.string().min(1).max(4 * 1024 * 1024) }).strict().parse(await body(req, 8 * 1024 * 1024));
      if (!await readArtifact(request.sessionId, request.artifactId, request.revision)) throw new RequestError(404, 'not_found');
      await checkRoute(); if (!auth.authenticate(token)) throw new RequestError(401, 'connection_required');
      const id = previews.create(request.document, device.id); json(res, 200, { id, url: `/preview/${id}` }); return;
    }
    if (req.method === 'POST' && route.pathname === '/api/previews/release') {
      const request = z.object({ id: z.string().uuid() }).strict().parse(await body(req)); previews.release(request.id, device.id); json(res, 200, true); return;
    }
    if (req.method === 'GET' && /^\/api\/sessions\/[0-9a-z-]{8,64}\/artifacts\/[0-9a-f-]{36}$/.test(route.pathname)) {
      const segments = route.pathname.split('/'), sessionId = segments[3]!, artifactId = z.string().uuid().parse(segments[5]);
      const revision = route.searchParams.has('revision') ? z.coerce.number().int().min(1).parse(route.searchParams.get('revision')) : undefined;
      const snapshot = await readArtifact(sessionId, artifactId, revision);
      json(res, 200, snapshot); return;
    }
    if (req.method === 'GET' && /^\/api\/sessions\/[0-9a-z-]{8,64}\/images\/[a-f0-9]{32}\.(?:png|jpg|bin)$/.test(route.pathname)) {
      const segments = route.pathname.split('/'), sessionId = segments[3]!, id = segments[5]!;
      if (!await getSession(sessionId)) throw new RequestError(404, 'not_found');
      // A file's existence is insufficient: only a recorded image reference may be served.
      const refs = (await readEvents(sessionId)).flatMap(event => event.kind === 'native_image' || event.kind === 'native_video' ? event.asset ? [event.asset] : []
        : event.kind === 'progress' ? event.presentation?.asset ? [event.presentation.asset] : []
        : event.kind === 'tool_call' ? event.call.assets ?? [] : []);
      const ref = refs.find(asset => asset.id === id && ['image/png', 'image/jpeg', 'image/webp'].includes(asset.mimeType));
      const bytes = ref ? await readAsset(sessionId, id, 8 * 1024 * 1024) : null;
      json(res, 200, bytes && ref ? `data:${ref.mimeType};base64,${bytes.toString('base64')}` : null); return;
    }
    if (req.method === 'GET' && /^\/api\/operations\/[0-9a-f-]{36}$/.test(route.pathname)) {
      json(res, 200, await operations.get(route.pathname.split('/').at(-1)!, device.id)); return;
    }
    if (req.method === 'GET' && /^\/api\/inputs\/[0-9a-f-]{36}$/.test(route.pathname)) {
      const input = (await listInputs()).find(row => row.id === route.pathname.split('/').at(-1));
      json(res, 200, input ? projectInput(input) : null); return;
    }
    if (req.method === 'GET' && route.pathname === '/api/schedules') { json(res, 200, await chatScheduler.list()); return; }
    if (req.method === 'GET' && route.pathname === '/api/bootstrap') {
      const view: RemoteBootstrap = { host: os.hostname(), version: APP_VERSION,
        projects: (await listProjects()).filter(project => !project.ungrouped).map(({ id, name, color }) => ({ id, name, ...(color ? { color } : {}) })),
        providers: CHAT_PROVIDERS.map(id => ({ id, label: chatProviderLabel(id), models: getChatModels(id) })), ...remotePreferences() };
      json(res, 200, view); return;
    }
    if (req.method === 'POST' && route.pathname === '/api/actions') {
      const request = remoteActionSchema.parse(await body(req, 2 * 1024 * 1024));
      await checkRoute(); if (!auth.authenticate(token)) throw new RequestError(401, 'connection_required');
      json(res, 200, await operations.run(request.id, device.id, request, () => remoteAction(request))); return;
    }
    if (req.method === 'POST' && route.pathname === '/api/disconnect') { await body(req); await auth.revoke(device.id); await retirePlaybacks(device.id); json(res, 200, { disconnected: true }); return; }
    if (req.method === 'GET' && (/^\/api\/sessions(?:\/[0-9a-z-]{8,64}(?:\/events)?)?$/.test(route.pathname) || route.pathname === '/api/inputs')) {
      const view = await remoteRead(route.pathname.replace('/api/', '/v1/'), route.searchParams); json(res, 200, view); return;
    }
    throw new RequestError(404, 'not_found');
  }
  if (req.method !== 'GET' || route.search || !/^\/(?:index\.html|assets\/[a-zA-Z0-9_.-]+)?$/.test(route.pathname)) throw new RequestError(404, 'not_found');
  const file = path.join(assetRoot, route.pathname === '/' ? 'index.html' : route.pathname.slice(1));
  const bytes = await fs.readFile(file).catch(() => { throw new RequestError(404, 'not_found'); }); const ext = path.extname(file);
  const encoded = await remoteStaticBody(file, bytes, req.headers['accept-encoding']);
  res.setHeader('Cache-Control', remoteStaticCacheControl(route.pathname));
  if (encoded.gzip) { res.setHeader('Content-Encoding', 'gzip'); res.setHeader('Vary', 'Accept-Encoding'); }
  res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2' } as Record<string, string>)[ext] ?? 'application/octet-stream' }); res.end(encoded.body);
}
async function start(refreshLink = false): Promise<void> {
  if (terminal || listener) return;
  // A missing production bundle must not publish an empty or development service.
  await fs.access(path.join(assetRoot, 'index.html'));
  accessKey = await getSecret('remoteAccessKey');
  if (!accessKey) { accessKey = randomBytes(32).toString('base64url'); await setSecret('remoteAccessKey', accessKey); }
  await auth.activate(accessKey);
  const server = http.createServer((req, res) => {
    void handle(req, res).catch(cause => {
      if (res.headersSent) { res.destroy(); return; }
      json(res, cause instanceof RequestError ? cause.status : cause instanceof z.ZodError ? 400 : 409,
        { error: cause instanceof RequestError ? cause.code : cause instanceof z.ZodError ? 'Invalid remote request' : (cause as Error).message });
    });
  });
  server.headersTimeout = 15_000; server.requestTimeout = 30_000; server.maxHeadersCount = 40;
  server.on('checkContinue', (_req, res) => json(res, 417, { error: 'expect_not_supported' }));
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  listener = server; serve = new PrivateServe();
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Remote listener did not start.');
    const proxy = `http://127.0.0.1:${address.port}`;
    url = await (refreshLink ? serve.refresh(proxy) : serve.start(proxy)); ready = true; error = null; canRefreshLink = false;
    watcher = setInterval(() => { void checkRoute().catch(() => undefined); }, 5_000); watcher.unref();
  } catch (cause) { await closeListener(); throw cause; }
}
async function closeListener(): Promise<void> {
  await retirePlaybacks();
  ready = false; routeRetry = false; previews.clear(); accessKey = null; if (watcher) clearInterval(watcher); watcher = null;
  const server = listener; listener = null;
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  url = null;
}
/** The remote-only link is deliberately exposed only through trusted desktop IPC. */
export function remoteStatus(): RemoteStatus { return { enabled, ready, url: ready && url && accessKey ? `${url}/#${accessKey}` : null, error, devices: auth.list(), ...(enabled && !ready && canRefreshLink ? { canRefreshLink: true } : {}), ...(setup ? { setup } : {}) }; }
export async function revokeRemoteDevice(id: string): Promise<void> { const owner = z.string().uuid().parse(id); await auth.revoke(owner); await retirePlaybacks(owner); }
export function setRemoteEnabled(value: boolean): Promise<RemoteStatus> {
  const operation = lifecycle.then(async () => {
    clearTimeout(setupRetry); setupRetry = undefined; setup = undefined;
    enabled = value && !terminal; await writeDurableNow('remote-settings', { enabled });
    if (enabled) {
      try { if (listener && !ready) await closeListener(); await start(); }
      catch (cause) {
        error = (cause as Error).message;
        canRefreshLink = cause instanceof RemoteRouteConflict;
        if (cause instanceof TailscaleSetupRequired || cause instanceof TailscaleNotReady) {
          if (cause instanceof TailscaleSetupRequired) { setup = cause.setup; void requestTailscaleSetup(cause.setup); }
          setupRetry = setTimeout(() => { if (enabled && !terminal) void setRemoteEnabled(true).catch(() => undefined); }, 5_000); setupRetry.unref();
        }
      }
    }
    else { await closeListener(); await auth.clear(); canRefreshLink = false; try { await serve?.stop(); error = null; } catch (cause) { error = (cause as Error).message; } serve = null; }
    return remoteStatus();
  });
  lifecycle = operation.then(() => undefined, () => undefined); return operation;
}
/** Only trusted desktop UI can intentionally replace a conflicted bookmark address. */
export function refreshRemoteLink(): Promise<RemoteStatus> {
  const operation = lifecycle.then(async () => {
    if (terminal || !enabled || ready || !canRefreshLink) return remoteStatus();
    clearTimeout(setupRetry); setupRetry = undefined; setup = undefined;
    await closeListener(); await auth.clear();
    try { await start(true); }
    catch (cause) { error = (cause as Error).message; canRefreshLink = cause instanceof RemoteRouteConflict; }
    return remoteStatus();
  });
  lifecycle = operation.then(() => undefined, () => undefined); return operation;
}
export async function restoreRemote(): Promise<void> { if ((await readDurable<{ enabled: boolean }>('remote-settings'))?.enabled === true) await setRemoteEnabled(true); }
export async function shutdownRemote(): Promise<void> { terminal = true; clearTimeout(setupRetry); setup = undefined; await lifecycle; await closeListener(); try { await serve?.stop(); } catch { /* no unowned route removal */ } serve = null; }
