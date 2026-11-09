/** Bounded read-only projection of the editor attached to one rendered native Canvas.
 * Executed in MAIN only by the companion for its elected exact document. Monaco's temporary
 * model URI/version never leave the page and are never treated as provider revision ids.
 */
export function readGeminiCanvasSnapshot(request) {
  try {
    const route = /^\/(?:u\/\d+\/)?app\/([0-9a-f]{16})\/?$/i.exec(location.pathname);
    if (location.origin !== 'https://gemini.google.com' || route?.[1]?.toLowerCase() !== request.conversationId ||
        !/^[0-9a-f]{16}$/i.test(request.responseId)) return null;
    const roots = [...document.querySelectorAll(`[id="model-response-message-contentr_${request.responseId}"]`)];
    if (roots.length !== 1) return null;
    const response = roots[0].closest('model-response');
    if (!response || response.closest('.conversation-container')?.id !== request.responseId || !response.querySelector('.response-footer.complete')) return null;
    const cards = [...roots[0].querySelectorAll('immersive-entry-chip inline-preview')];
    if (cards.length !== 1 || !cards[0].querySelector('button[aria-label="Changes saved"]') ||
        cards[0].querySelectorAll('mat-button-toggle[value="code"] button[aria-checked="true"]').length !== 1) return null;
    const editors = window.monaco?.editor?.getEditors?.().filter(editor => {
      const node = editor.getDomNode(); return node?.isConnected && node.closest('inline-preview') === cards[0];
    }) || [];
    if (editors.length !== 1) return null;
    const editor = editors[0], model = editor.getModel();
    if (!model || model.isDisposed()) return null;
    const base={messageId:`gemini:${request.conversationId}:assistant:${request.responseId}`,nativeSurface:'canvas',title:cards[0].querySelector('.title')?.textContent.trim().slice(0,200)||'Canvas',kind:'web',entrypoint:'index.html'};
    if(model.getLanguageId()!=='html')return{...base,error:'unsupported'};
    if(model.getValueLength()>240_000)return{...base,error:'oversized'};
    const version = model.getVersionId(), text = model.getValue();
    if (!text || text.length > 240_000 || model !== editor.getModel() || version !== model.getVersionId() || !editor.getDomNode()?.isConnected) return null;
    return {...base,
      files:[{path:'index.html',text,mimeType:'text/html',language:'html'}]};
  } catch { return null; }
}

/** Recheck the rendered upload in the exact Gemini document before its browser-only read. */
export function geminiUploadVisible(conversationId, sourceUrl) {
  const route = /^\/(?:u\/\d+\/)?app\/([0-9a-f]{16})\/?$/i.exec(location.pathname);
  if (location.origin !== 'https://gemini.google.com' || route?.[1]?.toLowerCase() !== conversationId) return false;
  return [...document.querySelectorAll('user-query user-query-file-preview button.preview-image-button img[data-test-id="uploaded-img"]')]
    .some(image => image.complete && image.naturalWidth > 0 && image.getClientRects().length &&
      !image.closest('[hidden], [aria-hidden="true"], [inert]') && (image.currentSrc || image.src) === sourceUrl);
}

function geminiUploadUrl(value, delivered = false) {
  if (typeof value !== 'string' || value.length > 8192) return null;
  try {
    const url = new URL(value);
    if (url.origin !== 'https://lh3.googleusercontent.com' || url.username || url.password || url.hash ||
        !(delivered ? /^\/(?:rd-)?gg\/[a-z0-9_-]+(?:=s\d{1,4})?$/i : /^\/gg\/[a-z0-9_-]+$/i).test(url.pathname) ||
        [...url.searchParams.keys()].some(key => key !== 'authuser') ||
        (url.search && !/^\?authuser=\d{1,3}$/.test(url.search))) return null;
    return url.href;
  } catch { return null; }
}

export async function readGeminiUpload(source, { current, fetch: request }) {
  const url = geminiUploadUrl(source);
  const maxBytes = 12 * 1024 * 1024;
  let reader;
  try {
    if (!url || !await current()) return null;
    // The rendered upload's signed path redirects through lh3.google.com when
    // authenticated. An anonymous read of the final image receives HTTP 403.
    const response = await request(url, { credentials: 'include', signal: AbortSignal.timeout(5000) });
    const mime = (response.headers.get('content-type') || '').split(';', 1)[0];
    if (!response.ok || !geminiUploadUrl(response.url, true) || !/^image\/(?:png|jpeg|webp|gif)$/i.test(mime) ||
        Number(response.headers.get('content-length')) > maxBytes || !response.body) {
      await response.body?.cancel();
      return null;
    }
    reader = response.body.getReader();
    let size = 0, binary = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) return null;
      for (let at = 0; at < value.length; at += 0x8000) binary += String.fromCharCode(...value.subarray(at, at + 0x8000));
    }
    return size && await current() ? `data:${mime};base64,${btoa(binary)}` : null;
  } catch { return null; }
  finally { try { await reader?.cancel(); } catch { /* Already closed. */ } }
}
