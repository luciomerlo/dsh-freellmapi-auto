import assert from 'node:assert/strict'
import test from 'node:test'

import { createAdapter, harnessRetryPolicy } from '../src/adapter.js'
import { QuotaRegistry } from '../src/buckets.js'
import { RouteError } from '../src/errors.js'
import { resolveConfig } from '../index.js'

const logger = { info() {}, warn() {}, debug() {} }

/**
 * Build a route record for the fake inventory.
 * @param {object} overrides - field overrides.
 * @returns {any} the route.
 */
function route(overrides = {}) {
  return {
    dbId: 1,
    platform: 'groq',
    modelId: 'llama-3.3-70b-versatile',
    pin: 'groq/llama-3.3-70b-versatile',
    displayName: 'Llama 3.3 70B',
    iqRank: 20,
    speedRank: 10,
    rpm: null,
    rpd: null,
    tpm: null,
    tpd: null,
    contextWindow: 131_072,
    supportsTools: true,
    supportsVision: false,
    keyId: 1,
    bucket: 'groq:1',
    ...overrides,
  }
}

/**
 * A fake inventory with just enough surface for the adapter.
 * @param {any[]} models - the routes.
 * @returns {any} the inventory.
 */
function fakeInventory(models) {
  const pins = new Map(models.map((model) => [model.pin, model]))
  return {
    snapshot: {
      available: true,
      dbPath: 'C:/fake/freeapi.db',
      syncedAt: Date.now(),
      reason: 'test',
      models,
      pins,
      keys: new Map(),
      quotas: new Map(),
      seeded: new Map(),
      warnings: [],
    },
    refreshIfStale() {
      return false
    },
    sync() {
      return true
    },
    targetFor(model) {
      return {
        baseUrl: 'https://example.test/v1',
        auth: 'bearer',
        apiKey: 'test-key',
        keyId: model.keyId ?? 1,
        bucket: model.bucket,
      }
    },
    modelByPin(pin) {
      return pins.get(pin)
    },
  }
}

/**
 * A transport whose answers are scripted per upstream model id.
 * @param {Record<string, any[]>} script - per model id, a list of behaviours consumed in order.
 * @returns {any} the transport and its call log.
 */
function fakeTransport(script) {
  const calls = []
  return {
    calls,
    async open({ model }) {
      calls.push(model)
      const queue = script[model] ?? []
      const behaviour = queue.length > 1 ? queue.shift() : queue[0]
      if (behaviour === undefined) throw new Error(`unscripted model ${model}`)
      if (behaviour.status !== undefined) {
        throw new RouteError({
          message: `${model}: ${String(behaviour.status)} ${behaviour.detail ?? 'failed'}`,
          code: behaviour.code,
          status: behaviour.status,
          provider: model,
          model,
        })
      }
      const frames = behaviour.frames ?? []
      const text = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n'
      const bytes = new TextEncoder().encode(text)
      return {
        kind: 'sse',
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(bytes)
            controller.close()
          },
        }),
      }
    },
  }
}

