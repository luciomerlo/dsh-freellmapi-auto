/**
 * Adapter for the FreeLLMAPI proxy transport.
 *
 * In this mode the plugin owns no routing policy: it resolves one endpoint, sends
 * `model: "auto"`, and streams what comes back. The FreeLLMAPI app chooses the
 * upstream free route, applies its own per-provider quirks, and rotates on
 * failure. The plugin keeps only what a client must keep — a first-token
 * deadline, a stall guard, and a classified failure.
 *
 * @module dsh-freellmapi-auto/proxy-adapter
 */

import { failureFacts } from './errors.js'
import { buildChatBody } from './payload.js'
import {
  candidatePorts,
  detectProxy,
  probeProxy,
  proxyBaseUrl,
  storeConfigPort,
} from './proxy.js'
import { toStreamChunks, completionToChunks } from './stream.js'

/** The single route this transport registers. */
export const PROXY_ROUTE = 'freellmapi-auto'

/** The model id that asks FreeLLMAPI to choose a route. */
export const PROXY_AUTO_ID = 'auto'

/**
 * @typedef {object} ProxyAdapterParts
 * @property {Record<string, any>} config - resolved plugin config.
 * @property {import('./inventory.js').Inventory} inventory - the FreeLLMAPI store.
 * @property {import('./transport.js').HttpTransport} transport - local HTTP.
 * @property {import('./telemetry.js').Telemetry} telemetry - status surface.
 * @property {{info: Function, warn: Function, debug: Function}} logger - diagnostics sink.
 */

/**
 * Build the proxy adapter.
 * @param {ProxyAdapterParts} parts - shared collaborators.
 * @returns {object} the duck-typed adapter.
 */
