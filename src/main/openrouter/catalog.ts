/** API model catalog; never inspects a browser or grants native-model authority. */
import { getSecret } from "../secrets.js";
import { readDurable, writeDurableSoon } from "../durable.js";
import { FREE_ROUTER_MODEL, OpenRouterClient } from "./client.js";
import type { ChatModelCatalog, ChatModelOption } from "../../shared/chat-models.js";
const STATE = "chat-models-openrouter-api";
const REFRESH_MS = 15 * 60_000;
let catalog: ChatModelCatalog = { provider: "openrouter", state: "unknown", requestedAt: null, observedAt: null, models: [] };
let request: Promise<ChatModelCatalog> | null = null;
let changed: (value: ChatModelCatalog) => void = () => {};
let keyRevision = 0;
const snapshot = (): ChatModelCatalog => structuredClone(catalog);
const publish = (): ChatModelCatalog => { changed(snapshot()); return snapshot(); };
export function getOpenRouterModels(): ChatModelCatalog { return snapshot(); }
export function onOpenRouterModelsChanged(listener: (value: ChatModelCatalog) => void): void { changed = listener; }
/** Invalidate cached models when the OpenRouter credential changes. An old-key
 * response cannot overwrite a catalog fetched with the new credential. */
export function invalidateOpenRouterModels(): void {
  keyRevision += 1;
  request = null;
  catalog = { provider: "openrouter", state: "unknown", requestedAt: null, observedAt: null, models: [] };
  publish();
}
export async function restoreOpenRouterModels(): Promise<void> {
  const saved = await readDurable<{ observedAt: number; models: ChatModelOption[] }>(STATE);
  if (catalog.state !== "unknown" || !saved || !Number.isSafeInteger(saved.observedAt) ||
      !Array.isArray(saved.models) || saved.models.length > 3000 ||
      !saved.models.every(row => row && typeof row.id === "string" && row.id.length <= 200 &&
        typeof row.label === "string" && Array.isArray(row.efforts) &&
        Number.isSafeInteger(row.contextLength) && row.contextLength! > 0)) return;
  catalog = { ...catalog, state: "ready", models: saved.models, observedAt: saved.observedAt };
}
export function requestOpenRouterModels(): ChatModelCatalog {
  void startOpenRouterModelDiscovery();
  return snapshot();
}
/** A single in-flight catalogue request. Explicit Refresh never starts a browser. */
export function startOpenRouterModelDiscovery(force = false): Promise<ChatModelCatalog> {
  if (request) return request;
  if (!force && catalog.state === "ready" && catalog.observedAt && Date.now() - catalog.observedAt < REFRESH_MS)
    return Promise.resolve(snapshot());
  const old = snapshot();
  const revision = keyRevision;
  catalog = { ...catalog, state: "pending", requestedAt: Date.now(), error: undefined };
  publish();
  const work = (async () => {
    try {
      const key = await getSecret("openRouterApiKey");
      if (!key) throw new Error("Set an OpenRouter API key in OneCode Settings to load models.");
      const response = await new OpenRouterClient().models(key);
      if (revision !== keyRevision) return snapshot();
      const models: ChatModelOption[] = [...response,
        ...(!response.some(model => model.id === FREE_ROUTER_MODEL.id) ? [FREE_ROUTER_MODEL] : [])].map(model => ({
        id: model.id, label: model.name,
        efforts: model.supportedParameters.some(param => param === 'reasoning' || param === 'reasoning_effort')
          ? ['low', 'medium', 'high'] : [],
        effortsObserved: true,
        contextLength: model.contextLength, maxCompletionTokens: model.maxCompletionTokens,
        supportsTools: model.supportsTools, pricing: model.pricing,
        description: [model.supportsTools ? "OneCode tool calling" : "Text-only; no OneCode tools",
          model.id === FREE_ROUTER_MODEL.id ? "Dynamic free route: context limit varies; local estimate " +
            model.contextLength.toLocaleString() + " tokens" :
            "Context: " + model.contextLength.toLocaleString() + " tokens",
          model.maxCompletionTokens ? "Output: " + model.maxCompletionTokens.toLocaleString() + " tokens" : "Endpoint output limit unavailable"
        ].join(" · ").slice(0, 320)
      }));
      const observedAt = Date.now();
      catalog = { provider: "openrouter", state: "ready", requestedAt: old.requestedAt, observedAt, models };
      writeDurableSoon(STATE, { observedAt, models });
    } catch (error) {
      if (revision !== keyRevision) return snapshot();
      const message = error instanceof Error ? error.message : "Model catalog could not be loaded.";
      catalog = { ...catalog, state: catalog.models.length ? "ready" : "unavailable", error: message.slice(0, 240) };
    }
    return publish();
  })();
  request = work;
  void work.finally(() => { if (request === work) request = null; });
  return work;
}
export function resetOpenRouterModelsForTests(): void {
  keyRevision += 1;
  request = null; changed = () => {};
  catalog = { provider: "openrouter", state: "unknown", requestedAt: null, observedAt: null, models: [] };
}
