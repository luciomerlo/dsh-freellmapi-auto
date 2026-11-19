/**
 * Candidate ranking.
 *
 * The router never "picks the best model"; it orders the routes that could serve
 * this exact request and then tries them in order. Three filters run before any
 * scoring, because a route that cannot serve the request is not a cheaper option:
 * tool support, context capacity, and per-minute token budget.
 *
 * Scoring is a weighted sum of four signals — frontier capability, coding and
 * tool-calling strength, recent health, and latency — re-weighted per profile.
 * Small models are deliberately ranked last, and only reached by the degrade
 * step, so a 7B model never answers a coding turn while a 70B route is healthy.
 *
 * @module dsh-freellmapi-auto/ranking
 */

/** Route ids this plugin registers. */
export const ROUTE_IDS = Object.freeze([
  'freellmapi-auto',
  'freellmapi-large-context',
  'freellmapi-fast',
  'freellmapi-coding',
  'freellmapi-models',
])

/** Display names for the selector. */
export const ROUTE_NAMES = Object.freeze({
  'freellmapi-auto': 'FreeLLMApi - Auto',
  'freellmapi-large-context': 'FreeLLMApi - Large Context',
  'freellmapi-fast': 'FreeLLMApi - Ultra Fast',
  'freellmapi-coding': 'FreeLLMApi - Coding & Tools',
  'freellmapi-models': 'FreeLLMApi - Models',
})

/** Profile key behind each route id. */
export const ROUTE_PROFILES = Object.freeze({
  'freellmapi-auto': 'auto',
  'freellmapi-large-context': 'large-context',
  'freellmapi-fast': 'fast',
  'freellmapi-coding': 'coding',
  'freellmapi-models': 'auto',
})

/**
 * Per-profile filter and weight configuration.
 * @type {Record<string, {requiresTools: boolean, minContext: number, weights: Record<string, number>}>}
 */
export const PROFILES = Object.freeze({
  auto: {
    requiresTools: false,
    minContext: 0,
    weights: { capability: 0.35, coding: 0.35, health: 0.2, speed: 0.1, context: 0 },
  },
  'large-context': {
    requiresTools: false,
    minContext: 65_536,
    weights: { capability: 0.2, coding: 0.1, health: 0.15, speed: 0.05, context: 0.5 },
  },
  fast: {
    requiresTools: false,
    minContext: 0,
    weights: { capability: 0.1, coding: 0.05, health: 0.3, speed: 0.55, context: 0 },
  },
  coding: {
    requiresTools: true,
    minContext: 0,
    weights: { capability: 0.2, coding: 0.55, health: 0.2, speed: 0.05, context: 0 },
  },
})

/** Model families that behave well as coding and tool-calling agents. */
const FRONTIER_PATTERN = /(deepseek|qwen|kimi|k2|glm|claude|gpt-4|gpt-5|o3|o4|gemini-(?:2\.5|3)|mistral-large|codestral|llama-?(?:3\.3-70b|4)|nemotron|minimax|grok|command-a)/i

/** Model families that are fast but weak, used only by the degrade step. */
const SMALL_PATTERN = /(flash-lite|flash-lite|nano|mini|8b|7b|4b|3b|1b|0\.5b|0\.8b|tiny|small)/i

/**
 * Parse a parameter count from a model name.
 * @param {string} text - the model id and display name.
 * @returns {number | undefined} billions of parameters, when the name states them.
 */
