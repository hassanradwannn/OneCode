/** API adapters own remote transport. Sessions, tools and worker authority stay local. */
import type { ChatProvider } from '../../shared/chat-provider.js';
import { getSecret } from '../secrets.js';
import { FREE_ROUTER_MODEL, OpenRouterClient } from '../openrouter/client.js';
import { ApiError, type ApiModel, type ApiCompleteOptions, type ApiCompletion } from './types.js';
import { cachedOpenRouterApiModel, loadOpenRouterApiModels } from '../openrouter/catalog.js';

export interface ApiProvider {
  id: ChatProvider;
  defaultModel: ApiModel;
  cachedModel?(id: string): ApiModel | undefined;
  models(signal: AbortSignal): Promise<ApiModel[]>;
  complete(input: ApiCompleteOptions): Promise<ApiCompletion>;
  modelInstruction(model: string): string;
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
    complete: async input => client.complete({ ...input, apiKey: await key(),
      signal: AbortSignal.any([...(input.signal ? [input.signal] : []), AbortSignal.timeout(10 * 60_000)]) }),
    modelInstruction: requested => requested === FREE_ROUTER_MODEL.id
      ? "Model identity: this request uses OpenRouter's openrouter/free routing alias. The actual upstream model can vary per request. Never guess which upstream model served this response."
      : 'Model identity: OneCode requested the exact OpenRouter model ID ' + requested +
        '. Report that requested ID without claiming independent proof of underlying provider routing.'
  };
}

export const apiInputOwner = (provider: ChatProvider): string => `onecode:${provider}-api`;
