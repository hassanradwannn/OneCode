import { safeRecordedReplyImage } from '../shared/external-link.js';
import { loadNativePackage } from './native-package.js';
import { readEvents } from './session/store.js';

const sharp = loadNativePackage('sharp');
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_PIXELS = 16_000_000;
const imageTypes = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' } as const;
const active = new Map<string, Promise<string | null>>();
const cache = new Map<string, string>();

async function fetchImage(url: string): Promise<string | null> {
  const response = await fetch(url, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(12_000) });
  const type = response.headers.get('content-type')?.split(';', 1)[0];
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    if (!response.ok || !Object.values(imageTypes).some(mime => mime === type) ||
        Number(response.headers.get('content-length')) > MAX_BYTES) return null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > MAX_BYTES) return null;
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const image = Buffer.concat(chunks, bytes);
  const metadata = await sharp(image, { limitInputPixels: MAX_PIXELS }).metadata();
  if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_PIXELS ||
      !metadata.format || imageTypes[metadata.format as keyof typeof imageTypes] !== type) return null;
  return `data:${type};base64,${image.toString('base64')}`;
}

/** The app may load only a public image reference in the exact retained answer. */
export async function recordedReplyImage(sessionId: string, messageId: string, url: string): Promise<string | null> {
  if (!safeRecordedReplyImage(url)) return null;
  const events = await readEvents(sessionId, { kinds: ['assistant_message'] });
  if (!events.some(event => event.kind === 'assistant_message' && event.source === 'extension' &&
      event.messageId === messageId && event.final && !event.renderedHtml?.truncated &&
      event.renderedHtml?.text.includes(`src="${url}"`))) return null;
  const retained = cache.get(url);
  if (retained) return retained;
  const pending = active.get(url);
  if (pending) return pending;
  if (active.size >= 8) return null;
  const work = fetchImage(url).then(result => {
    if (result) {
      if (cache.size >= 16) cache.delete(cache.keys().next().value!);
      cache.set(url, result);
    }
    return result;
  }).catch(() => null).finally(() => active.delete(url));
  active.set(url, work);
  return work;
}
