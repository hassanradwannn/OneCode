import { ApiError as OpenRouterApiError, type ApiModel as OpenRouterModel,
  type ApiToolCall as OpenRouterToolCall,
  type ApiCompletion as OpenRouterCompletion,
  type ApiCompleteOptions } from "../api/types.js";
export { ApiError as OpenRouterApiError } from "../api/types.js";
export type { ApiModel as OpenRouterModel, ApiTool as OpenRouterTool, ApiToolCall as OpenRouterToolCall,
  ApiMessage as OpenRouterMessage, ApiCompletion as OpenRouterCompletion } from "../api/types.js";
export type CompleteOptions = ApiCompleteOptions & { apiKey: string };
import { apiTransportError } from '../api/recovery.js';
/** OpenRouter transport only. All local tool execution remains owned by OneCode. */
export const OPENROUTER_API = "https://openrouter.ai/api/v1";
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_TOOL_ARGUMENTS = 64 * 1024;

/** OpenRouter's documented free router, even when /models omits this virtual model. */
export const FREE_ROUTER_MODEL: OpenRouterModel = {
  // The router may select models with different context windows. Until the
  // endpoint reports a concrete limit, use an estimated local budget that
  // leaves room for OneCode's complete tool schema. It is not a route guarantee.
  id: "openrouter/free", name: "Free Models Router", contextLength: 32768,
  maxCompletionTokens: null, supportsTools: true, supportedParameters: ["tools"],
  pricing: { prompt: "0", completion: "0" }
};
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const positive = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
const str = (value: unknown): string => typeof value === "string" ? value : "";

function authHeaders(apiKey: string): HeadersInit {
  if (!apiKey || apiKey.length > 512 || /[\r\n]/.test(apiKey)) throw new OpenRouterApiError("INVALID_KEY");
  return { Authorization: "Bearer " + apiKey, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
}

function apiFailure(status: number, retryAfterMs: number | null = null): OpenRouterApiError {
  const known: Record<number, string> = { 400: "BAD_REQUEST", 401: "UNAUTHORIZED", 402: "INSUFFICIENT_CREDITS",
    403: "FORBIDDEN", 404: "MODEL_UNAVAILABLE", 408: "REQUEST_TIMEOUT", 429: "RATE_LIMITED" };
  return new OpenRouterApiError(known[status] ?? (status >= 500 ? "PROVIDER_UNAVAILABLE" : "API_ERROR"), status, retryAfterMs);
}

function retryAfter(response: Response): number | null {
  const value = response.headers.get('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(delay) ? Math.max(0, delay) : null;
}

function streamFailure(payload: Record<string, unknown>): OpenRouterApiError | null {
  if (!isObject(payload.error)) return null;
  const status = typeof payload.error.code === 'number' ? payload.error.code : 502;
  return apiFailure(status);
}

async function boundedText(response: Response): Promise<string> {
  const data = await response.text().catch(error => { throw apiTransportError(error, true); });
  if (Buffer.byteLength(data) > MAX_RESPONSE_BYTES) throw new OpenRouterApiError("RESPONSE_TOO_LARGE");
  return data;
}

function parseUsage(value: unknown): OpenRouterCompletion["usage"] {
  if (!isObject(value)) return null;
  const promptTokens = positive(value.prompt_tokens) ?? 0;
  const completionTokens = positive(value.completion_tokens) ?? 0;
  const totalTokens = positive(value.total_tokens) ?? promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens };
}

function validatedCall(value: unknown): OpenRouterToolCall {
  if (!isObject(value) || !isObject(value.function)) throw new OpenRouterApiError("INVALID_TOOL_CALL");
  const id = str(value.id), name = str(value.function.name), args = str(value.function.arguments);
  if (!id || id.length > 200 || !/^[A-Za-z0-9_-]+$/.test(id) ||
      !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) || args.length > MAX_TOOL_ARGUMENTS)
    throw new OpenRouterApiError("INVALID_TOOL_CALL");
  try { const parsed = JSON.parse(args); if (!isObject(parsed)) throw new Error("arguments are not an object"); }
  catch { throw new OpenRouterApiError("INVALID_TOOL_ARGUMENTS"); }
  return { id, type: "function", function: { name, arguments: args } };
}

