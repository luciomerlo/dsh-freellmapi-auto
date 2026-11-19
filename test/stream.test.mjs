import assert from 'node:assert/strict'
import test from 'node:test'

import { StreamIdleError } from '../src/sse.js'
import { completionToChunks, finishReasonOf, toStreamChunks } from '../src/stream.js'

/**
 * Build an SSE body from decoded chunks.
 * @param {any[]} frames - JSON payloads.
 * @param {{done?: boolean}} [options] - whether to append the terminator.
 * @returns {ReadableStream<Uint8Array>} the body.
 */
function sseBody(frames, options = {}) {
  const text = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')
    + (options.done === false ? '' : 'data: [DONE]\n\n')
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

/**
 * Collect every chunk of a stream.
 * @param {AsyncIterable<object>} stream - the chunk stream.
 * @returns {Promise<object[]>} the chunks.
 */
async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

test('text, reasoning, and tool calls get distinct global block indices', async () => {
  const chunks = await collect(toStreamChunks(sseBody([
    { choices: [{ delta: { reasoning_content: 'think' } }] },
    { choices: [{ delta: { content: 'Hello' } }] },
    { choices: [{ delta: { content: ' there' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'read', arguments: '{"pa' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] }, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } },
  ]), 'groq/llama-3.3-70b'))

  const starts = chunks.filter((chunk) => chunk.type === 'block-start')
  assert.deepEqual(starts.map((chunk) => chunk.blockType), ['reasoning', 'text', 'tool-call'])
  assert.deepEqual(starts.map((chunk) => chunk.index), [0, 1, 2])

  const usageIndex = chunks.findIndex((chunk) => chunk.type === 'usage')
  const finishIndex = chunks.findIndex((chunk) => chunk.type === 'finish')
  assert.ok(usageIndex >= 0)
  assert.ok(usageIndex < finishIndex, 'usage precedes finish')
  assert.equal(chunks.at(-1).type, 'finish')
  assert.deepEqual(chunks.at(-1).reason, { kind: 'tool-calls' })

  const toolEnd = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
  assert.equal(toolEnd.block.arguments, '{"path":"a"}')
  assert.equal(toolEnd.block.name, 'read')
})

test('an empty completion is a retryable failure, not a silent success', async () => {
  const chunks = await collect(toStreamChunks(sseBody([
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]), 'groq/empty'))
  assert.deepEqual(chunks.at(-1).reason, {
    kind: 'error',
    failure: { message: 'groq/empty: the upstream returned an empty response', code: 'EMPTY_RESPONSE' },
  })
})

test('an in-stream error object terminates with a classified failure', async () => {
  const chunks = await collect(toStreamChunks(sseBody([
    { choices: [{ delta: { content: 'partial' } }] },
    { error: { message: 'upstream overloaded', code: 'server_error' } },
  ]), 'nvidia/model'))
  const finish = chunks.at(-1)
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'server_error')
  assert.ok(chunks.some((chunk) => chunk.type === 'block-end' && chunk.block.type === 'text'))
})

test('a stream that goes quiet trips the idle watchdog', async () => {
  let served = false
  const body = new ReadableStream({
    pull(controller) {
      if (!served) {
        served = true
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'))
        return
      }
      // Never resolves: the stream is stalled, not finished.
      return new Promise(() => {})
    },
  })
  const stream = toStreamChunks(body, 'stalled/model', undefined, { idleTimeoutMs: 60, firstTokenTimeoutMs: 60 })
  await assert.rejects(async () => {
    for await (const chunk of stream) void chunk
  }, (error) => error instanceof StreamIdleError && error.phase === 'idle')
})

test('a provider that never starts answering trips the first-token watchdog', async () => {
  const body = new ReadableStream({
    pull() {
      return new Promise(() => {})
    },
  })
  const stream = toStreamChunks(body, 'silent/model', undefined, { firstTokenTimeoutMs: 50 })
  await assert.rejects(async () => {
    for await (const chunk of stream) void chunk
  }, (error) => error instanceof StreamIdleError && error.phase === 'first-token')
})

test('finish reasons map onto the harness vocabulary', () => {
  assert.deepEqual(finishReasonOf('length', false), { kind: 'max-tokens' })
  assert.deepEqual(finishReasonOf('tool_calls', false), { kind: 'tool-calls' })
  assert.deepEqual(finishReasonOf('stop', true), { kind: 'tool-calls' })
  assert.deepEqual(finishReasonOf('stop', false), { kind: 'stop' })
  assert.equal(finishReasonOf('content_filter', false).kind, 'error')
})

test('a non-streamed completion payload is converted, not treated as empty', () => {
  const chunks = completionToChunks({
    choices: [{ message: { content: 'whole answer', tool_calls: [] }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 2 },
  }, 'together/model')
  assert.ok(chunks.some((chunk) => chunk.type === 'text-delta' && chunk.text === 'whole answer'))
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.ok(chunks.some((chunk) => chunk.type === 'usage'))
})
