import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import { createProxyAdapter, PROXY_AUTO_ID, PROXY_ROUTE } from '../src/proxy-adapter.js'
import { resolveConfig } from '../index.js'
import { HttpTransport } from '../src/transport.js'

const logger = { info() {}, warn() {}, debug() {} }

/**
 * A stand-in for the inventory that exposes the unified token.
 * @param {string} token - the token to report.
 * @returns {any} the stub.
 */
function inventoryStub(token = 'unified-token') {
  return {
    dataDir: '',
    unifiedKey: () => token,
    snapshot: { models: [], available: true, dbPath: '', warnings: [] },
  }
}

/**
 * Build an adapter for a specific proxy port.
 * @param {number} port - the port.
 * @param {any} [inventory] - inventory stub.
 * @returns {any} the adapter and its telemetry.
 */
function build(port, inventory = inventoryStub()) {
  const telemetry = { turns: [], noteRoutes() {}, noteSync() {}, recordTurn(turn) { this.turns.push(turn) }, state: () => ({}) }
  const config = resolveConfig({ transport: 'proxy', proxyPort: port, proxyHost: '127.0.0.1' })
  const adapter = createProxyAdapter({
    config,
    inventory,
    transport: new HttpTransport({ config, logger }),
    telemetry,
    logger,
  })
  return { adapter, telemetry, config }
}

/**
 * Start a fake FreeLLMAPI proxy.
 * @param {(res: import('node:http').ServerResponse) => void} handler - response writer.
 * @returns {Promise<{port: number, close: () => Promise<void>}>} the server.
 */
async function serve(handler) {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'auto' }] }))
      return
    }
    handler(res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    port: typeof address === 'object' && address !== null ? address.port : 0,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

test('the proxy adapter advertises one virtual model on one route', async () => {
  const server = await serve((res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: [DONE]\n\n')
  })
  try {
    const { adapter } = build(server.port)
    const models = await adapter.listModels(PROXY_ROUTE)
    assert.equal(models.length, 1)
    assert.equal(models[0].provider, PROXY_ROUTE)
    assert.equal(models[0].id, PROXY_AUTO_ID)

    const resolved = await adapter.resolveModel(PROXY_ROUTE, PROXY_AUTO_ID)
    assert.equal(resolved.provider, PROXY_ROUTE)
    assert.equal(resolved.id, PROXY_AUTO_ID)
    assert.ok(Number.isInteger(resolved.context.contextWindow) && resolved.context.contextWindow > 0)
    assert.ok(Number.isSafeInteger(resolved.defaultMaxTokens) && resolved.defaultMaxTokens > 0)
  } finally {
    await server.close()
  }
})

test('a turn streams through the proxy and records one turn', async () => {
  const server = await serve((res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"proxied"}}]}\n\n')
    res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
    res.end('data: [DONE]\n\n')
  })
  try {
    const { adapter, telemetry } = build(server.port)
    const chunks = []
    for await (const chunk of adapter.stream({
      provider: PROXY_ROUTE,
      model: PROXY_AUTO_ID,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) chunks.push(chunk)

    const text = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
    assert.equal(text, 'proxied')
    assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })

    const turn = telemetry.turns.at(-1)
    assert.equal(turn.ok, true)
    assert.equal(turn.served.platform, 'freellmapi-proxy')
    assert.equal(turn.attempts, 1)
  } finally {
    await server.close()
  }
})

test('a stopped proxy ends the turn with PROXY_UNREACHABLE', async () => {
  const dead = await serve((res) => {
    res.writeHead(500)
    res.end()
  })
  const port = dead.port
  await dead.close()

  const { adapter } = build(port)
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: PROXY_ROUTE,
    model: PROXY_AUTO_ID,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })) chunks.push(chunk)

  const finish = chunks.at(-1)
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'PROXY_UNREACHABLE')
})

test('the status surface also works in proxy mode', async () => {
  const server = await serve((res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: [DONE]\n\n')
  })
  try {
    const { adapter } = build(server.port)
    await adapter.listModels(PROXY_ROUTE)
    const state = adapter.state()
    assert.equal(state.transport, 'proxy')
    assert.equal(state.proxy.port, server.port)
    assert.equal(state.proxy.reachable, true)
  } finally {
    await server.close()
  }
})