function parseCompletion(value: unknown): OpenRouterCompletion {
  if (!isObject(value) || !Array.isArray(value.choices) || !isObject(value.choices[0]))
    throw new OpenRouterApiError("INVALID_RESPONSE");
  const choice = value.choices[0] as Record<string, unknown>;
  const message = isObject(choice.message) ? choice.message : null;
  if (!message) throw new OpenRouterApiError("INVALID_RESPONSE");
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls.map(validatedCall) : [];
  if (new Set(calls.map(call => call.id)).size !== calls.length) throw new OpenRouterApiError("DUPLICATE_TOOL_CALL");
  const finishReason = str(choice.finish_reason) || null;
  if (finishReason === "length") throw new OpenRouterApiError("TRUNCATED_COMPLETION");
  return { id: str(value.id), model: str(value.model), content: str(message.content), toolCalls: calls,
    reasoningDetails: Array.isArray(message.reasoning_details) ? message.reasoning_details : [],
    finishReason, usage: parseUsage(value.usage) };
}

/** Assemble fragmented SSE deltas; no tool call is returned until [DONE] is observed. */
async function streamCompletion(response: Response, onText?: (increment: string) => void,
  onToolCall?: (name: string) => void): Promise<OpenRouterCompletion> {
  if (!response.body) throw new OpenRouterApiError("EMPTY_STREAM");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  const parts = new Map<number, { id: string; name: string; arguments: string }>();
  let bytes = 0, pending = "", complete = false, content = "", id = "", model = "", finishReason: string | null = null;
  const reasoningDetails: unknown[] = [];
  let usage: OpenRouterCompletion["usage"] = null;
  const take = (data: string) => {
    if (data === "[DONE]") { complete = true; return; }
    let payload: unknown;
    try { payload = JSON.parse(data); } catch { throw new OpenRouterApiError("INVALID_STREAM_EVENT"); }
    if (!isObject(payload)) return;
    const failure = streamFailure(payload);
    if (failure) throw failure;
    id ||= str(payload.id); model ||= str(payload.model);
    if (payload.usage !== undefined) usage = parseUsage(payload.usage);
    if (!Array.isArray(payload.choices)) return;
    for (const choice of payload.choices) {
      if (!isObject(choice)) continue;
      if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
      if (!isObject(choice.delta)) continue;
      if (Array.isArray(choice.delta.reasoning_details)) reasoningDetails.push(...choice.delta.reasoning_details);
      if (typeof choice.delta.content === "string") { content += choice.delta.content; onText?.(choice.delta.content); }
      if (!Array.isArray(choice.delta.tool_calls)) continue;
      for (const delta of choice.delta.tool_calls) {
        if (!isObject(delta) || !Number.isSafeInteger(delta.index) || (delta.index as number) < 0 || (delta.index as number) > 63)
          throw new OpenRouterApiError("INVALID_TOOL_DELTA");
        const index = delta.index as number, prior = parts.get(index) ?? { id: "", name: "", arguments: "" };
        if (typeof delta.id === "string") prior.id += delta.id;
        if (isObject(delta.function)) {
          if (typeof delta.function.name === "string") prior.name += delta.function.name;
          if (typeof delta.function.arguments === "string") prior.arguments += delta.function.arguments;
        }
        if (prior.arguments.length > MAX_TOOL_ARGUMENTS) throw new OpenRouterApiError("TOOL_ARGUMENTS_TOO_LARGE");
        parts.set(index, prior);
        if (/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(prior.name)) onToolCall?.(prior.name);
      }
    }
  };
  try {
    while (!complete) {
      const next = await reader.read().catch(error => { throw apiTransportError(error, true); });
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new OpenRouterApiError("RESPONSE_TOO_LARGE");
      // Normalize CRLF after joining chunks, including a CR split from its LF.
      pending = (pending + decoder.decode(next.value, { stream: true })).replace(/\r\n/g, "\n");
      let boundary: number;
      while ((boundary = pending.indexOf("\n\n")) >= 0) {
        const event = pending.slice(0, boundary).replace(/\r/g, ""); pending = pending.slice(boundary + 2);
        const data = event.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (data) take(data);
        if (complete) break;
      }
    }
  } finally { await reader.cancel().catch(() => undefined); }
  if (!complete) throw new OpenRouterApiError("STREAM_INCOMPLETE");
  if (finishReason === "length") throw new OpenRouterApiError("TRUNCATED_COMPLETION");
  const toolCalls = [...parts].sort(([a], [b]) => a - b).map(([, call]) =>
    validatedCall({ id: call.id, function: { name: call.name, arguments: call.arguments } }));
  if (new Set(toolCalls.map(call => call.id)).size !== toolCalls.length) throw new OpenRouterApiError("DUPLICATE_TOOL_CALL");
  return { id, model, content, toolCalls, reasoningDetails, finishReason, usage };
}

