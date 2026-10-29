/**
 * Whether the CoS browser holds a Gemini sign-in, for Setup's first step.
 *
 * Gemini uses a bounded observation from the paired companion in the active built-in
 * session. No Google cookie is read or transferred. The legacy host has an explicit policy.
 */
import type { ChatProvider } from '../../shared/chat-provider.js';
let signedIn: boolean | null = null;
let observedProvider: ChatProvider = 'gemini';
const listeners = new Set<() => void>();
let activeSession = false;
let companion: string | null = null;
let leaseEpoch = 0;
let observation: { at: number; until: number } | null = null;
let expiry: ReturnType<typeof setTimeout> | null = null;
const LOGIN_LEASE_MS = 60_000;

/** Legacy ChatGPT token only; never interpreted as a Gemini account. */
export const CHATGPT_SESSION_COOKIE = /^__Secure-next-auth\.session-token(?:\.\d+)?$/;

/** Exact native Google auth host; whether to intercept it is the explicit provider policy. */
export function isGoogleSignIn(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'accounts.google.com';
  } catch { return false; }
}

export function cosBrowserSignedIn(provider: ChatProvider = 'gemini'): boolean | null {
  if (observation && (Date.now() < observation.at || Date.now() >= observation.until)) forgetCosBrowserSignIn();
  return observedProvider === provider ? signedIn : null;
}

export function setCosBrowserSignedIn(next: boolean | null, provider: ChatProvider = 'gemini'): void {
  clearObservation();
  publish(next, provider);
}

function publish(next: boolean | null, provider: ChatProvider = observedProvider): void {
  if (next === signedIn && observedProvider === provider) return;
  signedIn = next;
  observedProvider = provider;
  for (const listener of listeners) listener();
}

function clearObservation(): void {
  if (expiry) clearTimeout(expiry);
  expiry = null;
  observation = null;
}

/** Host lifecycle, separate from bridge pairing. Late reports cannot revive a stopped host. */
export function beginCosBrowserSignInSession(): void {
  activeSession = true;
  forgetCosBrowserSignIn();
}
export function endCosBrowserSignInSession(): void {
  activeSession = false;
  forgetCosBrowserSignIn();
}

/** Pairing/restart/identity changes revoke the observation, not the native Google account. */
export function forgetCosBrowserSignIn(): void {
  leaseEpoch++;
  companion = null;
  clearObservation();
  publish(null);
}

export function noteCosBrowserPresence(browserId: string): void {
  if (!activeSession || !/^[a-z0-9]{16,64}$/.test(browserId)) return;
  if (companion !== browserId) {
    forgetCosBrowserSignIn();
    companion = browserId;
  }
}

/** Process-local observation generation, captured before a bridge request waits for its body. */
export function cosBrowserSignInLease(browserId: string): number | null {
  return activeSession && companion === browserId ? leaseEpoch : null;
}

/** Called only after bridge auth/protocol and same built-in browser presence validation. */
export function noteCosBrowserLogin(browserId: string, next: boolean | null, lease = cosBrowserSignInLease(browserId), provider: ChatProvider = 'gemini'): boolean {
  if (lease === null || lease !== cosBrowserSignInLease(browserId)) return false;
  clearObservation();
  const at = Date.now();
  observation = { at, until: at + LOGIN_LEASE_MS };
  expiry = setTimeout(() => { forgetCosBrowserSignIn(); }, LOGIN_LEASE_MS);
  expiry.unref?.();
  publish(next, provider);
  return true;
}

export function onCosBrowserSignInChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