const okFrames = [
  { choices: [{ delta: { content: 'answer' } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } },
]

/**
 * Run one request through the adapter.
 * @param {object} input - the test setup.
 * @returns {Promise<{chunks: object[], adapter: any, calls: string[]}>} the outcome.
 */
async function run({ models, script, config = {}, model = 'auto', provider = 'freellmapi-auto', tools }) {
  const inventory = fakeInventory(models)
  const quotas = new QuotaRegistry({ config: resolveConfig(config), logger })
  const transport = fakeTransport(script)
  const telemetry = {
    turns: [],
    noteRoutes() {},
    noteSync() {},
    recordTurn(turn) {
      this.turns.push(turn)
    },
    state() {
      return {}
    },
  }
  const adapter = createAdapter({
    config: resolveConfig({ maxAttempts: 4, ...config }),
    inventory,
    quotas,
    transport,
    telemetry,
    logger,
  })
  const chunks = []
  for await (const chunk of adapter.stream({
    provider,
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    ...(tools === undefined ? {} : { tools }),
  })) {
    chunks.push(chunk)
  }
  return { chunks, adapter, calls: transport.calls, telemetry, quotas }
}

test('a 429 rotates to a different physical provider instead of another alias of the same one', async () => {
  const { chunks, calls } = await run({
    models: [
      route({ modelId: 'alias-one', pin: 'groq/alias-one', bucket: 'groq:1', iqRank: 5 }),
      route({ modelId: 'alias-two', pin: 'groq/alias-two', bucket: 'groq:1', iqRank: 6 }),
      route({ modelId: 'other-provider', pin: 'cerebras/other-provider', platform: 'cerebras', bucket: 'cerebras:2', iqRank: 40 }),
    ],
    script: {
      'alias-one': [{ status: 429, code: 'RATE_LIMIT', detail: 'slow down' }],
      'other-provider': [{ frames: okFrames }],
    },
  })
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.equal(calls[0], 'alias-one')
  assert.equal(calls.length, 2)
  assert.equal(calls[1], 'other-provider', `expected a different provider, got ${calls.join(', ')}`)
})

test('a 413 payload rejection also rotates, because a smaller alias will not help', async () => {
  const { chunks, calls } = await run({
    models: [
      route({ modelId: 'big-alias', pin: 'groq/big-alias', bucket: 'groq:1', iqRank: 5 }),
      route({ modelId: 'roomy', pin: 'google/roomy', platform: 'google', bucket: 'google:3', iqRank: 30, contextWindow: 1_048_576 }),
    ],
    script: {
      'big-alias': [{ status: 413, code: 'PAYLOAD_TOO_LARGE', detail: 'payload too large' }],
      roomy: [{ frames: okFrames }],
    },
  })
  assert.equal(chunks.at(-1).reason.kind, 'stop')
  assert.deepEqual(calls, ['big-alias', 'roomy'])
})

test('every provider failing ends the turn with the last classified code', async () => {
  const { chunks, calls } = await run({
    models: [
      route({ modelId: 'a', pin: 'groq/a', bucket: 'groq:1' }),
      route({ modelId: 'b', pin: 'cerebras/b', platform: 'cerebras', bucket: 'cerebras:2' }),
    ],
    script: {
      a: [{ status: 429, code: 'RATE_LIMIT' }],
      b: [{ status: 503, code: 'SERVER_ERROR' }],
    },
  })
  assert.equal(calls.length, 2)
  const finish = chunks.at(-1)
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'SERVER_ERROR')
  assert.match(finish.reason.failure.message, /FreeLLMAPI could not serve this request/)
})

test('a stream cut after visible text is reported, not replayed on another provider', async () => {
  const inventory = fakeInventory([
    route({ modelId: 'flaky', pin: 'groq/flaky', bucket: 'groq:1' }),
    route({ modelId: 'healthy', pin: 'cerebras/healthy', platform: 'cerebras', bucket: 'cerebras:2' }),
  ])
  const calls = []
  const transport = {
    async open({ model }) {
      calls.push(model)
      if (model === 'flaky') {
        let stage = 0
        return {
          kind: 'sse',
          body: new ReadableStream({
            pull(controller) {
              if (stage === 0) {
                stage += 1
                controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"half"}}]}\n\n'))
                return
              }
              controller.error(new Error('ECONNRESET'))
            },
          }),
        }
      }
      const text = okFrames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n'
      return {
        kind: 'sse',
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(text))
            controller.close()
          },
        }),
      }
    },
  }
  const adapter = createAdapter({
    config: resolveConfig({ maxAttempts: 4 }),
    inventory,
    quotas: new QuotaRegistry({ config: resolveConfig({}), logger }),
    transport,
    telemetry: { noteRoutes() {}, noteSync() {}, recordTurn() {}, state: () => ({}) },
    logger,
  })
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'freellmapi-auto',
    model: 'auto',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  })) {
    chunks.push(chunk)
  }
  assert.deepEqual(calls, ['flaky'], 'must not retry after visible output')
  const finish = chunks.at(-1)
  assert.equal(finish.reason.kind, 'error')
  assert.ok(chunks.some((chunk) => chunk.type === 'block-end' && chunk.block.type === 'text' && chunk.block.text === 'half'))
})