export function paramsOf(text) {
  const match = /(?:^|[^0-9])(\d+(?:\.\d+)?)\s*b(?:[^a-z0-9]|$)/i.exec(text)
  if (match === null) return undefined
  const value = Number(match[1])
  return Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * Coding and tool-calling strength of one route, in [0, 1].
 * @param {any} model - the inventory model.
 * @returns {number} the signal.
 */
export function codingSignal(model) {
  const name = `${model.modelId} ${model.displayName}`
  const frontier = FRONTIER_PATTERN.test(name) ? 1 : 0
  const small = SMALL_PATTERN.test(name) ? 1 : 0
  const params = paramsOf(name)
  let size
  if (params === undefined) size = 0.6
  else if (params >= 70) size = 1
  else if (params >= 30) size = 0.85
  else if (params >= 14) size = 0.6
  else if (params >= 8) size = 0.35
  else size = 0.15
  const tools = model.supportsTools ? 1 : 0
  return Math.max(0, Math.min(1, 0.45 * frontier + 0.35 * size + 0.2 * tools - 0.15 * (1 - frontier) * small))
}

/**
 * Capability of one route in [0, 1] from the published intelligence rank.
 * @param {number} iqRank - rank where 1 is best.
 * @returns {number} the signal.
 */
export function capabilitySignal(iqRank) {
  if (!Number.isFinite(iqRank) || iqRank <= 0) return 0.5
  return Math.max(0, Math.min(1, 1 - (iqRank - 1) / 200))
}

/**
 * Speed of one route in [0, 1] from the published speed rank.
 * @param {number} speedRank - rank where 1 is fastest.
 * @returns {number} the signal.
 */
export function speedSignal(speedRank) {
  if (!Number.isFinite(speedRank) || speedRank <= 0) return 0.5
  return Math.max(0, Math.min(1, 1 - (speedRank - 1) / 200))
}

/**
 * Context headroom of one route in [0, 1].
 * @param {number} contextWindow - the route's capacity.
 * @returns {number} the signal.
 */
export function contextSignal(contextWindow) {
  if (!Number.isFinite(contextWindow) || contextWindow <= 8192) return 0
  const ratio = Math.log2(contextWindow / 8192) / Math.log2(1_048_576 / 8192)
  return Math.max(0, Math.min(1, ratio))
}

/**
 * Score one route for one profile.
 * @param {any} model - the inventory model.
 * @param {object} input - scoring inputs.
 * @param {string} input.profile - the profile key.
 * @param {{successRate: number, ttftMs: number}} input.health - bucket health.
 * @param {Record<string, any>} input.config - resolved plugin config.
 * @returns {number} the composite score.
 */
export function scoreRoute(model, { profile, health, config }) {
  const weights = PROFILES[profile]?.weights ?? PROFILES.auto.weights
  const context = model.contextWindow ?? Number(config.defaultContextWindow) ?? 131_072
  const capability = capabilitySignal(model.iqRank)
  const coding = codingSignal(model)
  const speed = speedSignal(model.speedRank)
  const contextScore = contextSignal(context)

  // A fast first token is worth more than a fast overall run: the watchdog and
  // the user both care about time-to-first-token.
  const speedHealth = health.ttftMs > 0 ? Math.max(0, 1 - health.ttftMs / 8000) : 0.5
  const healthScore = 0.75 * health.successRate + 0.25 * speedHealth

  const capabilityPart = (config.capabilityWeight ?? 1) * weights.capability * capability
  const codingPart = (config.codingWeight ?? 1) * weights.coding * coding
  const speedPart = (config.speedWeight ?? 1) * weights.speed * speed
  const healthPart = (config.healthWeight ?? 1) * weights.health * healthScore
  const contextPart = weights.context * contextScore

  return capabilityPart + codingPart + speedPart + healthPart + contextPart
}

/**
 * Order the routes that can serve one request.
 *
 * @param {object} input - ranking inputs.
 * @param {any} input.snapshot - the inventory snapshot.
 * @param {{tokens: number, needsTools: boolean, needsVision: boolean}} input.facts - request facts.
 * @param {string} input.profile - the profile key.
 * @param {import('./buckets.js').QuotaRegistry} input.quotas - quota state.
 * @param {Map<string, any>} input.quotaTable - reported provider quota.
 * @param {Record<string, any>} input.config - resolved plugin config.
 * @returns {{routes: object[], refused: Record<string, number>, degraded: boolean}} ordered routes.
 */
export function rankRoutes({ snapshot, facts, profile, quotas, quotaTable, config }) {
  const definition = PROFILES[profile] ?? PROFILES.auto
  const minContext = Math.max(definition.minContext, 0)
  /** @type {Record<string, number>} */
  const refused = {}

  /**
   * Apply the hard filters.
   * @param {{relaxTpm: boolean, relaxContext: boolean}} relax - which filters to skip.
   * @returns {any[]} the routes that pass.
   */
  const filter = (relax) => {
    const passing = []
    for (const model of snapshot.models) {
      const context = model.contextWindow ?? Number(config.defaultContextWindow) ?? 131_072
      if (facts.needsTools && !model.supportsTools) {
        refused.tools = (refused.tools ?? 0) + 1
        continue
      }
      if (definition.requiresTools && !model.supportsTools) {
        refused.tools = (refused.tools ?? 0) + 1
        continue
      }
      if (facts.needsVision && !model.supportsVision) {
        refused.vision = (refused.vision ?? 0) + 1
        continue
      }
      if (!relax.relaxContext && facts.tokens > context) {
        refused.context = (refused.context ?? 0) + 1
        continue
      }
      if (minContext > 0 && context < minContext) {
        refused.context = (refused.context ?? 0) + 1
        continue
      }
      if (!relax.relaxTpm && model.tpm !== null && facts.tokens > model.tpm) {
        refused.tpm = (refused.tpm ?? 0) + 1
        continue
      }
      const reason = quotas.refusal({
        model,
        facts,
        quotas: quotaTable,
        ignoreTokenBudget: relax.relaxTpm,
      })
      if (reason !== undefined) {
        refused[reason] = (refused[reason] ?? 0) + 1
        continue
      }
      passing.push(model)
    }
    return passing
  }

  let degraded = false
  let passing = filter({ relaxTpm: false, relaxContext: false })
  if (passing.length === 0) {
    // Nothing fits the strict budget: retry ignoring the per-minute token cap,
    // which is the filter most likely to be stale on a shared free account.
    degraded = true
    passing = filter({ relaxTpm: true, relaxContext: false })
  }
  if (passing.length === 0 && config.degradeToSmallModels !== false) {
    degraded = true
    passing = filter({ relaxTpm: true, relaxContext: true })
  }

  const scored = passing.map((model) => ({
    model,
    bucket: model.bucket,
    score: scoreRoute(model, { profile, health: quotas.health(model.bucket), config }),
  }))
  scored.sort((left, right) => right.score - left.score || left.model.iqRank - right.model.iqRank)

  return {
    routes: diversify(scored, Number(config.diversityWindow) || 0),
    refused,
    degraded,
  }
}

/**
 * Spread consecutive attempts across distinct physical providers.
 *
 * The highest-scoring route is still first: diversity reorders the tail so a
 * fast agent loop does not spend one provider's whole RPM on near-identical
 * aliases before its neighbour is ever tried.
 *
 * @param {Array<{model: any, bucket: string, score: number}>} ranked - scored routes, best first.
 * @param {number} window - how many previous picks a repeat must avoid.
 * @returns {Array<{model: any, bucket: string, score: number}>} the ordered routes.
 */
export function diversify(ranked, window) {
  if (window <= 0 || ranked.length <= 2) return ranked
  /** @type {Array<{model: any, bucket: string, score: number}>} */
  const picked = []
  /** @type {Array<{model: any, bucket: string, score: number}>} */
  const deferred = []
  for (const route of ranked) {
    const recent = picked.slice(-window).some((entry) => entry.bucket === route.bucket)
    if (recent) deferred.push(route)
    else picked.push(route)
  }
  return [...picked, ...deferred]
}

/**
 * The degrade candidate list used when every route failed a tool-support filter.
 * @param {any} snapshot - the inventory snapshot.
 * @param {import('./buckets.js').QuotaRegistry} quotas - quota state.
 * @param {Record<string, any>} config - resolved plugin config.
 * @returns {any[]} small, fast routes, best first.
 */
export function smallModelFallback(snapshot, quotas, config) {
  const candidates = snapshot.models.filter((model) => SMALL_PATTERN.test(`${model.modelId} ${model.displayName}`))
  const scored = candidates.map((model) => ({
    model,
    bucket: model.bucket,
    score: scoreRoute(model, { profile: 'fast', health: quotas.health(model.bucket), config }),
  }))
  scored.sort((left, right) => right.score - left.score)
  return scored
}
