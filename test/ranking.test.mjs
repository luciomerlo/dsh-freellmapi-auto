import assert from 'node:assert/strict'
import test from 'node:test'

import { QuotaRegistry } from '../src/buckets.js'
import {
  PROFILES,
  capabilitySignal,
  codingSignal,
  contextSignal,
  diversify,
  paramsOf,
  rankRoutes,
  scoreRoute,
  smallModelFallback,
  speedSignal,
} from '../src/ranking.js'

const logger = { info() {}, warn() {}, debug() {} }

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

function registry() {
  return new QuotaRegistry({
    config: { cooldownBaseMs: 20_000, cooldownMaxMs: 900_000, respectReportedQuota: true },
    logger,
  })
}

test('parameter counts are read from model names', () => {
  assert.equal(paramsOf('llama-3.3-70b-versatile'), 70)
  assert.equal(paramsOf('Qwen3 Coder 30B A3B'), 30)
  assert.equal(paramsOf('gemini-2.5-flash'), undefined)
  assert.equal(paramsOf('glm-4-32b-0414'), 32)
})

test('signals stay inside [0, 1]', () => {
  assert.equal(capabilitySignal(1), 1)
  assert.ok(capabilitySignal(500) >= 0)
  assert.equal(speedSignal(1), 1)
  assert.equal(contextSignal(8192), 0)
  assert.ok(contextSignal(1_048_576) <= 1)
  assert.ok(codingSignal(route()) > codingSignal(route({ modelId: 'llama-3.2-1b', displayName: 'Llama 3.2 1B' })))
  assert.ok(codingSignal(route({ supportsTools: false })) < codingSignal(route()))
})

test('a tool-using request excludes routes without tool calling', () => {
  const quotas = registry()
  const snapshot = {
    models: [
      route({ modelId: 'no-tools', supportsTools: false, bucket: 'groq:1', pin: 'groq/no-tools' }),
      route({ modelId: 'tools', bucket: 'cerebras:2', platform: 'cerebras', pin: 'cerebras/tools' }),
    ],
  }
  const { routes } = rankRoutes({
    snapshot,
    facts: { tokens: 100, needsTools: true, needsVision: false },
    profile: 'auto',
    quotas,
    quotaTable: new Map(),
    config: {},
  })
  assert.equal(routes.length, 1)
  assert.equal(routes[0].model.modelId, 'tools')
})

test('context and TPM filters drop routes that cannot hold the request', () => {
  const quotas = registry()
  const snapshot = {
    models: [
      route({ modelId: 'tiny-context', contextWindow: 8192, bucket: 'groq:1' }),
      route({ modelId: 'small-tpm', tpm: 1000, bucket: 'cerebras:2', platform: 'cerebras' }),
      route({ modelId: 'roomy', contextWindow: 262_144, tpm: 500_000, bucket: 'nvidia:3', platform: 'nvidia' }),
    ],
  }
  const { routes, refused } = rankRoutes({
    snapshot,
    facts: { tokens: 20_000, needsTools: false, needsVision: false },
    profile: 'auto',
    quotas,
    quotaTable: new Map(),
    config: {},
  })
  assert.deepEqual(routes.map((entry) => entry.model.modelId), ['roomy'])
  assert.ok(refused.context >= 1)
  assert.ok(refused.tpm >= 1)
})

test('a cooling bucket is skipped, and a different provider still serves', () => {
  const quotas = registry()
  quotas.cool('groq:1', 60_000, 'RATE_LIMIT')
  const snapshot = {
    models: [
      route({ modelId: 'groq-model', bucket: 'groq:1' }),
      route({ modelId: 'cerebras-model', platform: 'cerebras', bucket: 'cerebras:2', iqRank: 40 }),
    ],
  }
  const { routes } = rankRoutes({
    snapshot,
    facts: { tokens: 100, needsTools: false, needsVision: false },
    profile: 'auto',
    quotas,
    quotaTable: new Map(),
    config: {},
  })
  assert.deepEqual(routes.map((entry) => entry.model.modelId), ['cerebras-model'])
})