export function createProxyAdapter(parts) {
  const { config, inventory, transport, telemetry, logger } = parts

  /** @type {{host: string, port: number, apiKey: string, reachable: boolean, models: number, checkedAt: number} | undefined} */
  let resolved
  /** @type {Promise<any> | undefined} */
  let resolving

  /**
   * Resolve the proxy endpoint once per process generation, probing when the
   * profile names no port.
   * @param {boolean} [force] - ignore the cached answer.
   * @returns {Promise<{host: string, port: number, apiKey: string, reachable: boolean, models: number, checkedAt: number}>} the endpoint.
   */
  async function endpoint(force = false) {
    if (!force && resolved !== undefined) return resolved
    if (!force && resolving !== undefined) return resolving
    resolving = (async () => {
      const apiKey = inventory.unifiedKey() ?? ''
      const host = String(config.proxyHost)
      const configured = Number(config.proxyPort) || 0
      const storePort = storeConfigPort(inventory.dataDir)
      if (configured > 0) {
        const probe = await probeProxy({ host, port: configured, apiKey })
        resolved = { host, port: configured, apiKey, reachable: probe.ok, models: probe.models, checkedAt: Date.now() }
        return resolved
      }
      const detected = await detectProxy({
        host,
        candidates: candidatePorts({ configured, storePort }),
        apiKey,
      })
      resolved = detected.found === undefined
        ? { host, port: 0, apiKey, reachable: false, models: 0, checkedAt: Date.now() }
        : { host, port: detected.found.port, apiKey, reachable: true, models: detected.found.models, checkedAt: Date.now() }
      if (resolved.reachable) logger.info(`freellmapi: proxy detected on ${host}:${String(resolved.port)}`)
      return resolved
    })()
    return resolving
  }

  /**
   * Stream one turn through the proxy.
   * @param {any} options - the harness request.
   * @returns {AsyncGenerator<object>} harness chunks.
   */
  async function* stream(options) {
    const started = Date.now()
    const endpointState = await endpoint()
    if (!endpointState.reachable || endpointState.port === 0) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: 'FreeLLMAPI proxy is not reachable; start the app, or open Settings and set the port',
            code: 'PROXY_UNREACHABLE',
          },
        },
      }
      return
    }

    const target = {
      baseUrl: proxyBaseUrl(endpointState.host, endpointState.port),
      auth: 'bearer',
      apiKey: endpointState.apiKey,
      bucket: `proxy:${String(endpointState.port)}`,
    }
    const maxTokens = Number.isFinite(options.maxTokens) && options.maxTokens > 0
      ? options.maxTokens
      : Math.trunc(Number(config.defaultMaxOutputTokens) || 8_192)

    const state = { visible: false, ttftMs: 0, startedAt: Date.now(), failure: undefined, finish: undefined }
    try {
      const opened = await transport.open({
        target,
        model: PROXY_AUTO_ID,
        body: buildChatBody({
          request: options,
          model: PROXY_AUTO_ID,
          maxTokens,
          temperature: options.temperature,
          includeUsage: config.includeUsage === true,
        }),
        signal: options.signal,
        connectTimeoutMs: Math.max(1500, Number(config.firstTokenTimeoutMs) || 7_000),
      })
      try {
        const chunks = opened.kind === 'sse'
          ? toStreamChunks(opened.body, PROXY_AUTO_ID, options.signal, {
            idleTimeoutMs: Number(config.streamIdleTimeoutMs) || 12_000,
            firstTokenTimeoutMs: Math.max(1500, Number(config.firstTokenTimeoutMs) || 7_000),
          })
          : completionToChunks(opened.payload, PROXY_AUTO_ID)
        for await (const chunk of chunks) {
          if (chunk.type === 'finish') {
            state.finish = chunk.reason
            if (chunk.reason.kind === 'error') {
              state.failure = chunk.reason.failure
              if (!state.visible) break
            }
            yield chunk
            continue
          }
          if (chunk.type !== 'usage' && !state.visible) {
            state.visible = true
            state.ttftMs = Date.now() - state.startedAt
          }
          yield chunk
        }
      } finally {
        opened.release?.()
      }
    } catch (error) {
      state.failure = failureFacts(error, options.signal)
    }

    const ok = state.finish !== undefined
      && (state.finish.kind === 'stop' || state.finish.kind === 'tool-calls' || state.finish.kind === 'max-tokens')

    telemetry.recordTurn({
      route: PROXY_ROUTE,
      model: options.model,
      served: { platform: 'freellmapi-proxy', modelId: `auto:${String(endpointState.port)}`, bucket: target.bucket },
      attempts: 1,
      estTokens: 0,
      tpm: null,
      contextWindow: null,
      ttftMs: state.ttftMs,
      totalMs: Date.now() - started,
      ok,
      errorCode: state.failure?.code ?? '',
      degraded: false,
      refused: {},
    })

    if (state.failure !== undefined && !state.visible) {
      yield { type: 'finish', reason: { kind: 'error', failure: state.failure } }
    }
  }

  const adapter = {
    /**
     * @param {string} provider - the route this adapter owns.
     * @returns {{id: string, name: string}} provider metadata.
     */
    providerInfo(provider) {
      return { id: provider, name: 'FreeLLMApi (proxy)' }
    },

    /**
     * @returns {object} the retry policy the harness should apply.
     */
    providerRetryPolicy() {
      return {
        mode: 'normal',
        maxRetries: Number.isInteger(config.harnessMaxRetries) ? Math.min(1, config.harnessMaxRetries) : 0,
        retryableCodes: ['TIMEOUT', 'TRANSPORT'],
        initialDelayMs: 800,
        maxDelayMs: 4000,
        jitterRatio: 0.2,
      }
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
     * The proxy owns route selection, so it advertises one virtual model.
     * @returns {Promise<object[]>} the selector catalog.
     */
    async listModels() {
      const endpointState = await endpoint()
      return [{
        provider: PROXY_ROUTE,
        id: PROXY_AUTO_ID,
        name: 'Auto (FreeLLMApi proxy)',
        description: endpointState.reachable
          ? `Routed by the FreeLLMAPI app on port ${String(endpointState.port)} (${String(endpointState.models)} models published).`
          : 'Routed by the FreeLLMAPI app; it is not reachable yet, so set its port in Settings.',
        inputModalities: ['text'],
        badge: { text: endpointState.reachable ? 'Proxy' : 'Offline', tone: endpointState.reachable ? 'info' : 'warning' },
      }]
    },

    /**
     * @param {string} provider - the route.
     * @param {string} modelId - the model id.
     * @returns {Promise<object>} resolved metadata.
     */
    async resolveModel(provider, modelId) {
      return {
        provider,
        id: modelId,
        name: modelId === PROXY_AUTO_ID ? 'Auto (FreeLLMApi proxy)' : modelId,
        context: { contextWindow: Math.trunc(Number(config.autoContextWindow) || 131_072) },
        defaultMaxTokens: Math.trunc(Number(config.defaultMaxOutputTokens) || 8_192),
        inputModalities: ['text'],
      }
    },

    /**
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
     * @param {any} options - the harness request.
     * @returns {AsyncGenerator<object>} harness chunks.
     */
    stream(options) {
      return stream(options)
    },

    /**
     * Re-probe the proxy and republish the catalog entry.
     * @returns {Promise<object>} the endpoint state.
     */
    async refreshEndpoint() {
      const state = await endpoint(true)
      return state
    },

    /**
     * @returns {object} the endpoint state without probing.
     */
    proxyState() {
      return resolved ?? { host: String(config.proxyHost), port: 0, reachable: false, models: 0, checkedAt: 0 }
    },

    /**
     * Read live state for the status surface.
     * @returns {object} a detached snapshot.
     */
    state() {
      return {
        ...telemetry.state({ buckets: [] }),
        transport: 'proxy',
        proxy: adapter.proxyState(),
      }
    },
  }

  return adapter
}