test('a pinned model is routed exactly, and an unknown pin reports UNKNOWN_MODEL', async () => {
  const pinned = route({ modelId: 'exact', pin: 'groq/exact', bucket: 'groq:1' })
  const { chunks, calls } = await run({
    models: [pinned],
    script: { exact: [{ frames: okFrames }] },
    model: 'groq/exact',
  })
  assert.deepEqual(calls, ['exact'])
  assert.equal(chunks.at(-1).reason.kind, 'stop')

  const unknown = await run({
    models: [pinned],
    script: {},
    model: 'groq/missing',
  })
  assert.equal(unknown.chunks.at(-1).reason.failure.code, 'UNKNOWN_MODEL')
  assert.deepEqual(unknown.calls, [])
})

test('a tool-using request never reaches a route without tool calling', async () => {
  const { calls } = await run({
    models: [
      route({ modelId: 'no-tools', pin: 'groq/no-tools', bucket: 'groq:1', supportsTools: false, iqRank: 1 }),
      route({ modelId: 'tools', pin: 'cerebras/tools', platform: 'cerebras', bucket: 'cerebras:2', iqRank: 50 }),
    ],
    script: { tools: [{ frames: okFrames }] },
    tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object', properties: {} } }],
  })
  assert.deepEqual(calls, ['tools'])
})

test('the advertised catalog exposes one Auto model plus pinned routes', async () => {
  const { adapter } = await run({
    models: [
      route({ modelId: 'one', pin: 'groq/one', bucket: 'groq:1' }),
      route({ modelId: 'two', pin: 'cerebras/two', platform: 'cerebras', bucket: 'cerebras:2' }),
    ],
    script: {},
  })
  const models = await adapter.listModels('freellmapi-auto')
  assert.equal(models[0].id, 'auto')
  assert.equal(models[0].name, 'Auto (FreeLLMApi)')
  assert.deepEqual(models.slice(1).map((model) => model.id).sort(), ['cerebras/two', 'groq/one'])

  const resolved = await adapter.resolveModel('freellmapi-auto', 'auto')
  assert.ok(resolved.context.contextWindow > 0)
  assert.equal(resolved.provider, 'freellmapi-auto')

  const pinnedResolved = await adapter.resolveModel('freellmapi-auto', 'groq/one')
  assert.equal(pinnedResolved.name, 'Llama 3.3 70B')
  assert.equal(pinnedResolved.context.contextWindow, 131_072)
})

test('the harness retry policy is finite and covers post-output failures', () => {
  const policy = harnessRetryPolicy({ harnessMaxRetries: 2 })
  assert.equal(policy.mode, 'normal')
  assert.equal(policy.maxRetries, 2)
  assert.ok(policy.retryableCodes.includes('STREAM_STALLED'))
  assert.ok(policy.initialDelayMs > 0)
  assert.ok(policy.maxDelayMs >= policy.initialDelayMs)
  assert.equal(harnessRetryPolicy({}).maxRetries, 1)
})

