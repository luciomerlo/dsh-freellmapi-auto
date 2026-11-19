/**
 * The `llm`-service adapter.
 *
 * This object is a duck-typed implementation of the harness `LlmAdapter`
 * contract: the service validates a registered adapter through `providerInfo`
 * and `providerRetryPolicy`, so a plain object satisfies it and the plugin stays
 * loadable from a profile install without resolving any harness package.
 *
 * The adapter owns one strategy question: for the route and model the user
 * selected, which physical `(platform, key, model)` triples should serve this
 * request, and in what order? Everything below the strategy — quota windows,
 * cooldowns, ranking, HTTP, SSE — lives in its own module.
 *
 * Failover is transparent only while nothing has been shown to the user. Once a
 * text block is on screen the answer cannot be replayed against another provider,
 * so a failure there ends the attempt with a classified error and lets the
 * harness retry the whole step on a different route.
 *
 * @module dsh-freellmapi-auto/adapter
 */

import { QuotaRegistry, cooldownFor } from './buckets.js'
import { platformLabel } from './endpoints.js'
import { failureFacts } from './errors.js'
import { buildChatBody } from './payload.js'
import {
  ROUTE_IDS,
  ROUTE_NAMES,
  ROUTE_PROFILES,
  rankRoutes,
  scoreRoute,
  smallModelFallback,
} from './ranking.js'
import { completionToChunks, toStreamChunks } from './stream.js'
import { requestFacts } from './tokens.js'

/** Model id of the virtual routing model on every profile route. */
export const AUTO_ID = 'auto'

/** Chunk types that put something a user can see on screen. */
const VISIBLE_CHUNKS = new Set([
  'block-start',
  'text-delta',
  'reasoning-delta',
  'tool-call-delta',
  'block-end',
])

/**
 * The retry policy handed to the harness.
 *
 * Internal failover already covers a handful of provider attempts, so harness
 * retries exist for the one case the adapter cannot solve: a stream that broke
 * after visible output. One retry is enough to reach a different provider
 * without looping on a systemic failure.
 *
 * @param {Record<string, any>} config - resolved plugin config.
 * @returns {object} a resolved normal retry policy.
 */
export function harnessRetryPolicy(config) {
  return {
    mode: 'normal',
    maxRetries: Number.isInteger(config.harnessMaxRetries) ? config.harnessMaxRetries : 1,
    retryableCodes: ['STREAM_STALLED', 'TIMEOUT', 'TRANSPORT', 'RATE_LIMIT', 'EMPTY_RESPONSE', 'SERVER_ERROR'],
    initialDelayMs: 500,
    maxDelayMs: 4000,
    jitterRatio: 0.2,
  }
}

/**
 * @typedef {object} AdapterParts
 * @property {Record<string, any>} config - resolved plugin config.
 * @property {import('./inventory.js').Inventory} inventory - the FreeLLMAPI store.
 * @property {import('./buckets.js').QuotaRegistry} quotas - quota and cooldown state.
 * @property {import('./transport.js').HttpTransport} transport - provider HTTP.
 * @property {import('./telemetry.js').Telemetry} telemetry - status surface.
 * @property {{info: Function, warn: Function, debug: Function}} logger - diagnostics sink.
 * @property {{estimateMessage?: (message: any) => number} | undefined} [tokenMeter] - harness estimator.
 */

/**
 * Build the adapter registered for this plugin's routes.
 * @param {AdapterParts} parts - shared collaborators.
 * @returns {object} the duck-typed adapter.
 */
