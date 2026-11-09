/** Capture the pixels of an already mounted, exact user-row image. The URL
 * stays in this browser document and is never sent to the app or transcript. */
var CLF_USER_IMAGE_CAPTURE = (() => {
  const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
  // Four encoded previews and ordinary question text fit the observation budget.
  const MAX_PREVIEW_CHARS = 256_000;

  function encode(source, width, height) {
    if (width <= 0 || height <= 0 || width * height > 30_000_000) return null;
    const fit = Math.min(1, 1600 / Math.max(width, height));
    for (const [scale, quality] of [[1, 0.8], [0.75, 0.65], [0.5, 0.55], [0.3, 0.5]]) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * fit * scale));
      canvas.height = Math.max(1, Math.round(height * fit * scale));
      const context = canvas.getContext('2d');
      if (!context) return null;
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL('image/webp', quality);
      if (/^data:image\/webp;base64,[a-z0-9+/=]+$/i.test(data) && data.length <= MAX_PREVIEW_CHARS) return data;
    }
    return null;
  }

  async function encodeBlob(blob) {
    const bitmap = await createImageBitmap(blob);
    try { return encode(bitmap, bitmap.width, bitmap.height); }
    finally { bitmap.close(); }
  }

  async function capture(image, src, hosts, readUpload) {
    if (image.naturalWidth * image.naturalHeight > 30_000_000) return null;
    try {
      const data = encode(image, image.naturalWidth, image.naturalHeight);
      if (data) return data;
    } catch { /* An already displayed cross-origin image can taint canvas. */ }

    const upload = await readUpload?.(image, src);
    if (upload && upload.length <= 16_777_260 && /^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(upload)) {
      const binary = atob(upload.slice(upload.indexOf(',') + 1));
      return encodeBlob(new Blob([Uint8Array.from(binary, char => char.charCodeAt(0))]));
    }

    const url = new URL(src, location.href);
    const sameOrigin = url.origin === location.origin;
    if (url.username || url.password || !(url.protocol === 'https:' && (sameOrigin || hosts.includes(url.hostname)) ||
        url.protocol === 'blob:' && sameOrigin ||
        url.protocol === 'data:' && /^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(src))) return null;
    // The browser must allow access to these bytes. A signed display URL may
    // work with CORS. Cross-origin cookies and redirects are never needed here.
    const response = await fetch(url.href, {
      credentials: sameOrigin ? 'same-origin' : 'omit', redirect: 'error', signal: AbortSignal.timeout(5000)
    });
    if (!response.ok || !/^image\/(?:png|jpe?g|webp|gif)(?:;|$)/i.test(response.headers.get('content-type') || '') ||
        Number(response.headers.get('content-length')) > MAX_SOURCE_BYTES || !response.body) {
      await response.body?.cancel();
      return null;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > MAX_SOURCE_BYTES) return null;
        chunks.push(next.value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    return encodeBlob(new Blob(chunks));
  }

  function create(eventName, hosts = [], readUpload) {
    const captures = new WeakMap();
    const notify = image => { if (image.isConnected) document.dispatchEvent(new Event(eventName)); };
    return (images) => images.slice(0, 4).flatMap(image => {
      const src = image.currentSrc || image.src;
      let entry = captures.get(image);
      if (!entry || entry.src !== src) {
        entry = { src, dataUrl: null, started: false };
        captures.set(image, entry);
        image.addEventListener('load', () => notify(image), { once: true });
      }
      if (!entry.started && image.complete && image.naturalWidth && image.naturalHeight) {
        entry.started = true;
        const pending = entry;
        void capture(image, src, hosts, readUpload).then(data => {
          if (!data || captures.get(image) !== pending || (image.currentSrc || image.src) !== src) return;
          pending.dataUrl = data;
          notify(image);
        }).catch(() => undefined);
      }
      return entry.dataUrl ? [{ dataUrl: entry.dataUrl, alt: (image.alt || '').slice(0, 120) }] : [];
    });
  }

  return { create };
})();
