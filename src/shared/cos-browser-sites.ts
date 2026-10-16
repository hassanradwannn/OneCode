/** Production is Gemini only. The legacy policy is explicit for retained ChatGPT host tests. */
export type CosBrowserProvider = 'gemini' | 'chatgpt';
const GEMINI_HOSTS = new Set(['gemini.google.com', 'accounts.google.com']);
const CHATGPT_HOSTS = new Set([
  'chatgpt.com', 'platform.openai.com', 'auth.openai.com', 'auth0.openai.com', 'accounts.google.com',
  'login.microsoftonline.com', 'login.live.com', 'appleid.apple.com', 'idmsa.apple.com'
]);

function webUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.port ? parsed : null;
  } catch { return null; }
}

export function cosBrowserPolicy(provider: CosBrowserProvider = 'gemini') {
  const legacy = provider === 'chatgpt';
  const homeUrl = legacy ? 'https://chatgpt.com/' : 'https://gemini.google.com/app';
  return {
    provider, homeUrl,
    loginUrl: legacy ? 'https://chatgpt.com/auth/login' : homeUrl,
    sessionTransfer: legacy,
    opens(url: string): boolean {
      const parsed = webUrl(url);
      return !!parsed && (legacy ? CHATGPT_HOSTS : GEMINI_HOSTS).has(parsed.hostname);
    },
    conversation(url: string): string | null {
      const parsed = webUrl(url);
      if (!parsed) return null;
      if (legacy) return ['chatgpt.com', 'chat.openai.com'].includes(parsed.hostname)
        ? /^\/(?:g\/[^/]+\/)?c\/([0-9a-z-]+)(?:\/)?$/i.exec(parsed.pathname)?.[1] ?? null : null;
      return parsed.hostname === 'gemini.google.com'
        ? /^\/(?:u\/\d+\/)?app\/([a-f0-9]{16})$/.exec(parsed.pathname)?.[1] ?? null : null;
    },
    loginFor(url: string): string {
      const parsed = webUrl(url);
      if (!legacy && parsed?.hostname === 'gemini.google.com') {
        const account = /^\/u\/(\d+)\/(?:app(?:\/|$)|customize\/)/.exec(parsed.pathname)?.[1];
        if (account !== undefined) return `https://gemini.google.com/u/${account}/app`;
      }
      return legacy ? 'https://chatgpt.com/auth/login' : homeUrl;
    }
  };
}

export function opensInCosBrowser(url: string): boolean {
  return cosBrowserPolicy().opens(url);
}
