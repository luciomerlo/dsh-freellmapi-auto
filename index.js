/**
 * FreeLLMAPI Auto: a multi-provider free-model router for DeepSeek Harness.
 *
 * The plugin registers five `llm` routes — four routing profiles and one listing
 * of the individual upstream routes — and serves every request from the
 * FreeLLMAPI inventory this machine already holds. It talks to the upstream
 * providers directly, inside this process, and never reads or writes the global
 * `ANTHROPIC_*` style environment variables other tools depend on.
 *
 * The plugin imports nothing from `@deepseek-ai/*`: the `llm` service validates an
 * adapter through `providerInfo`/`providerRetryPolicy`, so a plain object
 * satisfies the contract and the bundle cannot bind to the wrong harness build.
 *
 * @module dsh-freellmapi-auto
 */

import { createAdapter } from './src/adapter.js'
import { QuotaRegistry } from './src/buckets.js'
import { PLUGIN_VERSION } from './src/identity.js'
import { Inventory } from './src/inventory.js'
import { resolveDataDir } from './src/paths.js'
import { createProxyAdapter, PROXY_ROUTE } from './src/proxy-adapter.js'
import {
  candidatePorts,
  detectProxy,
  normalizeProxyHost,
  probeProxy,
  storeConfigPort,
} from './src/proxy.js'
import { ROUTE_IDS } from './src/ranking.js'
import { Telemetry } from './src/telemetry.js'
import { HttpTransport } from './src/transport.js'

export const name = 'freellmapi-auto'
export const inject = ['llm']

/** HTTP paths this plugin owns. */
export const STATUS_PATH = '/freellmapi-auto/status'
export const SYNC_PATH = '/freellmapi-auto/sync'
export const SETTINGS_PATH = '/freellmapi-auto/settings'
export const DETECT_PATH = '/freellmapi-auto/detect'

/** Default configuration; every key is overridable from the profile patch. */
const DEFAULTS = Object.freeze({
  dataDir: '',
  syncOnStart: true,
  syncOnQuotaError: true,
  minSyncIntervalMs: 30_000,

  // Transport: 'direct' calls each provider with the store's own key;
  // 'proxy' sends one request to the FreeLLMAPI app and lets it route.
  transport: 'direct',
  proxyHost: '127.0.0.1',
  // 0 means "detect": the app's config.json port, then the usual ports.
  proxyPort: 0,

  autoModelName: 'Auto (FreeLLMApi)',
  maxAttempts: 6,
  harnessMaxRetries: 1,
  requestTimeoutMs: 180_000,
  firstTokenTimeoutMs: 7_000,
  streamIdleTimeoutMs: 12_000,

  tokensPerCharacter: 0.25,
  toolTokenOverhead: 12,
  requestTokenMargin: 512,
  defaultContextWindow: 131_072,
  autoContextWindow: 131_072,
  defaultMaxOutputTokens: 8_192,

  codingWeight: 1,
  healthWeight: 1,
  speedWeight: 1,
  capabilityWeight: 1,
  diversityWindow: 2,
  degradeToSmallModels: true,

  respectReportedQuota: true,
  seedUsageWindowMs: 60_000,
  includeUsage: false,
  cooldownBaseMs: 20_000,
  cooldownMaxMs: 900_000,

  pinsPerRoute: 4,
  modelsRouteSize: 48,
  endpoints: {},
})

/**
 * Merge the row config over the defaults and reject what cannot work.
 * @param {Record<string, unknown> | undefined} input - the loader row config.
 * @returns {Record<string, any>} the resolved config.
 */
