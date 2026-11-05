/** Only inference is retried. Tool dispatch and durable writes never enter this policy. */
import { ApiError } from './types.js';

const TRANSIENT = new Set(['NETWORK_UNAVAILABLE', 'CONNECTION_LOST', 'REQUEST_TIMEOUT',
  'RATE_LIMITED', 'PROVIDER_UNAVAILABLE', 'STREAM_INCOMPLETE', 'EMPTY_STREAM']);
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
    UNAUTHORIZED: 'The API key was rejected. Check the provider key in Settings.',
    INSUFFICIENT_CREDITS: 'The API account has insufficient credits.',
    FORBIDDEN: 'The provider refused this request or its account policy blocked it.',
    BAD_REQUEST: 'The provider rejected the request parameters.',
    MODEL_UNAVAILABLE: 'The selected model is unavailable.',
    TRUNCATED_COMPLETION: 'The model reached its output-token limit before completing this step.',
    CONTEXT_LIMIT: 'This conversation reached the selected model’s context limit.',
    THREAD_TOO_LARGE: 'The saved API conversation reached its local history limit.',
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
