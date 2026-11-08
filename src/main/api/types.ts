/** Transport-neutral model, message, tool and completion contracts for the local API harness. */
import type { ApiInputModality } from '../../shared/chat-models.js';

export const API_REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ApiReasoningEffort = (typeof API_REASONING_EFFORTS)[number];

export type ApiModel = {
  id: string;
  name: string;
  contextLength: number;
  maxCompletionTokens: number | null;
  supportsTools: boolean;
  inputModalities?: ApiInputModality[];
  supportedParameters: string[];
  reasoningMandatory?: boolean;
  reasoningEfforts?: ApiReasoningEffort[];
  pricing: { prompt: string; completion: string };
};
export type ApiTool = { type: "function"; function: { name: string; description: string; parameters: object } };
export type ApiToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ApiUserPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'file'; file: { filename: string; file_data: string } }
  | { type: 'input_audio'; input_audio: { data: string; format: string } }
  | { type: 'video_url'; video_url: { url: string } };
export type ApiMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ApiUserPart[] }
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
  inputModalities?: ApiInputModality[];
  tools?: ApiTool[];
  maxCompletionTokens?: number;
  reasoningEffort?: ApiReasoningEffort;
  signal?: AbortSignal;
  onText?: (increment: string) => void;
  /** A streamed function name is preparation evidence only, never execution authority. */
  onToolCall?: (name: string) => void;
  /** Metadata-only requests can explicitly disable model reasoning where supported. */
  reasoningEnabled?: boolean;
  /** Remote HTTP accepted. Caller must commit its exact local Send receipt first. */
  onAccepted?: () => Promise<void>;
  /** Local serialization passed; a network attempt is starting, not a delivery receipt. */
  onDispatch?: (requestBytes: number) => void;
  stream?: boolean;
};

export class ApiError extends Error {
  constructor(readonly code: string, readonly status: number | null = null, readonly retryAfterMs: number | null = null) {
    super(code);
    this.name = "ApiError";
  }
}

