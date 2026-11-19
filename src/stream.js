/**
 * Translation from an OpenAI-compatible stream into harness `StreamChunk`s.
 *
 * Two invariants are easy to break and expensive to debug:
 *
 *  - block indices are one global counter. Counting text and reasoning
 *    separately makes a "think first, then answer" turn collide on index 0 and
 *    silently drop the answer;
 *  - a tool call does not close an open text block. Models interleave prose and
 *    tool calls, and closing early splits one paragraph into several blocks.
 *
 * `usage` always precedes the terminal `finish`, and nothing follows `finish`.
 *
 * @module dsh-freellmapi-auto/stream
 */

import { readSseJson } from './sse.js'

/**
 * Read the text, reasoning, and tool-call deltas of one upstream chunk.
 * @param {any} chunk - one decoded SSE object.
 * @returns {{content: string, reasoning: string, toolCalls: Array<{index: number, id: string, name: string, args: string}>, finish: string}} the parts.
 */
export function chunkDelta(chunk) {
  const choice = Array.isArray(chunk?.choices) ? chunk.choices[0] : undefined
  const delta = choice?.delta ?? choice?.message ?? {}
  const toolCalls = []
  for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
    toolCalls.push({
      index: typeof call?.index === 'number' ? call.index : 0,
      id: typeof call?.id === 'string' ? call.id : '',
      name: typeof call?.function?.name === 'string' ? call.function.name : '',
      args: typeof call?.function?.arguments === 'string'
        ? call.function.arguments
        : typeof call?.function?.arguments === 'object' && call.function.arguments !== null
          ? JSON.stringify(call.function.arguments)
          : '',
    })
  }
  return {
    content: typeof delta.content === 'string' ? delta.content : '',
    reasoning: typeof delta.reasoning_content === 'string'
      ? delta.reasoning_content
      : typeof delta.reasoning === 'string' ? delta.reasoning : '',
    toolCalls,
    finish: typeof choice?.finish_reason === 'string' ? choice.finish_reason : '',
  }
}

/**
 * Read the usage block of one upstream chunk.
 * @param {any} chunk - one decoded SSE object.
 * @returns {{inputTokens: number, outputTokens: number, totalTokens?: number, cacheReadTokens?: number, reasoningTokens?: number} | undefined} usage, when present.
 */
export function chunkUsage(chunk) {
  const usage = chunk?.usage
  if (usage === null || typeof usage !== 'object') return undefined
  const input = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0
  const output = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0
  const result = { inputTokens: input, outputTokens: output }
  if (typeof usage.total_tokens === 'number') result.totalTokens = usage.total_tokens
  const cached = usage.prompt_tokens_details?.cached_tokens
  if (typeof cached === 'number' && cached > 0) result.cacheReadTokens = cached
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  if (typeof reasoning === 'number' && reasoning > 0) result.reasoningTokens = reasoning
  return result
}

/**
 * Map an upstream `finish_reason` onto the harness finish reason.
 * @param {string} finish - upstream reason.
 * @param {boolean} sawToolCall - whether the turn emitted a tool call.
 * @returns {object} the harness finish reason.
 */
export function finishReasonOf(finish, sawToolCall) {
  if (finish === 'length') return { kind: 'max-tokens' }
  if (finish === 'tool_calls' || finish === 'function_call') return { kind: 'tool-calls' }
  if (finish === 'content_filter') {
    return {
      kind: 'error',
      failure: { message: 'the upstream provider filtered this response', code: 'CONTENT_FILTERED' },
    }
  }
  if (sawToolCall && (finish === '' || finish === 'stop')) return { kind: 'tool-calls' }
  return { kind: 'stop' }
}

/**
 * Stateful converter shared by the SSE and JSON paths.
 */
class ChunkBuilder {
  constructor(model) {
    this.model = model
    this.nextIndex = 0
    this.textIndex = -1
    this.reasoningIndex = -1
    this.textOpen = false
    this.reasoningOpen = false
    this.text = ''
    this.reasoning = ''
    /** @type {Map<number, {id: string, name: string, args: string}>} */
    this.toolCalls = new Map()
    /** @type {Map<number, number>} */
    this.toolIndexes = new Map()
    this.sawToolCall = false
  }

