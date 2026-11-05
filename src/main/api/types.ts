/** Transport-neutral model, message, tool and completion contracts for the local API harness. */
export type ApiModel = {
  id: string;
  name: string;
  contextLength: number;
  maxCompletionTokens: number | null;
  supportsTools: boolean;
  supportedParameters: string[];
  reasoningMandatory?: boolean;
  reasoningEfforts?: string[];
  pricing: { prompt: string; completion: string };
};
export type ApiTool = { type: "function"; function: { name: string; description: string; parameters: object } };
export type ApiToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ApiMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ApiToolCall[]; reasoning_details?: unknown[] }
  | { role: "tool"; tool_call_id: string; content: string };
export type ApiCompletion = {
  id: string;
  model: string;
  content: string;
  toolCalls: ApiToolCall[];
  /** Opaque API reasoning metadata; round-trip unchanged without displaying it. */
  reasoningDetails: unknown[];
  finishReason: string | null;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
};
export type ApiCompleteOptions = {
  model: string;
  sessionId: string;
  messages: ApiMessage[];
  tools?: ApiTool[];
  maxCompletionTokens?: number;
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  signal?: AbortSignal;
  onText?: (increment: string) => void;
  /** A streamed function name is preparation evidence only, never execution authority. */
  onToolCall?: (name: string) => void;
  /** Metadata-only requests can explicitly disable model reasoning where supported. */
  reasoningEnabled?: boolean;
  /** Remote HTTP accepted. Caller must commit its exact local Send receipt first. */
  onAccepted?: () => Promise<void>;
  stream?: boolean;
};

export class ApiError extends Error {
  constructor(readonly code: string, readonly status: number | null = null) {
    super(code);
    this.name = "ApiError";
  }
}

