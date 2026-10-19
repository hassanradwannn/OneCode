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
