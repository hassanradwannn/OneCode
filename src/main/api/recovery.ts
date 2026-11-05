/** Only inference is retried. Tool dispatch and durable writes never enter this policy. */
import { ApiError } from './types.js';

const TRANSIENT = new Set(['NETWORK_UNAVAILABLE', 'CONNECTION_LOST', 'REQUEST_TIMEOUT',
  'RATE_LIMITED', 'PROVIDER_UNAVAILABLE', 'STREAM_INCOMPLETE', 'EMPTY_STREAM', 'EMPTY_COMPLETION']);
export const API_RETRY_LIMIT = 5;
export function apiRetryDelay(error: unknown, attempt: number): number | null {
  if (!(error instanceof ApiError) || !TRANSIENT.has(error.code) || attempt >= API_RETRY_LIMIT) return null;
  const delay = [2000, 5000, 15000, 30000, 60000][attempt] ?? 60000;
  // A longer provider wait must be respected, not silently shortened into repeated requests.
  if (error.retryAfterMs !== null && error.retryAfterMs > 5 * 60_000) return null;
  return Math.max(delay, error.retryAfterMs ?? 0);
}

/** No raw exception/provider text: it can contain a key, private URL or echoed prompt. */
export function apiFailureDescription(error: unknown): string {
  const code = error instanceof ApiError ? error.code :
    ['EACCES', 'EPERM', 'EBUSY', 'ENOSPC', 'EIO'].includes(String((error as NodeJS.ErrnoException)?.code))
      ? 'LOCAL_STORAGE_UNAVAILABLE' : 'LOCAL_EXECUTION_FAILED';
  const reasons: Record<string, string> = {
    NETWORK_UNAVAILABLE: 'The API connection could not be established.',
    CONNECTION_LOST: 'The API connection closed while a response was being received.',
    REQUEST_TIMEOUT: 'The API request timed out.',
    RATE_LIMITED: 'The model provider rate-limited this request.',
    PROVIDER_UNAVAILABLE: 'The model provider is temporarily unavailable.',
    STREAM_INCOMPLETE: 'The API stream ended before its completion marker.',
    EMPTY_STREAM: 'The API returned no response stream.',
    EMPTY_COMPLETION: 'The API returned neither public response text nor a tool call.',
    CONTENT_FILTERED: 'The provider stopped this response because of its content policy.',
    UNAUTHORIZED: 'The API key was rejected. Check the provider key in Settings.',
    INSUFFICIENT_CREDITS: 'The API account has insufficient credits.',
    FORBIDDEN: 'The provider refused this request or its account policy blocked it.',
    BAD_REQUEST: 'The provider rejected the request parameters.',
    MODEL_UNAVAILABLE: 'The selected model is unavailable.',
    TRUNCATED_COMPLETION: 'The model reached its output-token limit before completing this step.',
    OUTPUT_RECOVERY_LIMIT: 'The model repeatedly exhausted its per-response output limit despite automatic continuation. Completed work and running tasks are retained; choose a different reasoning setting or model to continue.',
    EXEC_RECOVERY_STALLED: 'Terminal output recovery made no progress after repeated identical refusals. Completed results remain saved; command permission was not revoked. Inspect the listed results before continuing.',
    CONTEXT_LIMIT: 'This conversation reached the selected model’s context limit.',
    CONTEXT_PINNED_TOO_LARGE: 'The original/latest user request and current tool definitions leave too little context to compact safely. Saved history and running tasks are retained; choose a model with a larger context window.',
    COMPACTION_SUMMARY_FAILED: 'The context summary was empty, truncated or invalid. Original history and running tasks are retained; retry Compact context or choose another model.',
    COMPACTION_SUMMARY_TRUNCATED: 'The summary repeatedly reached its output-token limit despite a larger budget. Original history is retained; retry compaction with another model or reasoning setting.',
    COMPACTION_SUMMARY_TOO_LONG: 'The model repeatedly returned an oversized handoff despite requests for a shorter summary. Original history is retained; retry compaction or choose another model.',
    COMPACTION_SUMMARY_EMPTY: 'The model repeatedly returned no usable summary text. Original history is retained; retry compaction or choose another model.',
    COMPACTION_SUMMARY_TOOL_CALL: 'The model repeatedly proposed a tool instead of a summary. No proposed tool ran; original history is retained. Retry compaction or choose another model.',
    COMPACTION_NO_PROGRESS: 'Context compaction did not free enough space. Original history and running tasks are retained; choose a model with a larger context window.',
    COMPACTION_INPUT_TOO_LARGE: 'The archived conversation exceeds the bounded summary workload. Original history is retained; choose a larger-context model to compact it.',
    COMPACTION_ARCHIVE_FAILED: 'OneCode could not verify the saved context archive. The active conversation was not replaced.',
    COMPACTION_PROTOCOL_INVALID: 'The saved tool exchanges are incomplete or inconsistent. Original history is retained; inspect the saved outcomes before recovery.',
    THREAD_TOO_LARGE: 'The saved API conversation reached its local history limit.',
    REQUEST_TOO_LARGE: 'The serialized request exceeded OneCode’s 16 MiB transport limit. The conversation and saved results are retained; this limit is separate from the model’s token context window.',
    PROVIDER_REQUEST_TOO_LARGE: 'The provider rejected the request body as too large. The conversation and saved results are retained; its transport limit is separate from token context capacity.',
    MODEL_CATALOG_CHANGED: 'The API model catalog changed while this message was preparing. Retry with the current provider settings.',
    TOOL_LIMIT: 'This task reached the local tool-call limit.',
    ITERATION_LIMIT: 'This task reached the local model-step limit.',
    LOCAL_STORAGE_UNAVAILABLE: 'Local task history or proof storage could not be accessed. Check disk space and file access before continuing.',
    LOCAL_EXECUTION_FAILED: 'A local execution or history operation failed. Saved tool results must be checked before continuing.'
  };
  const http = error instanceof ApiError && error.status ? ` HTTP ${error.status}.` : '';
  return `${reasons[code] ?? 'The API could not complete this step.'}${http} (${code})`;
}

/** Normalize only transport errors, not failures from callbacks/history/tool execution. */
export function apiTransportError(error: unknown, receiving = false): ApiError {
  if (error instanceof ApiError) return error;
  const value = error as { name?: string; code?: string; cause?: { code?: string } };
  const code = value?.cause?.code ?? value?.code;
  if (value?.name === 'TimeoutError' || ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code ?? ''))
    return new ApiError('REQUEST_TIMEOUT');
  return new ApiError(receiving ? 'CONNECTION_LOST' : 'NETWORK_UNAVAILABLE');
}
