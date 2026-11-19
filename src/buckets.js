/**
 * Shared-quota accounting.
 *
 * FreeLLMAPI's catalog lists many model aliases that sit behind one provider
 * account: every OpenRouter alias spends the same OpenRouter RPM, and every
 * Google alias spends the same AI Studio quota. Tracking limits per model would
 * therefore hammer a saturated account with "different" aliases, so all state
 * here — cooldown, request and token windows, health — is keyed by the physical
 * `(platform, key)` pair, which is what the store's `rate_limit_cooldowns` table
 * also does.
 *
 * The registry is process-local and in memory by design: it describes this
 * process's recent behaviour, and a restart legitimately starts from zero.
 *
 * @module dsh-freellmapi-auto/buckets
 */

/** Window lengths. */
export const MINUTE_MS = 60_000
export const DAY_MS = 24 * 60 * 60 * 1000

/**
 * In-memory quota, cooldown, and health state.
 */
export class QuotaRegistry {
  /**
   * @param {object} options - construction options.
   * @param {Record<string, any>} options.config - resolved plugin config.
   * @param {{info: Function, warn: Function, debug: Function}} options.logger - diagnostics sink.
   * @param {() => number} [options.now] - clock override for tests.
   */
  constructor({ config, logger, now = () => Date.now() }) {
    this.config = config
    this.logger = logger
    this.now = now
    /** @type {Map<string, any>} */
    this.buckets = new Map()
  }

  /**
   * The mutable state of one bucket, created on first use.
   * @param {string} bucket - `platform:keyId`.
   * @returns {any} the state.
   */
  state(bucket) {
    let state = this.buckets.get(bucket)
    if (state === undefined) {
      state = {
        bucket,
        requests: [],
        tokens: [],
        cooldownUntil: 0,
        cooldownCode: '',
        cooldownCount: 0,
        successEwma: 0.8,
        ttftEwma: 0,
        samples: 0,
        failures: 0,
        successes: 0,
        lastError: '',
        lastUsedAt: 0,
      }
      this.buckets.set(bucket, state)
    }
    return state
  }

  /**
   * Seed a bucket with usage another FreeLLMAPI client recorded very recently.
   * @param {string} bucket - `platform:keyId`.
   * @param {{requests?: number, tokens?: number}} usage - recorded usage.
   * @returns {void}
   */
  seed(bucket, usage) {
    const at = this.now()
    const state = this.state(bucket)
    for (let index = 0; index < (usage.requests ?? 0); index += 1) state.requests.push(at)
    if ((usage.tokens ?? 0) > 0) state.tokens.push({ at, tokens: usage.tokens })
  }

  /**
   * Drop samples that fell out of their window.
   * @param {any} state - one bucket state.
   * @param {number} now - the current time.
   * @returns {void}
   */
  prune(state, now) {
    const minuteFloor = now - MINUTE_MS
    const dayFloor = now - DAY_MS
    while (state.requests.length > 0 && state.requests[0] < dayFloor) state.requests.shift()
    while (state.tokens.length > 0 && state.tokens[0].at < dayFloor) state.tokens.shift()
    void minuteFloor
  }

  /**
   * Count requests and tokens inside one window.
   * @param {any} state - one bucket state.
   * @param {number} now - the current time.
   * @param {number} windowMs - the window length.
   * @returns {{requests: number, tokens: number}} usage inside the window.
   */
  usageWithin(state, now, windowMs) {
    const floor = now - windowMs
    let requests = 0
    for (const at of state.requests) {
      if (at >= floor) requests += 1
    }
    let tokens = 0
    for (const entry of state.tokens) {
      if (entry.at >= floor) tokens += entry.tokens
    }
    return { requests, tokens }
  }

  /**
   * Whether a bucket is cooling down.
   * @param {string} bucket - `platform:keyId`.
   * @param {number} [now] - the current time.
   * @returns {number} remaining cooldown in milliseconds; 0 when available.
   */
  cooldownRemaining(bucket, now = this.now()) {
    const state = this.buckets.get(bucket)
    if (state === undefined) return 0
    return Math.max(0, state.cooldownUntil - now)
  }

  /**
   * Put a bucket in cooldown.
   * @param {string} bucket - `platform:keyId`.
   * @param {number} ms - how long.
   * @param {string} code - why.
   * @returns {void}
   */
  cool(bucket, ms, code) {
    const state = this.state(bucket)
    const until = this.now() + Math.max(0, ms)
    if (until > state.cooldownUntil) {
      state.cooldownUntil = until
      state.cooldownCode = code
    }
    state.cooldownCount += 1
    state.failures += 1
    state.lastError = code
  }

  /**
   * Record that one request is being dispatched.
   * @param {string} bucket - `platform:keyId`.
   * @returns {void}
   */
  noteRequest(bucket) {
    const now = this.now()
    const state = this.state(bucket)
    state.requests.push(now)
    state.lastUsedAt = now
    this.prune(state, now)
  }

  /**
   * Record tokens one attempt actually spent.
   * @param {string} bucket - `platform:keyId`.
   * @param {number} tokens - total tokens reported or estimated.
   * @returns {void}
   */
  noteTokens(bucket, tokens) {
    if (!Number.isFinite(tokens) || tokens <= 0) return
    const now = this.now()
    const state = this.state(bucket)
    state.tokens.push({ at: now, tokens: Math.round(tokens) })
    this.prune(state, now)
  }