test('the coding profile requires tool calling', () => {
  assert.equal(PROFILES.coding.requiresTools, true)
  const snapshot = {
    models: [
      route({ modelId: 'chat-only', supportsTools: false }),
      route({ modelId: 'coder', platform: 'cerebras', bucket: 'cerebras:2' }),
    ],
  }
  const { routes } = rankRoutes({
    snapshot,
    facts: { tokens: 100, needsTools: false, needsVision: false },
    profile: 'coding',
    quotas: registry(),
    quotaTable: new Map(),
    config: {},
  })
  assert.deepEqual(routes.map((entry) => entry.model.modelId), ['coder'])
})

test('the degrade step retries without the token-per-minute filter', () => {
  const snapshot = {
    models: [route({ modelId: 'only', tpm: 100, contextWindow: 4096 })],
  }
  const strict = rankRoutes({
    snapshot,
    facts: { tokens: 5000, needsTools: false, needsVision: false },
    profile: 'auto',
    quotas: registry(),
    quotaTable: new Map(),
    config: { degradeToSmallModels: false },
  })
  assert.equal(strict.routes.length, 0)
  assert.equal(strict.degraded, true)

  const relaxed = rankRoutes({
    snapshot,
    facts: { tokens: 5000, needsTools: false, needsVision: false },
    profile: 'auto',
    quotas: registry(),
    quotaTable: new Map(),
    config: { degradeToSmallModels: true },
  })
  assert.equal(relaxed.routes.length, 1)
  assert.equal(relaxed.degraded, true)
})

test('diversity spreads consecutive picks across providers', () => {
  const ranked = [
    { model: { modelId: 'a' }, bucket: 'groq:1', score: 10 },
    { model: { modelId: 'b' }, bucket: 'groq:1', score: 9 },
    { model: { modelId: 'c' }, bucket: 'groq:1', score: 8 },
    { model: { modelId: 'd' }, bucket: 'cerebras:2', score: 7 },
  ]
  const ordered = diversify(ranked, 2).map((entry) => entry.model.modelId)
  assert.equal(ordered[0], 'a')
  assert.equal(ordered[1], 'd')
  assert.deepEqual(ordered.slice(2), ['b', 'c'])
  assert.deepEqual(diversify(ranked, 0), ranked)
})

test('the small-model fallback prefers fast, small routes', () => {
  const snapshot = {
    models: [
      route({ modelId: 'llama-3.1-8b', displayName: 'Llama 3.1 8B', speedRank: 2, iqRank: 90, bucket: 'groq:1' }),
      route({ modelId: 'qwen2.5-7b', displayName: 'Qwen2.5 7B', speedRank: 5, iqRank: 95, bucket: 'cerebras:2', platform: 'cerebras' }),
      route({ modelId: 'llama-3.3-70b', displayName: 'Llama 3.3 70B', bucket: 'nvidia:3', platform: 'nvidia' }),
    ],
  }
  const fallback = smallModelFallback(snapshot, registry(), {})
  assert.equal(fallback.length, 2)
  assert.deepEqual(
    fallback.map((entry) => entry.model.modelId).sort(),
    ['llama-3.1-8b', 'qwen2.5-7b'],
  )
})

test('score prefers a healthier bucket over a nominally stronger one', () => {
  const quotas = registry()
  const strong = route({ modelId: 'strong', iqRank: 2, bucket: 'groq:1' })
  const weaker = route({ modelId: 'weaker', iqRank: 30, bucket: 'cerebras:2', platform: 'cerebras' })
  for (let index = 0; index < 20; index += 1) quotas.outcome('groq:1', { ok: false, code: 'RATE_LIMIT' })
  for (let index = 0; index < 20; index += 1) quotas.outcome('cerebras:2', { ok: true, ttftMs: 300 })
  const config = { codingWeight: 1, healthWeight: 3, speedWeight: 1, capabilityWeight: 1 }
  const strongScore = scoreRoute(strong, { profile: 'auto', health: quotas.health('groq:1'), config })
  const weakerScore = scoreRoute(weaker, { profile: 'auto', health: quotas.health('cerebras:2'), config })
  assert.ok(weakerScore > strongScore, `${String(weakerScore)} > ${String(strongScore)}`)
})
