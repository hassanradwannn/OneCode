/** API adapters own remote transport. Sessions, tools and worker authority stay local. */
import type { ChatProvider } from '../../shared/chat-provider.js';
import type { OpenRouterUsage } from '../../shared/usage.js';
import { getSecret, storedSecretsUnreadable } from '../secrets.js';
import { FREE_ROUTER_MODEL, OpenRouterClient, type OpenRouterFreeRequests } from '../openrouter/client.js';
import { ApiError, type ApiModel, type ApiCompleteOptions, type ApiCompletion } from './types.js';
import { cachedOpenRouterApiModel, loadOpenRouterApiModels } from '../openrouter/catalog.js';
export type { OpenRouterFreeRequests };

export interface ApiProvider {
  id: ChatProvider;
  defaultModel: ApiModel;
  cachedModel?(id: string): ApiModel | undefined;
  models(signal: AbortSignal): Promise<ApiModel[]>;
  complete(input: ApiCompleteOptions): Promise<ApiCompletion>;
  modelInstruction(model: string): string;
  freeRequests?(): OpenRouterFreeRequests | null;
}

// Transient free-request budget for this installation; refreshed after each
// dispatched complete() attempt. Counts only, never the key.
let freeRequestsCache: OpenRouterFreeRequests | null = null;
let freeRequestsRevision = 0;
let freeRequestsInFlight: Promise<OpenRouterUsage> | null = null;
export function cachedOpenRouterFreeRequests(): OpenRouterFreeRequests | null {
  return freeRequestsCache ? { ...freeRequestsCache } : null;
}
export function invalidateOpenRouterFreeRequests(): void {
  freeRequestsRevision++;
  freeRequestsCache = null;
  freeRequestsInFlight = null;
}
export function resetOpenRouterFreeRequestsForTests(): void { invalidateOpenRouterFreeRequests(); }

/** Share the same bounded key lookup between Usage and the active chat counter. */
export function refreshOpenRouterFreeRequests(
  client: Pick<OpenRouterClient, 'keyInfo'>, apiKey: string): Promise<OpenRouterUsage> {
  if (freeRequestsInFlight) return freeRequestsInFlight;
  const revision = freeRequestsRevision;
  const work = (async (): Promise<OpenRouterUsage> => {
    try {
      const quota = await client.keyInfo(apiKey, AbortSignal.timeout(3_000));
      if (revision !== freeRequestsRevision) return { status: 'unavailable' };
      if (!quota) return { status: 'not-reported' };
      freeRequestsCache = quota;
      return { status: 'available', quota: { ...quota } };
    } catch { return { status: 'unavailable' }; }
  })();
  freeRequestsInFlight = work;
  void work.then(() => { if (freeRequestsInFlight === work) freeRequestsInFlight = null; });
  return work;
}
/** Fire-and-forget refresh for after a dispatched attempt. The counter must
 * never slow the model step it describes, so a slow /key lookup is abandoned
 * quickly and the last known counts stay visible. */
export function refreshOpenRouterFreeRequestsSoon(
  client: Pick<OpenRouterClient, 'keyInfo'>, apiKey: string): void {
  void refreshOpenRouterFreeRequests(client, apiKey);
}

export async function readOpenRouterUsage(): Promise<OpenRouterUsage> {
  const revision = freeRequestsRevision;
  try {
    const key = await getSecret('openRouterApiKey');
    if (revision !== freeRequestsRevision || storedSecretsUnreadable()) return { status: 'unavailable' };
    return key ? await refreshOpenRouterFreeRequests(new OpenRouterClient(), key) : { status: 'unconfigured' };
  } catch { return { status: 'unavailable' }; }
}

/** Add an API transport here; the harness never borrows browser credentials or receipts. */
export function apiProvider(provider: ChatProvider): ApiProvider | null {
  if (provider !== 'openrouter') return null;
  const client = new OpenRouterClient();
  const key = async () => {
    const value = await getSecret('openRouterApiKey');
    if (!value) throw new ApiError('OPENROUTER_KEY_REQUIRED');
    return value;
  };
  return {
    id: provider, defaultModel: FREE_ROUTER_MODEL,
    cachedModel: cachedOpenRouterApiModel,
    models: signal => loadOpenRouterApiModels(signal),
    freeRequests: () => cachedOpenRouterFreeRequests(),
    complete: async input => {
      const revision = freeRequestsRevision;
      const apiKey = await key();
      let dispatched = false;
      try {
        return await client.complete({ ...input, apiKey,
          signal: AbortSignal.any([...(input.signal ? [input.signal] : []), AbortSignal.timeout(10 * 60_000)]),
          onDispatch: requestBytes => { dispatched = true; input.onDispatch?.(requestBytes); } });
      } finally {
        // Failed model attempts count toward the daily free budget, so
        // refresh after any network attempt, success or failure — without
        // blocking the next model step on it.
        if (dispatched && revision === freeRequestsRevision) refreshOpenRouterFreeRequestsSoon(client, apiKey);
      }
    },
    modelInstruction: requested => requested === FREE_ROUTER_MODEL.id
      ? "Model identity: this request uses OpenRouter's openrouter/free routing alias. The actual upstream model can vary per request. Never guess which upstream model served this response."
      : 'Model identity: OneCode requested the exact OpenRouter model ID ' + requested +
        '. Report that requested ID without claiming independent proof of underlying provider routing.'
  };
}

export const apiInputOwner = (provider: ChatProvider): string => `onecode:${provider}-api`;
