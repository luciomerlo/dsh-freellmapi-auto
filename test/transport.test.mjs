import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import { HttpTransport } from '../src/transport.js'

const logger = { info() {}, warn() {}, debug() {} }

/**
 * Start one HTTP server and hand its port to the test.
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void} handler - request handler.
 * @returns {Promise<{port: number, close: () => Promise<void>}>} the server handle.
 */
async function serve(handler) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    port: typeof address === 'object' && address !== null ? address.port : 0,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

/**
 * Read a response body to completion.
 * @param {ReadableStream<Uint8Array>} body - the body.
 * @returns {Promise<string>} the decoded text.
 */
async function readBody(body) {
  const decoder = new TextDecoder()
  let text = ''
  for await (const chunk of body) text += decoder.decode(chunk, { stream: true })
  return text + decoder.decode()
}

/**
 * A transport aimed at one local port.
 * @param {Record<string, unknown>} [config] - config overrides.
 * @returns {HttpTransport} the transport.
 */
function transport(config = {}) {
  return new HttpTransport({
    config: { requestTimeoutMs: 5000, ...config },
    logger,
  })
}

/**
 * A route target for one local port.
 * @param {number} port - the server port.
 * @returns {any} the target.
 */
function target(port) {
  return { baseUrl: `http://127.0.0.1:${String(port)}`, auth: 'none', apiKey: '', bucket: 'test:0' }
}

test('a stream that starts before the connect deadline keeps running past it', async () => {
  const server = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n')
    // Deliberately later than the connect budget below.
    setTimeout(() => {
      res.write('data: {"choices":[{"delta":{"content":"second"}}]}\n\n')
      res.end('data: [DONE]\n\n')
    }, 450)
  })
  try {
    const opened = await transport().open({
      target: target(server.port),
      model: 'local/model',
      body: { model: 'local/model' },
      connectTimeoutMs: 150,
    })
    assert.equal(opened.kind, 'sse')
    const text = await readBody(/** @type {any} */ (opened).body)
    opened.release?.()
    assert.ok(text.includes('first'), 'the first frame must arrive')
    assert.ok(text.includes('second'), 'the body must not be aborted once headers arrived')
  } finally {
    await server.close()
  }
})

test('a provider that never sends headers fails with a TIMEOUT RouteError', async () => {
  const server = await serve(() => {
    // Never respond.
  })
  try {
    await assert.rejects(
      transport().open({
        target: target(server.port),
        model: 'local/silent',
        body: {},
        connectTimeoutMs: 120,
      }),
      (error) => {
        assert.equal(error.name, 'RouteError')
        assert.equal(error.code, 'TIMEOUT')
        assert.match(error.message, /did not answer within 120ms/)
        return true
      },
    )
  } finally {
    await server.close()
  }
})

test('an HTTP error is classified and carries the provider delay', async () => {
  const server = await serve((req, res) => {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '2' })
    res.end(JSON.stringify({ error: { message: 'rate limit reached for model x' } }))
  })
  try {
    await assert.rejects(
      transport().open({ target: target(server.port), model: 'local/limited', body: {}, connectTimeoutMs: 1000 }),
      (error) => {
        assert.equal(error.code, 'RATE_LIMIT')
        assert.equal(error.status, 429)
        assert.equal(error.providerRetryAfterMs, 2000)
        assert.match(error.message, /rate limit reached/)
        return true
      },
    )
  } finally {
    await server.close()
  }
})

test('a gateway that ignores stream:true is read as one JSON completion', async () => {
  const server = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: 'whole' }, finish_reason: 'stop' }] }))
  })
  try {
    const opened = await transport().open({
      target: target(server.port),
      model: 'local/json',
      body: { model: 'local/json' },
      connectTimeoutMs: 1000,
    })
    assert.equal(opened.kind, 'json')
    assert.equal(/** @type {any} */ (opened).payload.choices[0].message.content, 'whole')
  } finally {
    await server.close()
  }
})

test('a caller abort is reported as ABORTED, not as a provider timeout', async () => {
  const server = await serve(() => {
    // Never respond.
  })
  try {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 60)
    await assert.rejects(
      transport().open({
        target: target(server.port),
        model: 'local/aborted',
        body: {},
        signal: controller.signal,
        connectTimeoutMs: 4000,
      }),
      (error) => error.code === 'ABORTED',
    )
  } finally {
    await server.close()
  }
})
