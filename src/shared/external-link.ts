/** URLs authored in chat may open in the OS browser/mail app, never as executable schemes. */
export function safeExternalLink(value: string): boolean {
  if (!value || value.length > 8192 || /[\s\\\u0000-\u001f\u007f]/.test(value) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (/^https?:\/\//i.test(value)) return Boolean(url.hostname);
    return url.protocol === 'mailto:' && value.toLowerCase().startsWith('mailto:') && Boolean(url.pathname);
  } catch {
    return false;
  }
}

export interface AuthoredUrlSegment { text: string; href: string | null }

function countChar(value: string, char: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index++) if (value[index] === char) count++;
  return count;
}

// Trailing sentence punctuation is not part of the URL. A closing bracket
// is stripped only when it is unbalanced, so "(https://x/(y))" keeps its
// balanced pair while "(https://x)" leaves the outer ")" as text.
function trimTrailingUrlPunctuation(url: string): string {
  let end = url.length;
  while (end > 0) {
    const char = url[end - 1]!;
    if ('.,;:!?'.includes(char)) { end--; continue; }
    if ((char === ')' && countChar(url.slice(0, end), '(') < countChar(url.slice(0, end), ')')) ||
        (char === ']' && countChar(url.slice(0, end), '[') < countChar(url.slice(0, end), ']')) ||
        (char === '}' && countChar(url.slice(0, end), '{') < countChar(url.slice(0, end), '}'))) { end--; continue; }
    break;
  }
  return url.slice(0, end);
}

/** Split authored text into plain and safe-link segments without parsing HTML. */
export function authoredUrlSegments(value: string): AuthoredUrlSegment[] {
  if (!value) return [];
  const segments: AuthoredUrlSegment[] = [];
  let plainStart = 0;
  const pattern = /(?:https?:\/\/[^\s<>"']+|mailto:[^\s<>"']+)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    const url = trimTrailingUrlPunctuation(match[0]);
    if (!url || !safeExternalLink(url)) continue;
    const start = match.index;
    if (start > plainStart) segments.push({ text: value.slice(plainStart, start), href: null });
    segments.push({ text: url, href: url });
    plainStart = start + url.length;
  }
  if (plainStart < value.length) segments.push({ text: value.slice(plainStart), href: null });
  if (!segments.length && value) segments.push({ text: value, href: null });
  return segments;
}

/** Provider-local downloadable files are opened through that exact native chat. */
export function safeProviderFileLink(value: string): boolean {
  if (!/^sandbox:\/mnt\/data\/[^?#]{1,2048}$/.test(value) || /[\s\\]/.test(value)) return false;
  try { const decoded = decodeURIComponent(value.slice('sandbox:/mnt/data/'.length));
    return !/[\\\u0000-\u001f\u007f]/.test(decoded) && decoded.split('/').every(part => Boolean(part) && part !== '.' && part !== '..');
  } catch { return false; }
}

/** Public image previews declared by the provider's captured answer. */
export function safeRecordedReplyImage(value: string): boolean {
  return /^https:\/\/images\.openai\.com\/static-rsc-\d{1,3}\/[A-Za-z0-9_-]{16,2000}(?:\?purpose=inline)?$/.test(value);
}