  /**
   * Update the health estimate after one attempt.
   * @param {string} bucket - `platform:keyId`.
   * @param {{ok: boolean, ttftMs?: number, code?: string}} outcome - the attempt outcome.
   * @returns {void}
   */
  outcome(bucket, { ok, ttftMs, code }) {
    const state = this.state(bucket)
    const alpha = 0.3
    state.samples += 1
    state.successEwma = state.successEwma * (1 - alpha) + (ok ? 1 : 0) * alpha
    if (ok) {
      state.successes += 1
      if (typeof ttftMs === 'number' && ttftMs > 0) {
        state.ttftEwma = state.ttftEwma === 0 ? ttftMs : state.ttftEwma * (1 - alpha) + ttftMs * alpha
      }
    } else {
      state.failures += 1
      state.lastError = code ?? 'UNKNOWN'
    }
  }

  /**
   * The health snapshot ranking reads.
   * @param {string} bucket - `platform:keyId`.
   * @returns {{successRate: number, ttftMs: number, samples: number}} health facts.
   */
  health(bucket) {
    const state = this.buckets.get(bucket)
    if (state === undefined) return { successRate: 0.8, ttftMs: 0, samples: 0 }
    return { successRate: state.successEwma, ttftMs: state.ttftEwma, samples: state.samples }
  }

  /**
   * Whether one model may be attempted right now.
   *
   * Every refusal names a reason so the status surface can explain why a route
   * that is present in the catalog was not used.
   *
   * @param {object} input - the check.
   * @param {any} input.model - the inventory model.
   * @param {{tokens: number, needsTools: boolean, needsVision: boolean}} input.facts - request facts.
   * @param {Map<string, {limit: number | null, remaining: number | null, resetAt: string | null}>} input.quotas - reported quota.
   * @param {boolean} [input.ignoreTokenBudget] - skip the token-window checks, for the degrade step.
   * @returns {string | undefined} the refusal reason, or undefined when the route is usable.
   */
  refusal({ model, facts, quotas, ignoreTokenBudget = false }) {
    const now = this.now()
    if (this.cooldownRemaining(model.bucket, now) > 0) return 'cooldown'

    const state = this.state(model.bucket)
    this.prune(state, now)
    const minute = this.usageWithin(state, now, MINUTE_MS)
    const day = this.usageWithin(state, now, DAY_MS)

    if (model.rpm !== null && minute.requests + 1 > model.rpm) return 'rpm'
    if (model.rpd !== null && day.requests + 1 > model.rpd) return 'rpd'
    if (!ignoreTokenBudget && model.tpm !== null && minute.tokens + facts.tokens > model.tpm) return 'tpm'
    if (!ignoreTokenBudget && model.tpd !== null && day.tokens + facts.tokens > model.tpd) return 'tpd'

    if (this.config.respectReportedQuota !== false) {
      const reported = quotas.get(`${model.platform}:${model.keyId ?? 0}:requests`)
      if (reported !== undefined && reported.remaining !== null && reported.remaining <= 0) {
        const resetAt = reported.resetAt === null ? Number.NaN : Date.parse(reported.resetAt)
        if (!Number.isFinite(resetAt) || resetAt > now) return 'quota'
      }
      const tokensQuota = quotas.get(`${model.platform}:${model.keyId ?? 0}:tokens`)
      if (!ignoreTokenBudget && tokensQuota !== undefined && tokensQuota.remaining !== null && tokensQuota.remaining < facts.tokens) {
        const resetAt = tokensQuota.resetAt === null ? Number.NaN : Date.parse(tokensQuota.resetAt)
        if (!Number.isFinite(resetAt) || resetAt > now) return 'quota'
      }
    }

    return undefined
  }

  /**
   * A detached view of every bucket for the status surface.
   * @returns {object[]} bucket snapshots, most recently used first.
   */
  snapshot() {
    const now = this.now()
    const rows = []
    for (const state of this.buckets.values()) {
      if (state.samples === 0 && state.requests.length === 0 && state.cooldownUntil === 0) continue
      const minute = this.usageWithin(state, now, MINUTE_MS)
      rows.push({
        bucket: state.bucket,
        coolingMs: Math.max(0, state.cooldownUntil - now),
        cooldownCode: state.cooldownCode,
        minuteRequests: minute.requests,
        minuteTokens: minute.tokens,
        successRate: Number(state.successEwma.toFixed(3)),
        ttftMs: Math.round(state.ttftEwma),
        samples: state.samples,
        failures: state.failures,
        lastError: state.lastError,
      })
    }
    rows.sort((left, right) => right.coolingMs - left.coolingMs || left.bucket.localeCompare(right.bucket))
    return rows
  }
}

/**
 * Convert a provider hint or a code into a cooldown duration.
 * @param {string} code - the failure code.
 * @param {number | undefined} providerHintMs - provider-requested delay.
 * @param {Record<string, any>} config - resolved plugin config.
 * @returns {number} cooldown in milliseconds.
 */
export function cooldownFor(code, providerHintMs, config) {
  const base = Number(config.cooldownBaseMs) || 20_000
  const max = Number(config.cooldownMaxMs) || 15 * 60_000
  const table = {
    RATE_LIMIT: base,
    TPM_EXCEEDED: base * 2,
    PAYLOAD_TOO_LARGE: base,
    QUOTA: max,
    AUTH: max,
    CONTEXT_WINDOW: base,
    SERVER_ERROR: base / 2,
    TIMEOUT: base,
    TRANSPORT: base,
    STREAM_STALLED: base / 2,
    EMPTY_RESPONSE: base / 4,
    PROVIDER_ERROR: base / 2,
  }
  const suggested = providerHintMs !== undefined && providerHintMs > 0 ? providerHintMs : (table[code] ?? base / 2)
  return Math.min(max, Math.max(1000, suggested))
}