export function createAdapter(parts) {
  const { config, inventory, quotas, transport, telemetry, logger } = parts
  const tokenMeter = parts.tokenMeter

  /**
   * Estimated size and requirements of one request.
   * @param {any} options - harness request.
   * @returns {{tokens: number, needsTools: boolean, needsVision: boolean}} request facts.
   */
  function factsOf(options) {
    return requestFacts(options, {
      charsPerToken: Number(config.tokensPerCharacter) || 0.25,
      toolTokenOverhead: Number(config.toolTokenOverhead) || 12,
      margin: Number(config.requestTokenMargin) || 0,
      tokenMeter,
    })
  }

  /**
   * The pinned routes a profile group advertises, best first.
   *
   * The selector is a capability list, not an availability list: a route in
   * cooldown still belongs in the catalog, or a stored selection would vanish
   * mid-conversation. Availability is enforced at dispatch time instead.
   *
   * @param {string} profile - the profile key.
   * @param {number} limit - how many routes to list.
   * @returns {any[]} inventory models.
   */
  function pinsFor(profile, limit) {
    const snapshot = inventory.snapshot
    const seen = new Set()
    const scored = []
    for (const model of snapshot.models) {
      if (profile === 'coding' && !model.supportsTools) continue
      if (seen.has(model.pin)) continue
      seen.add(model.pin)
      scored.push({
        model,
        score: scoreRoute(model, { profile, health: quotas.health(model.bucket), config }),
      })
    }
    scored.sort((left, right) => right.score - left.score || left.model.iqRank - right.model.iqRank)
    return scored.slice(0, limit).map((entry) => entry.model)
  }

  /**
   * Catalog entry for one pinned route.
   *
   * The `provider` field must name the route that owns the entry, not the route
   * it points at: the `llm` service rejects the whole catalog otherwise.
   *
   * @param {any} model - the inventory model.
   * @param {string} provider - the harness route id this entry belongs to.
   * @returns {object} the `LlmModelInfo`.
   */
  function pinnedInfo(model, provider) {
    const platform = platformLabel(model.platform)
    const context = model.contextWindow === null
      ? 'context unknown'
      : `${String(Math.round(model.contextWindow / 1024))}K context`
    return {
      provider,
      id: model.pin,
      name: model.displayName,
      description: `${platform} · ${context}${model.supportsTools ? ' · tools' : ' · no tools'}`,
      inputModalities: ['text'],
      badge: { text: platform, tone: 'neutral' },
    }
  }

  /**
   * Display name of one route group's virtual model.
   * @param {string} route - harness route id.
   * @returns {string} the name.
   */
  function autoName(route) {
    if (route === 'freellmapi-auto') return String(config.autoModelName)
    if (route === 'freellmapi-large-context') return 'Auto · Large context'
    if (route === 'freellmapi-fast') return 'Auto · Ultra fast'
    if (route === 'freellmapi-coding') return 'Auto · Coding & tools'
    return 'Auto (FreeLLMApi)'
  }

  /**
   * Resolve the widest capacity the current inventory can plausibly serve.
   * @returns {number} a context window in tokens.
   */
  function autoContextWindow() {
    const configured = Math.trunc(Number(config.autoContextWindow) || 131_072)
    let widest = 0
    for (const model of inventory.snapshot.models) {
      if (model.supportsTools && model.contextWindow !== null) widest = Math.max(widest, model.contextWindow)
    }
    if (widest === 0) return configured
    return Math.max(32_768, Math.min(configured, Math.trunc(widest)))
  }

  /**
   * The output cap one route advertises.
   * @returns {number} a positive safe integer.
   */
  function defaultMaxTokens() {
    const configured = Math.trunc(Number(config.defaultMaxOutputTokens) || 8_192)
    return configured > 0 ? configured : 8_192
  }

  /**
   * Publish the route summary the status surface shows.
   * @returns {void}
   */
  function publishRoutes() {
    if (typeof telemetry?.noteRoutes !== 'function') return
    telemetry.noteRoutes(ROUTE_IDS.map((route) => ({
      id: route,
      name: ROUTE_NAMES[route],
      models: route === 'freellmapi-models'
        ? pinsFor('auto', Number(config.modelsRouteSize) || 48).length + 1
        : pinsFor(ROUTE_PROFILES[route] ?? 'auto', Number(config.pinsPerRoute) || 4).length + 1,
    })))
  }

  /**
   * Record one attempt outcome against its bucket.
   * @param {any} model - the route that was attempted.
   * @param {object} input - outcome facts.
   * @param {boolean} input.ok - whether it produced an answer.
   * @param {number} [input.ttftMs] - time to first token.
   * @param {string} [input.code] - terminal failure code.
   * @param {number} [input.providerHintMs] - provider-requested delay.
   * @returns {void}
   */
  function recordOutcome(model, { ok, ttftMs, code, providerHintMs }) {
    quotas.outcome(model.bucket, { ok, ttftMs, code })
    if (ok) return
    const cooldown = cooldownFor(code ?? 'TRANSPORT', providerHintMs, config)
    quotas.cool(model.bucket, cooldown, code ?? 'TRANSPORT')
    if (config.syncOnQuotaError !== false && (code === 'QUOTA' || code === 'RATE_LIMIT' || code === 'TPM_EXCEEDED')) {
      inventory.refreshIfStale('quota error')
    }
  }

  /**
   * Build the per-attempt HTTP body.
   * @param {any} options - harness request.
   * @param {any} model - the route.
   * @returns {Record<string, unknown>} the JSON body.
   */
  function bodyFor(options, model) {
    const configuredMax = Number(model.defaultMaxTokens) > 0 ? Number(model.defaultMaxTokens) : undefined
    const maxTokens = Number.isFinite(options.maxTokens) && options.maxTokens > 0
      ? options.maxTokens
      : configuredMax ?? (Number(config.defaultMaxOutputTokens) || undefined)
    return buildChatBody({
      request: options,
      model: model.modelId,
      maxTokens,
      temperature: options.temperature,
      includeUsage: config.includeUsage === true,
    })
  }

  /**
   * Track one attempt's chunks, suppressing a terminal error chunk until the
   * caller decides whether it can still fail over.
   * @param {AsyncIterable<object>} chunks - the attempt's chunk stream.
   * @param {any} state - mutable attempt state.
   * @returns {AsyncGenerator<object>} the chunks safe to forward.
   */
  async function* track(chunks, state) {
    for await (const chunk of chunks) {
      if (chunk.type === 'finish') {
        const failure = chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted'
        if (failure) {
          state.failure = chunk.reason.failure
          if (!state.visible) continue
        }
        state.finish = chunk.reason
        yield chunk
        continue
      }
      if (chunk.type === 'usage') {
        state.usage = chunk.usage
        yield chunk
        continue
      }
      if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
        state.outputChars += chunk.text.length
      } else if (chunk.type === 'tool-call-delta') {
        state.outputChars += chunk.argumentsDelta.length
      }
      if (VISIBLE_CHUNKS.has(chunk.type)) {
        if (!state.visible) state.ttftMs = Date.now() - state.startedAt
        state.visible = true
      }
      yield chunk
    }
  }

  /**
   * Stream one call: plan, attempt, fail over, then report.
   * @param {any} options - harness request.
   * @returns {AsyncGenerator<object>} harness chunks.
   */
  async function* stream(options) {
    const startedAt = Date.now()
    const route = options.provider
    const profile = ROUTE_PROFILES[route] ?? 'auto'
    const facts = factsOf(options)
    const snapshot = inventory.snapshot
    inventory.refreshIfStale('request')
    publishRoutes()

    /** @type {Array<{model: any, bucket: string, score: number}>} */
    let plan = []
    /** @type {Record<string, number>} */
    let refused = {}
    let degraded = false

    if (options.model === AUTO_ID) {
      const ranked = rankRoutes({
        snapshot: inventory.snapshot,
        facts,
        profile,
        quotas,
        quotaTable: inventory.snapshot.quotas,
        config,
      })
      refused = ranked.refused
      degraded = ranked.degraded
      plan = ranked.routes.slice(0, Math.max(1, Number(config.maxAttempts) || 6))
      if (plan.length === 0 && config.degradeToSmallModels !== false) {
        plan = smallModelFallback(inventory.snapshot, quotas, config).slice(0, 2)
        degraded = true
      }
    } else {
      const pinned = inventory.modelByPin(options.model)
      if (pinned === undefined) {
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: {
              message: `FreeLLMAPI does not currently advertise the route "${options.model}"; pick another model from FreeLLMApi - Models`,
              code: 'UNKNOWN_MODEL',
            },
          },
        }
        return
      }
      plan = [{ model: pinned, bucket: pinned.bucket, score: 1 }]
    }

    if (plan.length === 0) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: exhaustedMessage('no route can serve this request', refused, snapshot),
            code: 'NO_MODEL_AVAILABLE',
          },
        },
      }
      telemetry.recordTurn({
        route,
        model: options.model,
        served: null,
        attempts: 0,
        estTokens: facts.tokens,
        tpm: null,
        contextWindow: null,
        ttftMs: 0,
        totalMs: Date.now() - startedAt,
        ok: false,
        errorCode: 'NO_MODEL_AVAILABLE',
        degraded,
        refused,
      })
      return
    }

    let attempts = 0
    /** @type {any} */
    let lastFailure

    for (let index = 0; index < plan.length; index += 1) {
      const model = plan[index].model
      if (options.signal?.aborted === true) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'the request was cancelled', code: 'ABORTED' } } }
        return
      }

      const target = inventory.targetFor(model)
      if (target === undefined) {
        lastFailure = { message: `${model.pin}: the credential for this route is unreadable`, code: 'NO_CREDENTIAL' }
        continue
      }

      attempts += 1
      quotas.noteRequest(target.bucket)
      const state = {
        startedAt: Date.now(),
        visible: false,
        ttftMs: 0,
        outputChars: 0,
        finish: undefined,
        failure: undefined,
        usage: undefined,
      }

      try {
        // Time-to-first-token is a property of one provider attempt, not of the
        // turn: a slow first route must not starve the route that follows it.
        const firstTokenBudget = Math.max(1500, Number(config.firstTokenTimeoutMs) || 7000)
        const opened = await transport.open({
          target,
          model: model.modelId,
          body: bodyFor(options, model),
          signal: options.signal,
          connectTimeoutMs: firstTokenBudget,
        })
        try {
          const chunks = opened.kind === 'sse'
            ? toStreamChunks(opened.body, model.modelId, options.signal, {
              idleTimeoutMs: Number(config.streamIdleTimeoutMs) || 12_000,
              firstTokenTimeoutMs: firstTokenBudget,
            })
            : completionToChunks(opened.payload, model.modelId)
          for await (const chunk of track(chunks, state)) {
            yield chunk
          }
        } finally {
          // Release the transport's whole-attempt deadline once this attempt is
          // over, so its timer never outlives the request it guards.
          opened.release?.()
        }
      } catch (error) {
        state.failure = failureFacts(error, options.signal)
      }

      // Charge the bucket for what this attempt spent. Most free gateways omit
      // usage, so the estimate stands in: the request size plus what streamed
      // back. Without it the TPM window would stay empty and never throttle.
      if (state.visible || state.usage !== undefined) {
        const spent = state.usage === undefined
          ? facts.tokens + Math.ceil(state.outputChars * (Number(config.tokensPerCharacter) || 0.25))
          : state.usage.totalTokens ?? ((state.usage.inputTokens ?? 0) + (state.usage.outputTokens ?? 0))
        quotas.noteTokens(target.bucket, spent)
      }

      const ok = state.finish !== undefined
        && (state.finish.kind === 'stop' || state.finish.kind === 'tool-calls' || state.finish.kind === 'max-tokens')

      if (ok) {
        recordOutcome(model, { ok: true, ttftMs: state.ttftMs })
        telemetry.recordTurn({
          route,
          model: options.model,
          served: { platform: model.platform, modelId: model.modelId, bucket: target.bucket },
          attempts,
          estTokens: facts.tokens,
          tpm: model.tpm,
          contextWindow: model.contextWindow,
          ttftMs: state.ttftMs,
          totalMs: Date.now() - startedAt,
          ok: true,
          degraded,
          refused,
        })
        logger.debug(
          `freellmapi: served ${route}/${options.model} via ${model.platform} -> ${model.modelId} `
          + `(${String(facts.tokens)} est. tokens, ${String(state.ttftMs)}ms to first token)`,
        )
        return
      }

      if (options.signal?.aborted === true) {
        quotas.outcome(target.bucket, { ok: false, code: 'ABORTED' })
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'the request was cancelled', code: 'ABORTED' } } }
        return
      }

      const failure = state.failure ?? {
        message: `${model.modelId}: the stream ended without a terminal chunk`,
        code: 'STREAM_CLOSED',
      }
      lastFailure = failure
      recordOutcome(model, {
        ok: false,
        code: failure.code,
        providerHintMs: failure.providerRetryAfterMs,
      })

      if (state.visible) {
        // Output is already on screen; another provider cannot continue it.
        telemetry.recordTurn({
          route,
          model: options.model,
          served: { platform: model.platform, modelId: model.modelId, bucket: target.bucket },
          attempts,
          estTokens: facts.tokens,
          tpm: model.tpm,
          contextWindow: model.contextWindow,
          ttftMs: state.ttftMs,
          totalMs: Date.now() - startedAt,
          ok: false,
          errorCode: failure.code,
          degraded,
          refused,
        })
        yield { type: 'finish', reason: { kind: 'error', failure } }
        return
      }

      const next = plan[index + 1]
      logger.warn(
        `freellmapi: ${model.platform} -> ${model.modelId} failed (${failure.code}); `
        + `${next === undefined ? 'no route left' : `switching to ${next.model.platform} -> ${next.model.modelId}`}`,
      )
      if (next === undefined) {
        const terminal = { ...failure, message: exhaustedMessage(failure.message, refused, snapshot) }
        telemetry.recordTurn({
          route,
          model: options.model,
          served: { platform: model.platform, modelId: model.modelId, bucket: target.bucket },
          attempts,
          estTokens: facts.tokens,
          tpm: model.tpm,
          contextWindow: model.contextWindow,
          ttftMs: state.ttftMs,
          totalMs: Date.now() - startedAt,
          ok: false,
          errorCode: failure.code,
          degraded,
          refused,
        })
        yield { type: 'finish', reason: { kind: 'error', failure: terminal } }
        return
      }
    }

    const terminal = lastFailure ?? { message: 'every FreeLLMAPI route failed', code: 'PROVIDER_ERROR' }
    telemetry.recordTurn({
      route,
      model: options.model,
      served: null,
      attempts,
      estTokens: facts.tokens,
      tpm: null,
      contextWindow: null,
      ttftMs: 0,
      totalMs: Date.now() - startedAt,
      ok: false,
      errorCode: terminal.code,
      degraded,
      refused,
    })
    yield { type: 'finish', reason: { kind: 'error', failure: terminal } }
  }

  const adapter = {
    /**
     * @param {string} provider - the route this adapter owns.
     * @returns {{id: string, name: string}} provider metadata.
     */
    providerInfo(provider) {
      if (!ROUTE_IDS.includes(provider)) return { id: provider, name: 'FreeLLMApi' }
      return { id: provider, name: ROUTE_NAMES[provider] }
    },

    /**
     * @returns {object} the retry policy the harness should apply.
     */
    providerRetryPolicy() {
      return harnessRetryPolicy(config)
    },

    /**
     * @param {string} _provider - the route.
     * @param {string} _model - the model id.
     * @param {{width: number, height: number, bytes: number}} image - the normalized image.
     * @returns {{width: number, height: number, maxBytes: number}} the request projection.
     */
    imageRequestTarget(_provider, _model, image) {
      return { width: image.width, height: image.height, maxBytes: image.bytes }
    },

    /**
     * Advertise the virtual routing model plus this profile's best pinned routes.
     * @param {string} provider - the route this adapter owns.
     * @returns {Promise<object[]>} the selector catalog.
     */
    async listModels(provider) {
      if (!ROUTE_IDS.includes(provider)) return []
      inventory.refreshIfStale('catalog')
      const profile = ROUTE_PROFILES[provider] ?? 'auto'
      const limit = provider === 'freellmapi-models'
        ? Number(config.modelsRouteSize) || 48
        : Number(config.pinsPerRoute) || 4
      const pins = pinsFor(profile, limit)
        .filter((model) => model.pin !== AUTO_ID)
        .map((model) => pinnedInfo(model, provider))
      if (provider === 'freellmapi-models') return pins
      return [
        {
          provider,
          id: AUTO_ID,
          name: autoName(provider),
          description: 'Context- and TPM-aware routing across every healthy free route, with silent failover.',
          inputModalities: ['text'],
          badge: { text: 'Smart router', tone: 'info' },
        },
        ...pins,
      ]
    },

    /**
     * Describe one exact model route.
     * @param {string} provider - the route.
     * @param {string} modelId - the model id.
     * @returns {Promise<object>} resolved metadata.
     */
    async resolveModel(provider, modelId) {
      if (modelId === AUTO_ID) {
        return {
          provider,
          id: AUTO_ID,
          name: autoName(provider),
          context: { contextWindow: autoContextWindow() },
          defaultMaxTokens: defaultMaxTokens(),
          inputModalities: ['text'],
        }
      }
      const fallbackContext = Math.max(1, Math.trunc(Number(config.defaultContextWindow) || 131_072))
      const model = inventory.modelByPin(modelId)
      if (model === undefined) {
        return {
          provider,
          id: modelId,
          name: modelId,
          context: { contextWindow: fallbackContext },
          defaultMaxTokens: defaultMaxTokens(),
          inputModalities: ['text'],
        }
      }
      const contextWindow = model.contextWindow === null
        ? fallbackContext
        : Math.max(1, Math.trunc(model.contextWindow))
      return {
        provider,
        id: modelId,
        name: model.displayName,
        context: { contextWindow },
        defaultMaxTokens: defaultMaxTokens(),
        inputModalities: ['text'],
      }
    },

    /**
     * Bind resolution and dispatch to one generation.
     * @param {string} provider - the route.
     * @param {string} modelId - the model id.
     * @param {AbortSignal} [signal] - cancellation.
     * @returns {Promise<{model: object, stream: (options: object) => AsyncIterable<object>}>} the prepared call.
     */
    async prepareCall(provider, modelId, signal) {
      const model = await adapter.resolveModel(provider, modelId, signal)
      return { model, stream: (options) => adapter.stream(options) }
    },

    /**
     * Stream one model call.
     * @param {any} options - the harness request.
     * @returns {AsyncGenerator<object>} harness chunks.
     */
    stream(options) {
      return stream(options)
    },

    /**
     * Read live routing state for the status surface.
     * @returns {object} a detached snapshot.
     */
    state() {
      return telemetry.state({ buckets: quotas.snapshot() })
    },

    /**
     * Republish the route summary after the inventory changed.
     * @returns {void}
     */
    refreshRoutes() {
      publishRoutes()
    },
  }

  publishRoutes()
  return adapter
}

/**
 * Compose the terminal message of an exhausted plan.
 * @param {string} detail - the last failure message.
 * @param {Record<string, number>} refused - filter refusal counts.
 * @param {any} snapshot - the inventory snapshot.
 * @returns {string} the message.
 */
export function exhaustedMessage(detail, refused, snapshot) {
  const obstacles = Object.entries(refused)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${String(count)} ${reason}`)
  const inventoryNote = snapshot.available
    ? `${String(snapshot.models.length)} reachable route(s)`
    : 'the FreeLLMAPI store is not readable'
  const filters = obstacles.length === 0 ? '' : `; filtered out: ${obstacles.join(', ')}`
  return `FreeLLMAPI could not serve this request: ${detail}. ${inventoryNote}${filters}`
}

export { QuotaRegistry }
