/**
 * Error vocabulary shared by the transport, the router, and the adapter.
 *
 * The harness classifies a failed attempt from the facts carried by the thrown
 * value: `code`, `status`, and an optional provider-requested delay. Keeping one
 * error class here means every layer reports the same shape and the router can
 * decide "retry another provider" from facts instead of message text.
 *
 * @module dsh-freellmapi-auto/errors
 */

/**
 * A classified upstream or configuration failure.
 */
export class RouteError extends Error {
  /**
   * @param {object} input - failure facts.
   * @param {string} input.message - human-readable English message.
   * @param {string} input.code - stable machine code (`RATE_LIMIT`, `CONTEXT_WINDOW`, ...).
   * @param {number} [input.status] - HTTP status when the provider answered.
   * @param {number} [input.providerRetryAfterMs] - provider-requested delay.
   * @param {string} [input.provider] - upstream platform, for diagnostics.
   * @param {string} [input.model] - upstream model id, for diagnostics.
   */
  constructor(input) {
    super(input.message)
    this.name = 'RouteError'
    this.code = input.code
    if (input.status !== undefined) this.status = input.status
    if (input.providerRetryAfterMs !== undefined && input.providerRetryAfterMs > 0) {
      this.providerRetryAfterMs = input.providerRetryAfterMs
    }
    if (input.provider !== undefined) this.provider = input.provider
    if (input.model !== undefined) this.model = input.model
  }

  /**
   * The `LlmFailure`-shaped payload the harness records for a failed attempt.
   * @returns {{message: string, code: string, status?: number, providerRetryAfterMs?: number}} failure facts.
   */
  toFailure() {
    return {
      message: this.message,
      code: this.code,
      ...(this.status === undefined ? {} : { status: this.status }),
      ...(this.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: this.providerRetryAfterMs }),
    }
  }
}

/**
 * Coerce any thrown value into failure facts.
 * @param {unknown} error - the thrown value.
 * @param {AbortSignal} [signal] - the caller's cancellation signal.
 * @returns {{message: string, code: string, status?: number, providerRetryAfterMs?: number}} failure facts.
 */
export function failureFacts(error, signal) {
  if (error instanceof RouteError) return error.toFailure()
  if (signal?.aborted === true) {
    return { message: 'the request was cancelled', code: 'ABORTED' }
  }
  if (error !== null && typeof error === 'object') {
    const candidate = /** @type {any} */ (error)
    if (candidate.name === 'AbortError') {
      return { message: 'the request was cancelled', code: 'ABORTED' }
    }
    if (typeof candidate.code === 'string' && candidate.code !== '') {
      return {
        message: typeof candidate.message === 'string' ? candidate.message : candidate.code,
        code: candidate.code,
        ...(typeof candidate.status === 'number' ? { status: candidate.status } : {}),
        ...(Number.isFinite(candidate.providerRetryAfterMs) && candidate.providerRetryAfterMs > 0
          ? { providerRetryAfterMs: candidate.providerRetryAfterMs }
          : {}),
      }
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { message, code: /timeout|timed out/i.test(message) ? 'TIMEOUT' : 'TRANSPORT' }
}

/**
 * Map an HTTP status onto the stable code the router classifies.
 * @param {number} status - provider HTTP status.
 * @param {string} [detail] - the provider's own message, used to separate quota from throttling.
 * @returns {string} a stable code.
 */
export function codeForStatus(status, detail = '') {
  const text = detail.toLowerCase()
  if (status === 401 || status === 403) return text.includes('quota') ? 'QUOTA' : 'AUTH'
  if (status === 402) return 'QUOTA'
  if (status === 408) return 'TIMEOUT'
  if (status === 413) return 'PAYLOAD_TOO_LARGE'
  if (status === 429) {
    if (/context|too many tokens|token limit|payload/i.test(detail)) return 'TPM_EXCEEDED'
    return 'RATE_LIMIT'
  }
  if (status === 400) {
    if (/context length|context window|too many tokens|maximum context|prompt is too long/i.test(detail)) {
      return 'CONTEXT_WINDOW'
    }
    return 'INVALID_REQUEST'
  }
  if (status >= 500) return 'SERVER_ERROR'
  return 'PROVIDER_ERROR'
}

/**
 * Codes that mean "another provider may serve this request right now".
 * @param {string} code - a failure code.
 * @returns {boolean} whether the attempt may be retried elsewhere.
 */
export function isRecoverable(code) {
  return code === 'RATE_LIMIT'
    || code === 'TPM_EXCEEDED'
    || code === 'PAYLOAD_TOO_LARGE'
    || code === 'SERVER_ERROR'
    || code === 'TRANSPORT'
    || code === 'TIMEOUT'
    || code === 'STREAM_STALLED'
    || code === 'EMPTY_RESPONSE'
    || code === 'PROVIDER_ERROR'
    || code === 'CONTEXT_WINDOW'
    || code === 'QUOTA'
}

/**
 * Parse a provider `Retry-After` header into milliseconds.
 * @param {string | null | undefined} value - the header value.
 * @returns {number | undefined} a positive delay, when the header is usable.
 */
export function retryAfterMs(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000)
  const date = Date.parse(value)
  if (Number.isFinite(date)) {
    const delta = date - Date.now()
    if (delta > 0) return delta
  }
  return undefined
}
