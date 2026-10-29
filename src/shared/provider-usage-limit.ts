import type { ProviderUsageLimit } from './session.js';

/** Display only the provider's observed reset evidence; this supplies no retry authority. */
export function usageLimitResetText(limit: ProviderUsageLimit, locale?: string): string | null {
  if (typeof limit.resetAt === 'number' && Number.isFinite(limit.resetAt) && limit.resetAt > 0 && Number.isFinite(new Date(limit.resetAt).getTime()))
    return new Date(limit.resetAt).toLocaleString(locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return limit.resetText?.trim() || null;
}

export function usageLimitTitle(limit: ProviderUsageLimit): string {
  return limit.kind === 'weekly' ? 'Weekly usage limit reached' : limit.kind === 'session' ? 'Session usage limit reached' : 'Usage limit reached';
}
