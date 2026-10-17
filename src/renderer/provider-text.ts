import { providerCopy } from '../shared/provider-copy.js';
import { t } from './i18n.js';

/** Neutralize app-authored wording before inserting names, paths or account data. */
export function providerText(source: string, args: readonly unknown[] = []): string {
  return providerCopy(t(source), 'gemini', args, { provider: t('provider'), Provider: t('Provider'), providers: t('providers') });
}