export function resolveConfig(input) {
  const config = { ...DEFAULTS, ...(input ?? {}) }
  /** @type {string[]} */
  const errors = []
  const positive = (key) => {
    if (!Number.isFinite(config[key]) || config[key] <= 0) errors.push(`${key} must be a positive number`)
  }
  const integer = (key, minimum) => {
    if (!Number.isInteger(config[key]) || config[key] < minimum) {
      errors.push(`${key} must be an integer >= ${String(minimum)}`)
    }
  }

  if (typeof config.dataDir !== 'string') errors.push('dataDir must be a string')
  if (typeof config.autoModelName !== 'string' || config.autoModelName.trim() === '') {
    errors.push('autoModelName must be non-empty')
  }
  if (config.transport !== 'direct' && config.transport !== 'proxy') {
    errors.push('transport must be "direct" or "proxy"')
  }
  if (typeof config.proxyHost !== 'string' || normalizeProxyHost(config.proxyHost) === '') {
    errors.push('proxyHost must be a host name or an absolute URL')
  }
  if (!Number.isInteger(config.proxyPort) || config.proxyPort < 0 || config.proxyPort > 65_535) {
    errors.push('proxyPort must be an integer in [0, 65535], where 0 means autodetect')
  }
  for (const key of ['requestTimeoutMs', 'firstTokenTimeoutMs', 'streamIdleTimeoutMs', 'minSyncIntervalMs']) positive(key)
  for (const key of ['tokensPerCharacter', 'requestTokenMargin', 'defaultContextWindow', 'autoContextWindow', 'defaultMaxOutputTokens', 'cooldownBaseMs', 'cooldownMaxMs']) positive(key)
  if (!(config.tokensPerCharacter > 0 && config.tokensPerCharacter <= 1)) {
    errors.push('tokensPerCharacter must be in (0, 1]')
  }
  integer('maxAttempts', 1)
  integer('harnessMaxRetries', 0)
  integer('diversityWindow', 0)
  integer('pinsPerRoute', 0)
  integer('modelsRouteSize', 0)
  integer('seedUsageWindowMs', 0)
  if (config.endpoints === null || typeof config.endpoints !== 'object' || Array.isArray(config.endpoints)) {
    errors.push('endpoints must be a mapping of platform id to { baseUrl, auth }')
  }
  if (errors.length > 0) throw new Error(`freellmapi-auto: invalid config — ${errors.join('; ')}`)
  return config
}

/**
 * Mount the FreeLLMAPI router.
 * @param {any} ctx - the plugin context.
 * @param {Record<string, unknown>} [input] - the loader row config.
 * @returns {void}
 */
