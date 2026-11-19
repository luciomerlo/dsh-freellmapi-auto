/**
 * Server-Sent Events reader with two transport deadlines.
 *
 * A free-tier endpoint can accept a request and then never answer, or answer and
 * then go quiet mid-response. Both look exactly like a slow model, so without a
 * deadline the turn would hang instead of failing over. Two independent
 * deadlines cover the two cases:
 *
 *  - the **first-frame** deadline bounds time-to-first-token; the router treats
 *    an expiry before any visible output as a transparent handoff;
 *  - the **idle** deadline bounds every later gap between frames.
 *
 * @module dsh-freellmapi-auto/sse
 */

/**
 * Raised when the stream produced no frame within a deadline.
 */
export class StreamIdleError extends Error {
  /**
   * @param {number} timeoutMs - the deadline that expired.
   * @param {'first-token' | 'idle'} phase - which deadline expired.
   */
  constructor(timeoutMs, phase) {
    super(phase === 'first-token'
      ? `the upstream produced no token within ${String(timeoutMs)}ms`
      : `the upstream produced no frame for ${String(timeoutMs)}ms`)
    this.name = 'StreamIdleError'
    this.code = 'TIMEOUT'
    this.timeoutMs = timeoutMs
    this.phase = phase
  }
}

/**
 * @typedef {object} SseFrame
 * @property {string} [event] - the frame's `event:` name, when present.
 * @property {string} data - the concatenated `data:` payload.
 * @property {string} [id] - the frame's `id:` value, when present.
 */

/**
 * Race one iterator step against a deadline.
 * @param {AsyncIterator<Uint8Array>} iterator - the body iterator.
 * @param {number} timeoutMs - deadline in milliseconds, or 0 to wait forever.
 * @param {'first-token' | 'idle'} phase - which deadline this is.
 * @returns {Promise<IteratorResult<Uint8Array>>} the next read.
 */
function nextWithDeadline(iterator, timeoutMs, phase) {
  if (timeoutMs <= 0) return iterator.next()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new StreamIdleError(timeoutMs, phase))
    }, timeoutMs)
    // Do not keep the event loop alive for a watchdog nobody is awaiting.
    if (typeof timer.unref === 'function') timer.unref()
    iterator.next().then(
      (step) => {
        clearTimeout(timer)
        resolve(step)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * Decode a byte stream into SSE frames.
 * @param {ReadableStream<Uint8Array>} body - the response body.
 * @param {AbortSignal} [signal] - cancellation for the read loop.
 * @param {object} [limits] - deadline configuration.
 * @param {number} [limits.idleTimeoutMs] - deadline between two frames; 0 disables it.
 * @param {number} [limits.firstTokenTimeoutMs] - deadline until the first frame; 0 disables it.
 * @returns {AsyncGenerator<SseFrame>} the frames in arrival order.
 * @throws {StreamIdleError} when a deadline expires.
 */
export async function* readSse(body, signal, limits = {}) {
  const idleTimeoutMs = limits.idleTimeoutMs ?? 0
  const firstTokenTimeoutMs = limits.firstTokenTimeoutMs ?? 0
  const decoder = new TextDecoder('utf-8')
  const iterator = body[Symbol.asyncIterator]()
  let buffer = ''
  let eventName
  let eventId
  let dataLines = []
  let sawFrame = false

  const flush = () => {
    if (dataLines.length === 0 && eventName === undefined) return undefined
    const frame = { data: dataLines.join('\n') }
    if (eventName !== undefined) frame.event = eventName
    if (eventId !== undefined) frame.id = eventId
    eventName = undefined
    eventId = undefined
    dataLines = []
    return frame
  }

  try {
    for (;;) {
      if (signal?.aborted === true) throw signal.reason ?? new Error('the stream was cancelled')
      const deadline = sawFrame ? idleTimeoutMs : Math.max(idleTimeoutMs, firstTokenTimeoutMs)
      const phase = sawFrame ? 'idle' : 'first-token'
      const step = await nextWithDeadline(iterator, deadline, phase)
      if (step.done) break

      buffer += decoder.decode(step.value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const rawLine = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
        if (line === '') {
          const frame = flush()
          if (frame !== undefined) {
            sawFrame = true
            yield frame
          }
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''))
        } else if (line.startsWith('event:')) {
          eventName = line.slice(6).trim()
        } else if (line.startsWith('id:')) {
          eventId = line.slice(3).trim()
        }
        newline = buffer.indexOf('\n')
      }
    }

    buffer += decoder.decode()
    if (buffer.length > 0) {
      const line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
      else if (line.startsWith('event:')) eventName = line.slice(6).trim()
    }
    const last = flush()
    if (last !== undefined) yield last
  } finally {
    // Releasing the iterator is what actually cancels an abandoned upstream
    // body, so a deadline firing cannot leave a socket open. A body whose
    // `return()` waits on a stalled read must not hold the turn hostage, so the
    // release is bounded rather than awaited indefinitely.
    try {
      const closing = iterator.return?.()
      if (closing !== undefined) {
        await Promise.race([closing.catch(() => {}), delay(250)])
      }
    } catch {
      // The body was already closed or failed.
    }
  }
}

/**
 * A timer promise that never keeps the process alive on its own.
 * @param {number} ms - how long to wait.
 * @returns {Promise<void>} resolves after the delay.
 */
function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

/**
 * Yield each SSE frame's JSON payload, skipping keep-alives and malformed frames.
 * @param {ReadableStream<Uint8Array>} body - the response body.
 * @param {AbortSignal} [signal] - cancellation for the read loop.
 * @param {object} [limits] - deadline configuration; see {@link readSse}.
 * @returns {AsyncGenerator<{event?: string, value: any, raw: string}>} decoded frames.
 */
export async function* readSseJson(body, signal, limits = {}) {
  for await (const frame of readSse(body, signal, limits)) {
    if (frame.data === '[DONE]') return
    if (frame.data.trim() === '') continue
    let value
    try {
      value = JSON.parse(frame.data)
    } catch {
      continue
    }
    yield { ...(frame.event === undefined ? {} : { event: frame.event }), value, raw: frame.data }
  }
}