test('every advertised entry satisfies the harness catalog contract', async () => {
  const { adapter } = await run({
    models: [
      route({ modelId: 'one', pin: 'groq/one', bucket: 'groq:1' }),
      route({ modelId: 'two', pin: 'cerebras/two', platform: 'cerebras', bucket: 'cerebras:2' }),
    ],
    script: {},
  })
  for (const provider of ['freellmapi-auto', 'freellmapi-large-context', 'freellmapi-fast', 'freellmapi-coding', 'freellmapi-models']) {
    const models = await adapter.listModels(provider)
    assert.ok(models.length > 0, provider)
    const seen = new Set()
    for (const model of models) {
      // The llm service rejects the whole provider when `provider` names the
      // wrong route, so this is the exact condition that broke the picker.
      assert.equal(model.provider, provider, `${provider}: ${model.id} names the wrong route`)
      assert.ok(model.id.length > 0)
      assert.ok(model.name.length > 0)
      assert.equal(seen.has(model.id), false, `${provider}: duplicate id ${model.id}`)
      seen.add(model.id)

      const resolved = await adapter.resolveModel(provider, model.id)
      assert.equal(resolved.provider, provider)
      assert.equal(resolved.id, model.id)
      assert.ok(Number.isInteger(resolved.context.contextWindow) && resolved.context.contextWindow > 0)
      assert.ok(Number.isSafeInteger(resolved.defaultMaxTokens) && resolved.defaultMaxTokens > 0)
    }
  }
})

test('fractional config values are normalized before they reach the catalog', async () => {
  const { adapter } = await run({
    models: [route({ modelId: 'one', pin: 'groq/one', bucket: 'groq:1' })],
    script: {},
    config: { defaultMaxOutputTokens: 8192.5, defaultContextWindow: 131072.7, autoContextWindow: 262144.2 },
  })
  const resolved = await adapter.resolveModel('freellmapi-auto', 'auto')
  assert.equal(Number.isInteger(resolved.context.contextWindow), true)
  assert.equal(Number.isSafeInteger(resolved.defaultMaxTokens), true)
  const pinned = await adapter.resolveModel('freellmapi-auto', 'groq/one')
  assert.equal(Number.isInteger(pinned.context.contextWindow), true)
})

test('provider metadata names the route', () => {
  const adapter = createAdapter({
    config: resolveConfig({}),
    inventory: fakeInventory([]),
    quotas: new QuotaRegistry({ config: resolveConfig({}), logger }),
    transport: fakeTransport({}),
    telemetry: { noteRoutes() {}, noteSync() {}, recordTurn() {}, state: () => ({}) },
    logger,
  })
  assert.deepEqual(adapter.providerInfo('freellmapi-fast'), { id: 'freellmapi-fast', name: 'FreeLLMApi - Ultra Fast' })
  assert.deepEqual(adapter.providerInfo('elsewhere'), { id: 'elsewhere', name: 'FreeLLMApi' })
})

test('a gateway that omits usage is still charged against its token window', async () => {
  const noUsage = [
    { choices: [{ delta: { content: 'x'.repeat(400) } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]
  const { quotas } = await run({
    models: [route({ modelId: 'quiet', pin: 'groq/quiet', bucket: 'groq:1' })],
    script: { quiet: [{ frames: noUsage }] },
  })
  const minuteTokens = quotas.snapshot().find((row) => row.bucket === 'groq:1')?.minuteTokens ?? 0
  assert.ok(minuteTokens >= 100, `expected an estimated charge, got ${String(minuteTokens)}`)
})

test('an attempt that failed before producing output is not charged tokens', async () => {
  const { quotas } = await run({
    models: [
      route({ modelId: 'throttled', pin: 'groq/throttled', bucket: 'groq:1' }),
      route({ modelId: 'fine', pin: 'cerebras/fine', platform: 'cerebras', bucket: 'cerebras:2' }),
    ],
    script: {
      throttled: [{ status: 429, code: 'RATE_LIMIT' }],
      fine: [{ frames: okFrames }],
    },
  })
  const throttled = quotas.snapshot().find((row) => row.bucket === 'groq:1')
  assert.equal(throttled?.minuteTokens ?? 0, 0)
  assert.ok((throttled?.minuteRequests ?? 0) >= 1)
})