  /**
   * Feed one delta and collect the chunks it produces.
   * @param {{content: string, reasoning: string, toolCalls: Array<{index: number, id: string, name: string, args: string}>}} delta - one delta.
   * @param {object[]} out - the chunk sink.
   * @returns {void}
   */
  push(delta, out) {
    if (delta.reasoning !== '') {
      if (!this.reasoningOpen) {
        this.reasoningIndex = this.nextIndex
        this.nextIndex += 1
        this.reasoningOpen = true
        out.push({ type: 'block-start', index: this.reasoningIndex, blockType: 'reasoning' })
      }
      this.reasoning += delta.reasoning
      out.push({ type: 'reasoning-delta', index: this.reasoningIndex, text: delta.reasoning })
    }

    if (delta.content !== '') {
      if (this.reasoningOpen) {
        this.reasoningOpen = false
        out.push({
          type: 'block-end',
          index: this.reasoningIndex,
          block: { type: 'reasoning', text: this.reasoning },
        })
      }
      if (!this.textOpen) {
        this.textIndex = this.nextIndex
        this.nextIndex += 1
        this.textOpen = true
        out.push({ type: 'block-start', index: this.textIndex, blockType: 'text' })
      }
      this.text += delta.content
      out.push({ type: 'text-delta', index: this.textIndex, text: delta.content })
    }

    for (const call of delta.toolCalls) {
      let slot = this.toolCalls.get(call.index)
      if (slot === undefined) {
        slot = { id: '', name: '', args: '' }
        this.toolCalls.set(call.index, slot)
        this.toolIndexes.set(call.index, this.nextIndex)
        this.nextIndex += 1
        this.sawToolCall = true
        out.push({ type: 'block-start', index: this.toolIndexes.get(call.index), blockType: 'tool-call' })
      }
      if (call.id !== '') slot.id = call.id
      if (call.name !== '') slot.name = call.name
      slot.args += call.args
      out.push({
        type: 'tool-call-delta',
        index: this.toolIndexes.get(call.index),
        id: slot.id,
        ...(slot.name === '' ? {} : { name: slot.name }),
        argumentsDelta: call.args,
      })
    }
  }

  /**
   * Close every block this turn opened. An unpaired `block-start` would leave
   * the harness assembler waiting for it forever.
   * @param {object[]} out - the chunk sink.
   * @returns {void}
   */
  close(out) {
    if (this.reasoningOpen) {
      this.reasoningOpen = false
      out.push({ type: 'block-end', index: this.reasoningIndex, block: { type: 'reasoning', text: this.reasoning } })
    }
    if (this.textOpen) {
      this.textOpen = false
      out.push({ type: 'block-end', index: this.textIndex, block: { type: 'text', text: this.text } })
    }
    for (const [index, slot] of this.toolCalls) {
      out.push({
        type: 'block-end',
        index: this.toolIndexes.get(index),
        block: { type: 'tool-call', id: slot.id, name: slot.name, arguments: slot.args },
      })
    }
  }

  /** @returns {boolean} whether the turn produced anything a user can read. */
  get producedContent() {
    return this.text.trim() !== '' || this.reasoning.trim() !== ''
  }

  /** @returns {number} how many tool calls stayed unnamed. */
  get unnamedToolCalls() {
    let count = 0
    for (const slot of this.toolCalls.values()) {
      if (slot.name.trim() === '') count += 1
    }
    return count
  }
}

/**
 * Translate one upstream SSE body into harness chunks.
 * @param {ReadableStream<Uint8Array>} body - the upstream response body.
 * @param {string} model - the model id, for diagnostics.
 * @param {AbortSignal} [signal] - cancellation.
 * @param {object} [limits] - transport deadlines; see {@link readSse}.
 * @returns {AsyncGenerator<object>} harness chunks ending in exactly one `finish`.
 */
