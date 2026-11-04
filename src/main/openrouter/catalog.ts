/** API model catalog; never inspects a browser or grants native-model authority. */
import { getSecret } from "../secrets.js";
import { readDurable, writeDurableSoon } from "../durable.js";
import { OpenRouterClient } from "./client.js";
import type { ChatModelCatalog, ChatModelOption } from "../../shared/chat-models.js";
const STATE = "chat-models-openrouter-api";
const REFRESH_MS = 15 * 60_000;
let catalog: ChatModelCatalog = { provider: "openrouter", state: "unknown", requestedAt: null, observedAt: null, models: [] };
let request: Promise<ChatModelCatalog> | null = null;
let changed: (value: ChatModelCatalog) => void = () => {};
const snapshot = (): ChatModelCatalog => structuredClone(catalog);
const publish = (): ChatModelCatalog => { changed(snapshot()); return snapshot(); };
export function getOpenRouterModels(): ChatModelCatalog { return snapshot(); }
export function onOpenRouterModelsChanged(listener: (value: ChatModelCatalog) => void): void { changed = listener; }
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
  catalog = { ...catalog, state: "pending", requestedAt: Date.now(), error: undefined };
  publish();
  const work = (async () => {
    try {
      const key = await getSecret("openRouterApiKey");
      if (!key) throw new Error("Set an OpenRouter API key in OneCode Settings to load models.");
      const response = await new OpenRouterClient().models(key);
      const models: ChatModelOption[] = response.map(model => ({
        id: model.id, label: model.name, efforts: [], effortsObserved: false,
        contextLength: model.contextLength, maxCompletionTokens: model.maxCompletionTokens,
        supportsTools: model.supportsTools, pricing: model.pricing,
        description: [model.supportsTools ? "OneCode tool calling" : "Text-only; no OneCode tools",
          "Context: " + model.contextLength.toLocaleString() + " tokens",
          model.maxCompletionTokens ? "Output: " + model.maxCompletionTokens.toLocaleString() + " tokens" : "Endpoint output limit unavailable"
        ].join(" · ").slice(0, 320)
      }));
      const observedAt = Date.now();
      catalog = { provider: "openrouter", state: "ready", requestedAt: old.requestedAt, observedAt, models };
      writeDurableSoon(STATE, { observedAt, models });
    } catch (error) {
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
  request = null; changed = () => {};
  catalog = { provider: "openrouter", state: "unknown", requestedAt: null, observedAt: null, models: [] };
}
