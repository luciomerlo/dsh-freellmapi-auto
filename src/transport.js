/**
 * HTTP transport for OpenAI-compatible Chat Completions endpoints.
 *
 * One attempt is one HTTP request with one deadline. The transport never retries:
 * retrying is the router's job, because only the router knows what else is
 * healthy and which bucket just went into cooldown.
 *
 * @module dsh-freellmapi-auto/transport
 */

import { authHeaders } from './endpoints.js'
import { RouteError, codeForStatus, retryAfterMs } from './errors.js'
import { userAgent } from './identity.js'

/** Largest error body worth reading back into a diagnostic. */
const MAX_ERROR_BYTES = 8192

/**
 * A gateway that answers `/chat/completions`.
 */
export class HttpTransport {
  /**
   * @param {object} options - construction options.
   * @param {Record<string, any>} options.config - resolved plugin config.
   * @param {{info: Function, warn: Function, debug: Function}} options.logger - diagnostics sink.
   */
  constructor({ config, logger }) {
    this.config = config
    this.logger = logger
  }

  /**
   * Open one streaming attempt.
   * @param {object} input - the attempt.
   * @param {{baseUrl: string, auth: string, apiKey: string, bucket: string}} input.target - where to call.
   * @param {string} input.model - upstream model id, for diagnostics.
   * @param {Record<string, unknown>} input.body - JSON body.
   * @param {AbortSignal} [input.signal] - caller cancellation.
   * @param {number} [input.connectTimeoutMs] - deadline for the response headers.
   * @returns {Promise<{kind: 'sse', body: ReadableStream<Uint8Array>} | {kind: 'json', payload: any}>} the opened response.
   */
  async open({ target, model, body, signal, connectTimeoutMs }) {
    const url = `${target.baseUrl}/chat/completions`
    const requestTimeoutMs = Number(this.config.requestTimeoutMs) || 180_000
    const connectBudget = Number(connectTimeoutMs) > 0 ? Number(connectTimeoutMs) : requestTimeoutMs
    const connectMs = Math.min(requestTimeoutMs, connectBudget)

    // The connect deadline must cover the response headers only. A signal owned
    // by the whole fetch also governs the body, so leaving it armed would abort
    // a healthy stream once the header deadline expired mid-answer.
    const controller = new AbortController()
    let connectExpired = false
    let attemptExpired = false
    const connectTimer = setTimeout(() => {
      connectExpired = true
      controller.abort()
    }, connectMs)
    const attemptTimer = setTimeout(() => {
      attemptExpired = true
      controller.abort()
    }, requestTimeoutMs)
    const stopTimers = () => {
      clearTimeout(connectTimer)
      clearTimeout(attemptTimer)
    }
    const combined = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal])

    let response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'user-agent': userAgent(),
          ...authHeaders(target.auth, target.apiKey),
        },
        body: JSON.stringify(body),
        signal: combined,
        redirect: 'follow',
      })
    } catch (error) {
      stopTimers()
      if (signal?.aborted === true) {
        throw new RouteError({ message: 'the request was cancelled', code: 'ABORTED', provider: target.bucket, model })
      }
      if (connectExpired || attemptExpired) {
        throw new RouteError({
          message: `${model}: the provider did not answer within ${String(connectMs)}ms`,
          code: 'TIMEOUT',
          provider: target.bucket,
          model,
        })
      }
      const detail = error instanceof Error ? error.message : String(error)
      throw new RouteError({ message: `${model}: ${detail}`, code: 'TRANSPORT', provider: target.bucket, model })
    }

    // Headers are in: the first-token budget is spent and must not fire later.
    clearTimeout(connectTimer)

    if (!response.ok) {
      stopTimers()
      const detail = await readErrorDetail(response)
      const code = codeForStatus(response.status, detail)
      throw new RouteError({
        message: `${model}: ${String(response.status)} ${truncate(detail === '' ? response.statusText : detail, 400)}`,
        code,
        status: response.status,
        ...(retryAfterMs(response.headers.get('retry-after')) === undefined
          ? {}
          : { providerRetryAfterMs: retryAfterMs(response.headers.get('retry-after')) }),
        provider: target.bucket,
        model,
      })
    }

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
    if (contentType.includes('text/event-stream') && response.body !== null) {
      return { kind: 'sse', body: response.body, release: stopTimers }
    }

    // Some gateways ignore `stream: true`. Read the body once and decide from
    // its shape rather than from a content type they may not set.
    const text = await response.text().catch(() => '')
    stopTimers()
    if (text.trim() === '') {
      throw new RouteError({
        message: `${model}: the provider returned an empty body`,
        code: 'EMPTY_RESPONSE',
        provider: target.bucket,
        model,
      })
    }
    if (text.includes('data:')) {
      return { kind: 'sse', body: streamFromText(text) }
    }
    try {
      return { kind: 'json', payload: JSON.parse(text) }
    } catch {
      throw new RouteError({
        message: `${model}: the provider returned a body that is neither SSE nor JSON`,
        code: 'PROVIDER_ERROR',
        provider: target.bucket,
        model,
      })
    }
  }
}

/**
 * Read a bounded error body and reduce it to one line.
 * @param {Response} response - the failed response.
 * @returns {Promise<string>} the provider's message.
 */
export async function readErrorDetail(response) {
  let text = ''
  try {
    text = await response.text()
  } catch {
    return ''
  }
  if (text === '') return ''
  if (text.length > MAX_ERROR_BYTES) text = text.slice(0, MAX_ERROR_BYTES)
  try {
    const parsed = JSON.parse(text)
    const message = parsed?.error?.message ?? parsed?.message ?? parsed?.error
    if (typeof message === 'string' && message !== '') return message
  } catch {
    // Not JSON: the text itself is the message.
  }
  return text.replace(/\s+/gu, ' ').trim()
}

/**
 * Re-wrap a text body as a byte stream so the SSE reader can consume it.
 * @param {string} text - the body.
 * @returns {ReadableStream<Uint8Array>} a single-chunk stream.
 */
export function streamFromText(text) {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

/**
 * Cut a diagnostic string to a bounded length.
 * @param {string} value - the value.
 * @param {number} max - the maximum length.
 * @returns {string} the (possibly shortened) value.
 */
export function truncate(value, max) {
  if (typeof value !== 'string') return ''
  return value.length <= max ? value : `${value.slice(0, max)}…`
}