export class OpenRouterClient {
  constructor(private readonly transport: typeof fetch = fetch, private readonly baseUrl = OPENROUTER_API) {}

  async models(apiKey: string, signal?: AbortSignal): Promise<OpenRouterModel[]> {
    const response = await this.transport(this.baseUrl + "/models", { headers: authHeaders(apiKey), signal }).catch(error => {
      if (signal?.aborted && signal.reason?.name !== 'TimeoutError') throw error;
      throw apiTransportError(error);
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw apiFailure(response.status, retryAfter(response));
    }
    let value: unknown;
    const raw = await boundedText(response);
    try { value = JSON.parse(raw); } catch { throw new OpenRouterApiError("INVALID_CATALOG"); }
    if (!isObject(value) || !Array.isArray(value.data)) throw new OpenRouterApiError("INVALID_CATALOG");
    return value.data.flatMap((entry: unknown): OpenRouterModel[] => {
      if (!isObject(entry)) return [];
      const id = str(entry.id), name = str(entry.name) || id;
      const top = isObject(entry.top_provider) ? entry.top_provider : {};
      const contextLength = positive(top.context_length) ?? positive(entry.context_length);
      if (!id || id.length > 200 || !/^[A-Za-z0-9._:\/-]+$/.test(id) || !contextLength) return [];
      const supportedParameters = Array.isArray(entry.supported_parameters) ?
        entry.supported_parameters.filter((item: unknown): item is string => typeof item === "string") : [];
      const pricing = isObject(entry.pricing) ? entry.pricing : {};
      const reasoning = isObject(entry.reasoning) ? entry.reasoning : {};
      return [{ id, name: name.slice(0, 200), contextLength, maxCompletionTokens: positive(top.max_completion_tokens),
        supportsTools: supportedParameters.includes("tools"), supportedParameters,
        ...(typeof reasoning.mandatory === 'boolean' ? { reasoningMandatory: reasoning.mandatory } : {}),
        ...(Array.isArray(reasoning.supported_efforts) ? { reasoningEfforts: reasoning.supported_efforts.filter((value): value is string => typeof value === 'string') } : {}),
        pricing: { prompt: str(pricing.prompt), completion: str(pricing.completion) } }];
    });
  }

  async complete(input: CompleteOptions): Promise<OpenRouterCompletion> {
    if (!input.model || input.model.length > 200 || !/^[A-Za-z0-9._:\/-]+$/.test(input.model))
      throw new OpenRouterApiError("INVALID_MODEL");
    if (!input.sessionId || input.sessionId.length > 256) throw new OpenRouterApiError("INVALID_SESSION");
    if (!input.messages.length || input.messages.length > 2000) throw new OpenRouterApiError("INVALID_MESSAGES");
    if (input.tools && input.tools.length > 64) throw new OpenRouterApiError("TOO_MANY_TOOLS");
    const streaming = input.stream !== false;
    const body = JSON.stringify({ model: input.model, session_id: input.sessionId, messages: input.messages,
      ...(input.reasoningEnabled === false ? { reasoning: { enabled: false } }
        : input.reasoningEffort ? { reasoning: { enabled: true, effort: input.reasoningEffort } } : {}),
      ...(input.tools?.length ? { tools: input.tools, tool_choice: "auto", parallel_tool_calls: false } : {}),
      ...(input.maxCompletionTokens ? { max_completion_tokens: input.maxCompletionTokens } : {}),
      stream: streaming, ...(streaming ? { stream_options: { include_usage: true } } : {}) });
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) throw new OpenRouterApiError("REQUEST_TOO_LARGE");
    // One transport attempt only. The harness can retry inference from a saved checkpoint;
    // no local tool is executed until a complete validated response has been returned.
    const response = await this.transport(this.baseUrl + "/chat/completions", { method: "POST",
      headers: authHeaders(input.apiKey), body, signal: input.signal }).catch(error => {
        if (input.signal?.aborted && input.signal.reason?.name !== 'TimeoutError') throw error;
        throw apiTransportError(error);
      });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw apiFailure(response.status, retryAfter(response));
    }
    await input.onAccepted?.();
    if (streaming) return streamCompletion(response, input.onText, input.onToolCall);
    let value: unknown;
    const raw = await boundedText(response);
    try { value = JSON.parse(raw); } catch { throw new OpenRouterApiError("INVALID_RESPONSE"); }
    return parseCompletion(value);
  }
}