export function apply(ctx, input) {
  const config = resolveConfig(input)
  const logger = {
    info: (...args) => ctx.logger?.info?.(...args),
    warn: (...args) => ctx.logger?.warn?.(...args),
    debug: (...args) => ctx.logger?.debug?.(...args),
  }

  const inventory = new Inventory({ config, logger })
  const quotas = new QuotaRegistry({ config, logger })
  const telemetry = new Telemetry()
  const transport = new HttpTransport({ config, logger })
  const tokenMeter = ctx.get?.('tokenMeter')
  const usingProxy = config.transport === 'proxy'
  const adapter = usingProxy
    ? createProxyAdapter({ config, inventory, transport, telemetry, logger })
    : createAdapter({ config, inventory, quotas, transport, telemetry, logger, tokenMeter })
  const routes = usingProxy ? [PROXY_ROUTE] : [...ROUTE_IDS]

  const registration = ctx.llm.registerAdapter(routes, adapter)
  if (registration === undefined || typeof registration !== 'function') {
    throw new Error('freellmapi-auto: the llm service refused the adapter registration')
  }

  /**
   * Read the store, seed the quota windows once, and publish the result.
   * @param {string} reason - why the read ran.
   * @returns {boolean} whether a usable store was read.
   */
  function syncInventory(reason) {
    const available = inventory.sync(reason)
    const snapshot = inventory.snapshot
    for (const [bucket, usage] of snapshot.seeded) {
      // Seeding is only meaningful while the process has no own samples yet.
      if (!quotas.buckets.has(bucket)) quotas.seed(bucket, usage)
    }
    telemetry.noteSync({
      reason,
      available,
      models: snapshot.models.length,
      dbPath: snapshot.dbPath,
      warnings: snapshot.warnings,
    })
    for (const warning of snapshot.warnings) logger.warn(`freellmapi: ${warning}`)
    if (typeof adapter.refreshRoutes === 'function') adapter.refreshRoutes()
    return available
  }

  /**
   * Answer one JSON request.
   * @param {any} res - the server response.
   * @param {number} status - HTTP status.
   * @param {unknown} payload - JSON body.
   * @returns {void}
   */
  function sendJson(res, status, payload) {
    const body = JSON.stringify(payload)
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.setHeader('content-length', String(Buffer.byteLength(body)))
    res.end(body)
  }

  /**
   * Read a small JSON request body.
   * @param {any} req - the incoming request.
   * @param {number} [limit] - largest accepted body.
   * @returns {Promise<Record<string, unknown>>} the parsed body.
   */
  async function readJsonBody(req, limit = 16_384) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > limit) throw new Error('request body is too large')
      chunks.push(chunk)
    }
    const text = Buffer.concat(chunks).toString('utf8').trim()
    if (text === '') return {}
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('request body must be a JSON object')
    }
    return parsed
  }

  /** Last proxy probe, so a settings page cannot turn into a port scanner. */
  let probeCache = { at: 0, value: undefined }

  /**
   * Probe the local FreeLLMAPI proxy, reusing a recent answer.
   * @param {boolean} [force] - probe again instead of reusing the cache.
   * @returns {Promise<Record<string, unknown>>} the proxy state.
   */
  async function proxyState(force = false) {
    if (!force && probeCache.value !== undefined && Date.now() - probeCache.at < 10_000) {
      return probeCache.value
    }
    const host = normalizeProxyHost(config.proxyHost)
    const apiKey = inventory.unifiedKey() ?? ''
    const configured = Number(config.proxyPort) || 0
    const detected = await detectProxy({
      host,
      candidates: candidatePorts({ configured, storePort: storeConfigPort(inventory.dataDir) }),
      apiKey,
    })
    const value = detected.found === undefined
      ? {
        found: false,
        host,
        port: 0,
        models: 0,
        checkedAt: Date.now(),
        tried: detected.tried.map((entry) => ({ port: entry.port, ok: entry.ok, detail: entry.detail })),
      }
      : {
        found: true,
        host: detected.found.host,
        port: detected.found.port,
        models: detected.found.models,
        checkedAt: Date.now(),
        tried: detected.tried.map((entry) => ({ port: entry.port, ok: entry.ok, detail: entry.detail })),
      }
    probeCache = { at: Date.now(), value }
    return value
  }

  ctx.effect(() => {
    const disposers = []
    const webServer = ctx.get?.('webServer')

    if (webServer !== undefined) {
      disposers.push(webServer.register({
        kind: 'exact',
        path: STATUS_PATH,
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          try {
            sendJson(res, 200, { ok: true, version: PLUGIN_VERSION, ...adapter.state() })
          } catch (error) {
            sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        },
      }))
      disposers.push(webServer.register({
        kind: 'exact',
        path: SYNC_PATH,
        handler: (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          try {
            const available = syncInventory('manual request')
            sendJson(res, 200, { ok: true, available, ...adapter.state() })
          } catch (error) {
            sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        },
      }))
      disposers.push(webServer.register({
        kind: 'exact',
        path: SETTINGS_PATH,
        handler: async (req, res) => {
          try {
            if (req.method === 'GET' || req.method === 'HEAD') {
              const store = inventory.snapshot
              sendJson(res, 200, {
                ok: true,
                version: PLUGIN_VERSION,
                transport: config.transport,
                proxyHost: config.proxyHost,
                proxyPort: config.proxyPort,
                routes: config.transport === 'proxy' ? [PROXY_ROUTE] : [...ROUTE_IDS],
                store: {
                  dbPath: store.dbPath,
                  available: store.available,
                  models: store.models.length,
                  warnings: store.warnings,
                },
                proxy: await proxyState(),
                probePorts: candidatePorts({
                  configured: Number(config.proxyPort) || 0,
                  storePort: storeConfigPort(inventory.dataDir),
                }),
                canSave: ctx.get?.('configEditor') !== undefined && ctx.fiber?.entry !== undefined,
              })
              return
            }
            if (req.method !== 'PUT') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }

            const body = await readJsonBody(req)
            const transportMode = body.transport
            const host = normalizeProxyHost(body.proxyHost)
            const port = Number(body.proxyPort)
            if (transportMode !== 'direct' && transportMode !== 'proxy') {
              sendJson(res, 400, { ok: false, error: 'transport must be "direct" or "proxy"' })
              return
            }
            if (host === '') {
              sendJson(res, 400, { ok: false, error: 'proxyHost must be a host name' })
              return
            }
            if (!Number.isInteger(port) || port < 0 || port > 65_535) {
              sendJson(res, 400, { ok: false, error: 'proxyPort must be an integer in [0, 65535]' })
              return
            }

            const editor = ctx.get?.('configEditor')
            const entry = ctx.fiber?.entry
            if (editor === undefined || entry === undefined) {
              sendJson(res, 409, {
                ok: false,
                error: 'this profile cannot save plugin configuration; edit the row in cordis.patch.yml instead',
              })
              return
            }
            await editor.edit(entry, (current) => ({ ...current, transport: transportMode, proxyHost: host, proxyPort: port }))
            sendJson(res, 200, {
              ok: true,
              saved: { transport: transportMode, proxyHost: host, proxyPort: port },
              // Editing an ordinary field restarts the plugin so `apply` rebuilds state.
              restartRequired: true,
            })
          } catch (error) {
            sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        },
      }))
      disposers.push(webServer.register({
        kind: 'exact',
        path: DETECT_PATH,
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          try {
            const body = await readJsonBody(req)
            const host = normalizeProxyHost(body.proxyHost ?? config.proxyHost)
            const requested = Number(body.proxyPort)
            if (host === '') {
              sendJson(res, 400, { ok: false, error: 'proxyHost must be a host name' })
              return
            }
            if (Number.isInteger(requested) && requested > 0) {
              if (requested > 65_535) {
                sendJson(res, 400, { ok: false, error: 'proxyPort must be at most 65535' })
                return
              }
              const probe = await probeProxy({ host, port: requested, apiKey: inventory.unifiedKey() ?? '' })
              const value = {
                found: probe.ok,
                host,
                port: probe.ok ? requested : 0,
                models: probe.models,
                checkedAt: Date.now(),
                tried: [{ port: requested, ok: probe.ok, detail: probe.detail }],
              }
              if (probe.ok) probeCache = { at: Date.now(), value }
              sendJson(res, 200, { ok: true, proxy: value })
              return
            }
            const value = await proxyState(true)
            if (typeof adapter.refreshEndpoint === 'function') {
              await adapter.refreshEndpoint().catch(() => {})
            }
            sendJson(res, 200, { ok: true, proxy: value })
          } catch (error) {
            sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        },
      }))
    }

    if (config.syncOnStart !== false) syncInventory('startup')
    else syncInventory('lazy')

    const snapshot = inventory.snapshot
    const platforms = new Set(snapshot.models.map((model) => model.platform))
    if (snapshot.available) {
      logger.info(
        `freellmapi: ${String(snapshot.models.length)} reachable routes across `
        + `${String(platforms.size)} providers, from ${snapshot.dbPath}`,
      )
    } else {
      logger.warn(
        'freellmapi: no usable store; the routes stay selectable but every request will '
        + `report NO_MODEL_AVAILABLE until ${resolveDataDir(config)} holds freeapi.db`,
      )
    }
    if (usingProxy) {
      logger.info('freellmapi: proxy transport selected; turns are routed by the FreeLLMAPI app')
      void proxyState().then((state) => {
        if (state.found) logger.info(`freellmapi: proxy found on port ${String(state.port)} (${String(state.models)} models)`)
        else logger.warn('freellmapi: no FreeLLMAPI proxy found; open Settings and set the port, or switch to direct routing')
      }).catch(() => {})
    }

    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // Already released with the owning fiber.
        }
      }
      if (typeof registration === 'function') registration()
    }
  }, 'freellmapi-auto: provider registration lifetime')
}

export { PLUGIN_VERSION }
