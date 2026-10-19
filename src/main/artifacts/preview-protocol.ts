import { protocol } from 'electron';
import { ARTIFACT_DOCUMENT_CSP, desktopPreviews } from './preview-documents.js';
export function registerArtifactPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: 'onecode-artifact', privileges: { standard: true, secure: true } }]);
}
export function installArtifactPreviewProtocol(): void {
  protocol.handle('onecode-artifact', request => {
    const url = new URL(request.url);
    const row = request.method === 'GET' && url.hostname === 'preview' && !url.search && /^\/[0-9a-f-]{36}$/.test(url.pathname)
      ? desktopPreviews.get(url.pathname.slice(1)) : null;
    return new Response(row?.document ?? 'Preview expired', { status: row ? 200 : 404,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': ARTIFACT_DOCUMENT_CSP } });
  });
}