export async function* toStreamChunks(body, model, signal, limits = {}) {
  const builder = new ChunkBuilder(model)
  let finish = ''
  let usage
  /** @type {{message: string, code: string} | undefined} */
  let upstreamError = undefined

  try {
    for await (const frame of readSseJson(body, signal, limits)) {
      const chunk = frame.value
      if (chunk === null || typeof chunk !== 'object') continue

      // Some gateways report a failure inside an otherwise healthy SSE body.
      if (chunk.error !== null && typeof chunk.error === 'object') {
        upstreamError = {
          message: typeof chunk.error.message === 'string'
            ? chunk.error.message
            : `${model}: the upstream reported an error mid-stream`,
          code: typeof chunk.error.code === 'string' ? chunk.error.code : 'PROVIDER_ERROR',
        }
        break
      }

      const delta = chunkDelta(chunk)
      if (delta.finish !== '') finish = delta.finish
      const frameUsage = chunkUsage(chunk)
      if (frameUsage !== undefined) usage = frameUsage

      const emitted = []
      builder.push(delta, emitted)
      for (const chunkOut of emitted) yield chunkOut
    }
  } catch (error) {
    // A body that died mid-read must still close the blocks it opened: the
    // partial answer is real content, and an unpaired `block-start` would leave
    // the harness assembler waiting for a block end that never arrives.
    const partial = []
    builder.close(partial)
    for (const chunkOut of partial) yield chunkOut
    throw error
  }

  const closing = []
  builder.close(closing)
  for (const chunkOut of closing) yield chunkOut

  if (usage !== undefined) yield { type: 'usage', usage }

  if (upstreamError !== undefined) {
    yield { type: 'finish', reason: { kind: 'error', failure: upstreamError } }
    return
  }

  const unnamed = builder.unnamedToolCalls
  if (unnamed > 0) {
    yield {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          message: `${model}: the upstream returned ${String(unnamed)} unnamed tool call(s)`,
          code: 'UNNAMED_TOOL_CALL',
        },
      },
    }
    return
  }

  // An empty completion is a retryable failure, never a silent success.
  if (!builder.producedContent && !builder.sawToolCall && finish !== 'length') {
    yield {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: { message: `${model}: the upstream returned an empty response`, code: 'EMPTY_RESPONSE' },
      },
    }
    return
  }

  yield { type: 'finish', reason: finishReasonOf(finish, builder.sawToolCall) }
}

/**
 * Translate a complete (non-streamed) Chat Completions payload into harness chunks.
 *
 * Some free gateways ignore `stream: true` and answer with one JSON document.
 * Treating that as an empty stream would burn an attempt, so it is converted
 * here instead.
 *
 * @param {any} payload - the decoded completion document.
 * @param {string} model - the model id, for diagnostics.
 * @returns {object[]} harness chunks ending in exactly one `finish`.
 */
export function completionToChunks(payload, model) {
  const builder = new ChunkBuilder(model)
  const out = []
  if (payload !== null && typeof payload === 'object' && payload.error !== null && typeof payload.error === 'object') {
    return [{
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          message: typeof payload.error.message === 'string' ? payload.error.message : `${model}: the upstream reported an error`,
          code: 'PROVIDER_ERROR',
        },
      },
    }]
  }

  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : undefined
  const message = choice?.message ?? {}
  const delta = chunkDelta({ choices: [{ message, finish_reason: choice?.finish_reason }] })
  builder.push(delta, out)
  builder.close(out)

  const usage = chunkUsage(payload)
  if (usage !== undefined) out.push({ type: 'usage', usage })

  if (!builder.producedContent && !builder.sawToolCall) {
    return [{
      type: 'finish',
      reason: {
        kind: 'error',
        failure: { message: `${model}: the upstream returned an empty response`, code: 'EMPTY_RESPONSE' },
      },
    }]
  }

  out.push({ type: 'finish', reason: finishReasonOf(delta.finish, builder.sawToolCall) })
  return out
}
