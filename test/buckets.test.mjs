import assert from 'node:assert/strict'
import test from 'node:test'

import { MINUTE_MS, QuotaRegistry, cooldownFor } from '../src/buckets.js'

function registry(config = {}) {
  let now = 1_700_000_000_000
  const instance = new QuotaRegistry({
    config: { cooldownBaseMs: 20_000, cooldownMaxMs: 900_000, respectReportedQuota: true, ...config },
    logger: { info() {}, warn() {}, debug() {} },
    now: () => now,
  })
  return {
    instance,
    advance(ms) {
      now += ms
    },
    now() {
      return now
    },
  }
}

function model(overrides = {}) {
  return {
    platform: 'groq',
    modelId: 'llama-3.3-70b',
    pin: 'groq/llama-3.3-70b',
    bucket: 'groq:1',
    keyId: 1,
    rpm: null,
    rpd: null,
    tpm: null,
    tpd: null,
    contextWindow: 131_072,
    supportsTools: true,
    supportsVision: false,
    ...overrides,
  }
}

const facts = { tokens: 1000, needsTools: false, needsVision: false }

test('a request that would exceed RPM is refused until the window slides', () => {
  const clock = registry()
  const route = model({ rpm: 2 })
  assert.equal(clock.instance.refusal({ model: route, facts, quotas: new Map() }), undefined)
  clock.instance.noteRequest(route.bucket)
  assert.equal(clock.instance.refusal({ model: route, facts, quotas: new Map() }), undefined)
  clock.instance.noteRequest(route.bucket)
  assert.equal(clock.instance.refusal({ model: route, facts, quotas: new Map() }), 'rpm')
  clock.advance(MINUTE_MS + 1)
  assert.equal(clock.instance.refusal({ model: route, facts, quotas: new Map() }), undefined)
})

test('a request larger than the per-minute token budget is refused', () => {
  const clock = registry()
  const route = model({ tpm: 5000 })
  clock.instance.noteRequest(route.bucket)
  clock.instance.noteTokens(route.bucket, 4500)
  assert.equal(clock.instance.refusal({ model: route, facts: { ...facts, tokens: 3000 }, quotas: new Map() }), 'tpm')
  clock.advance(MINUTE_MS + 1)
  assert.equal(clock.instance.refusal({ model: route, facts: { ...facts, tokens: 3000 }, quotas: new Map() }), undefined)
})

test('cooldown is shared by the bucket, not the model', () => {
  const clock = registry()
  const first = model({ modelId: 'alias-a' })
  const second = model({ modelId: 'alias-b' })
  clock.instance.cool(first.bucket, 30_000, 'RATE_LIMIT')
  assert.equal(clock.instance.refusal({ model: second, facts, quotas: new Map() }), 'cooldown')
  assert.equal(clock.instance.cooldownRemaining(second.bucket), 30_000)
  clock.advance(30_001)
  assert.equal(clock.instance.refusal({ model: second, facts, quotas: new Map() }), undefined)
})

test('reported remaining quota blocks a bucket until it resets', () => {
  const clock = registry()
  const route = model()
  const resetAt = new Date(clock.now() + 60_000).toISOString()
  const quotas = new Map([['groq:1:requests', { limit: 1000, remaining: 0, resetAt }]])
  assert.equal(clock.instance.refusal({ model: route, facts, quotas }), 'quota')

  const past = new Date(clock.now() - 60_000).toISOString()
  const expired = new Map([['groq:1:requests', { limit: 1000, remaining: 0, resetAt: past }]])
  assert.equal(clock.instance.refusal({ model: route, facts, quotas: expired }), undefined)
})

test('health converges toward observed outcomes', () => {
  const clock = registry()
  const route = model()
  for (let index = 0; index < 10; index += 1) clock.instance.outcome(route.bucket, { ok: false, code: 'RATE_LIMIT' })
  assert.ok(clock.instance.health(route.bucket).successRate < 0.2)
  for (let index = 0; index < 30; index += 1) {
    clock.instance.outcome(route.bucket, { ok: true, ttftMs: 400 })
  }
  const health = clock.instance.health(route.bucket)
  assert.ok(health.successRate > 0.9, String(health.successRate))
  assert.equal(health.ttftMs, 400)
})

test('cooldown durations respect provider hints and the configured ceiling', () => {
  const config = { cooldownBaseMs: 20_000, cooldownMaxMs: 60_000 }
  assert.equal(cooldownFor('RATE_LIMIT', undefined, config), 20_000)
  assert.equal(cooldownFor('RATE_LIMIT', 45_000, config), 45_000)
  assert.equal(cooldownFor('RATE_LIMIT', 10_000_000, config), 60_000)
  assert.equal(cooldownFor('QUOTA', undefined, config), 60_000)
  assert.ok(cooldownFor('EMPTY_RESPONSE', undefined, config) >= 1000)
})

test('the snapshot hides unused buckets and reports live ones', () => {
  const clock = registry()
  const route = model()
  clock.instance.noteRequest(route.bucket)
  clock.instance.cool(route.bucket, 5000, 'RATE_LIMIT')
  const rows = clock.instance.snapshot()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].bucket, 'groq:1')
  assert.equal(rows[0].coolingMs, 5000)
  assert.equal(rows[0].cooldownCode, 'RATE_LIMIT')
  assert.equal(rows[0].minuteRequests, 1)
})

test('seeded usage counts toward the current minute window', () => {
  const clock = registry()
  const route = model({ rpm: 1 })
  clock.instance.seed(route.bucket, { requests: 1, tokens: 0 })
  assert.equal(clock.instance.refusal({ model: route, facts, quotas: new Map() }), 'rpm')
})
