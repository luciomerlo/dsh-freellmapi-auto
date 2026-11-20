/**
 * FreeLLMAPI inventory reader.
 *
 * The desktop app keeps everything the router needs in one SQLite store: the
 * enabled model table with its per-route RPM/TPM limits, the API keys (encrypted
 * per key), the reported provider quota, and a short usage history. Reading it
 * read-only means the plugin never mutates another application's data and never
 * needs the app to be running.
 *
 * A snapshot is immutable once published: a sync builds a new object and swaps
 * it in, so a request that started under one snapshot never finishes under
 * another.
 *
 * @module dsh-freellmapi-auto/inventory
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { BUILTIN_ENDPOINTS, normalizeBaseUrl } from './endpoints.js'
import { decryptSecret, readEncryptionKey } from './keys.js'
import { resolveDataDir } from './paths.js'

/**
 * @typedef {object} InventoryModel
 * @property {number} dbId - primary key in the store.
 * @property {string} platform - upstream platform id, e.g. `groq` or `custom`.
 * @property {string} modelId - upstream model id.
 * @property {string} pin - stable id exposed to the harness selector.
 * @property {string} displayName - human-readable name.
 * @property {number} iqRank - FreeLLMAPI intelligence rank, 1 is best.
 * @property {number} speedRank - FreeLLMAPI speed rank, 1 is fastest.
 * @property {number | null} rpm - requests per minute cap, when published.
 * @property {number | null} rpd - requests per day cap, when published.
 * @property {number | null} tpm - tokens per minute cap, when published.
 * @property {number | null} tpd - tokens per day cap, when published.
 * @property {number | null} contextWindow - published context capacity.
 * @property {boolean} supportsTools - whether the route can call tools.
 * @property {boolean} supportsVision - whether the route accepts images.
 * @property {number | null} keyId - the store key this route authenticates with.
 * @property {{baseUrl: string, auth: string, keyId: number | null}} endpoint - the resolved endpoint.
 * @property {string} bucket - shared-quota bucket id.
 */

const EMPTY_SNAPSHOT = Object.freeze({
  available: false,
  dbPath: '',
  syncedAt: 0,
  reason: 'never',
  models: Object.freeze([]),
  pins: Object.freeze(new Map()),
  keys: Object.freeze(new Map()),
  quotas: Object.freeze(new Map()),
  seeded: Object.freeze(new Map()),
  warnings: Object.freeze([]),
})

export class Inventory {
  /**
   * @param {object} options - construction options.
   * @param {Record<string, any>} options.config - resolved plugin config.
   * @param {{info: Function, warn: Function, debug: Function}} options.logger - diagnostics sink.
   */
  constructor({ config, logger }) {
    this.config = config
    this.logger = logger
    this.dataDir = resolveDataDir(config)
    this.dbPath = this.dataDir === '' ? '' : join(this.dataDir, 'freeapi.db')
    this.keyPath = this.dataDir === '' ? '' : join(this.dataDir, '.encryption-key')
    /** @type {any} */
    this.snapshot = EMPTY_SNAPSHOT
    /** @type {Map<string, string>} decrypted secrets keyed by store key id */
    this.secrets = new Map()
    /** @type {string | undefined} */
    this.cachedUnifiedKey = undefined
    /** @type {Buffer | undefined} */
    this.encryptionKey = undefined
    this.lastSyncAt = 0
    this.syncInFlight = false
    /** @type {Record<string, any>} */
    this.endpointOverrides = typeof config.endpoints === 'object' && config.endpoints !== null ? config.endpoints : {}
  }

  /**
   * Re-read the store when the snapshot is older than the configured interval.
   * @param {string} reason - why the read was requested, recorded in diagnostics.
   * @returns {boolean} whether the snapshot was replaced.
   */
  refreshIfStale(reason) {
    const interval = Number(this.config.minSyncIntervalMs) || 0
    if (Date.now() - this.lastSyncAt < interval) return false
    return this.sync(reason)
  }

  /**
   * Read the store and publish a new immutable snapshot.
   * @param {string} reason - why the read was requested.
   * @returns {boolean} whether a usable snapshot was published.
   */
  sync(reason) {
    this.lastSyncAt = Date.now()
    if (this.syncInFlight) return false
    this.syncInFlight = true
    try {
      if (this.dbPath === '' || !existsSync(this.dbPath)) {
        this.snapshot = { ...EMPTY_SNAPSHOT, reason, syncedAt: Date.now(), warnings: [`no FreeLLMAPI store at ${this.dbPath === '' ? '(unresolved data directory)' : this.dbPath}`] }
        return false
      }
      const snapshot = this.readStore(reason)
      this.snapshot = snapshot
      return snapshot.available
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.logger.warn('freellmapi: reading the inventory failed:', message)
      this.snapshot = { ...EMPTY_SNAPSHOT, dbPath: this.dbPath, reason, syncedAt: Date.now(), warnings: [`reading the inventory failed: ${message}`] }
      return false
    } finally {
      this.syncInFlight = false
    }
  }

  /**
   * Read the SQLite store into a fresh snapshot.
   * @param {string} reason - why the read was requested.
   * @returns {typeof EMPTY_SNAPSHOT} the snapshot.
   */
  readStore(reason) {
    // Imported lazily so a Harness running on an older Node reports a readable
    // diagnostic instead of failing to load the plugin at all.
    const { DatabaseSync } = requireSqlite()
    const db = new DatabaseSync(this.dbPath, { readOnly: true })
    const warnings = []
    try {
      const keyRows = db.prepare(`
        SELECT id, platform, status, enabled, base_url, model_scope_json,
               monthly_request_cap, monthly_token_cap
        FROM api_keys
        WHERE enabled = 1
      `).all()

      /** @type {Map<number, any>} */
      const keys = new Map()
      for (const row of keyRows) {
        keys.set(Number(row.id), {
          id: Number(row.id),
          platform: String(row.platform),
          status: String(row.status),
          baseUrl: normalizeBaseUrl(row.base_url),
          monthlyRequestCap: Number(row.monthly_request_cap ?? 0),
          monthlyTokenCap: Number(row.monthly_token_cap ?? 0),
        })
      }

      const quotaRows = db.prepare(`
        SELECT platform, key_id, metric, limit_value, remaining_value, reset_at
        FROM provider_quota_state
      `).all()
      /** @type {Map<string, any>} */
      const quotas = new Map()
      for (const row of quotaRows) {
        quotas.set(`${String(row.platform)}:${Number(row.key_id)}:${String(row.metric)}`, {
          limit: row.limit_value === null ? null : Number(row.limit_value),
          remaining: row.remaining_value === null ? null : Number(row.remaining_value),
          resetAt: row.reset_at === null ? null : String(row.reset_at),
        })
      }

      const modelRows = db.prepare(`
        SELECT id, platform, model_id, display_name, intelligence_rank, speed_rank,
               size_label, rpm_limit, rpd_limit, tpm_limit, tpd_limit,
               context_window, supports_vision, supports_tools, key_id, endpoint_scope
        FROM models
        WHERE enabled = 1
      `).all()

      /** @type {InventoryModel[]} */
      const models = []
      /** @type {Map<string, InventoryModel>} */
      const pins = new Map()
      let unresolved = 0

      for (const row of modelRows) {
        const platform = String(row.platform)
        const keyId = row.key_id === null ? null : Number(row.key_id)
        const endpoint = this.endpointForRow({
          platform,
          modelId: String(row.model_id),
          keyId,
          endpointScope: row.endpoint_scope === null ? '' : String(row.endpoint_scope),
          keys,
        })
        if (endpoint === undefined) {
          unresolved += 1
          continue
        }
        const pin = pinFor(platform, endpoint.baseUrl, String(row.model_id))
        const model = {
          dbId: Number(row.id),
          platform,
          modelId: String(row.model_id),
          pin,
          displayName: String(row.display_name ?? row.model_id),
          iqRank: Number(row.intelligence_rank ?? 1000),
          speedRank: Number(row.speed_rank ?? 1000),
          rpm: row.rpm_limit === null ? null : Number(row.rpm_limit),
          rpd: row.rpd_limit === null ? null : Number(row.rpd_limit),
          tpm: row.tpm_limit === null ? null : Number(row.tpm_limit),
          tpd: row.tpd_limit === null ? null : Number(row.tpd_limit),
          contextWindow: row.context_window === null ? null : Number(row.context_window),
          supportsTools: Number(row.supports_tools ?? 0) === 1,
          supportsVision: Number(row.supports_vision ?? 0) === 1,
          keyId: endpoint.keyId,
          endpoint,
          bucket: `${platform}:${endpoint.keyId ?? 0}`,
        }
        models.push(model)
        if (!pins.has(pin)) pins.set(pin, model)
      }

      if (unresolved > 0) {
        warnings.push(`${String(unresolved)} enabled model(s) skipped: no resolvable endpoint and no key`)
      }
      if (models.length === 0) {
        warnings.push('the store has no route that this plugin can reach directly; configure `endpoints` or add keys in FreeLLMAPI')
      }

      const seeded = Number(this.config.seedUsageWindowMs) > 0
        ? readRecentUsage(db, Number(this.config.seedUsageWindowMs))
        : new Map()

      return Object.freeze({
        available: true,
        dbPath: this.dbPath,
        syncedAt: Date.now(),
        reason,
        models: Object.freeze(models),
        pins,
        keys,
        quotas,
        seeded,
        warnings: Object.freeze(warnings),
      })
    } finally {
      try {
        db.close()
      } catch {
        // The handle is already gone; nothing to release.
      }
    }
  }

  /**
   * Resolve the endpoint and credential a model row would use.
   * @param {object} input - the row's routing inputs.
   * @param {string} input.platform - upstream platform id.
   * @param {string} input.modelId - upstream model id.
   * @param {number | null} input.keyId - bound key id, when the row names one.
   * @param {string} input.endpointScope - endpoint the row was published under.
   * @param {Map<number, any>} input.keys - enabled keys by id.
   * @returns {{baseUrl: string, auth: string, keyId: number | null} | undefined} the endpoint, when reachable.
   */
  endpointForRow({ platform, modelId, keyId, endpointScope, keys }) {
    const key = keyId === null ? bestKeyFor(platform, keys) : keys.get(keyId)
    const override = this.endpointOverrides[platform]
    const builtin = BUILTIN_ENDPOINTS[platform]
    const candidates = [
      key?.baseUrl,
      normalizeBaseUrl(endpointScope),
      normalizeBaseUrl(override?.baseUrl),
      normalizeBaseUrl(builtin?.baseUrl),
    ]
    const baseUrl = candidates.find((value) => typeof value === 'string' && value !== '')
    if (baseUrl === undefined) return undefined
    const auth = typeof override?.auth === 'string'
      ? override.auth
      : typeof builtin?.auth === 'string' ? builtin.auth : 'bearer'
    // Keyless gateways (Kilo, OVH, a local Ollama) are legitimate call targets.
    if (key === undefined && auth !== 'none') return undefined
    void modelId
    return { baseUrl, auth, keyId: key?.id ?? null }
  }

  /**
   * The credential for one key id, decrypted at most once per process.
   * @param {number} keyId - store key id.
   * @returns {string | undefined} the secret, when it can be read.
   */
  secretFor(keyId) {
    if (this.secrets.has(String(keyId))) return this.secrets.get(String(keyId))
    const snapshot = this.snapshot
    const key = snapshot.keys.get(keyId)
    if (key === undefined) return undefined
    const encrypted = this.readEncryptedKey(keyId)
    if (encrypted === undefined) return undefined
    if (this.encryptionKey === undefined) {
      this.encryptionKey = readEncryptionKey(this.keyPath)
    }
    if (this.encryptionKey === undefined) {
      this.logger.warn('freellmapi: the store encryption key is missing, so stored API keys cannot be used')
      return undefined
    }
    const secret = decryptSecret(this.encryptionKey, encrypted)
    if (secret === undefined) {
      this.logger.warn(`freellmapi: could not decrypt the key for ${key.platform} (id ${String(keyId)})`)
      return undefined
    }
    this.secrets.set(String(keyId), secret)
    return secret
  }

  /**
   * Read one row's encrypted key material.
   * @param {number} keyId - store key id.
   * @returns {{encryptedKey: string, iv: string, authTag: string} | undefined} the material.
   */
  readEncryptedKey(keyId) {
    try {
      const { DatabaseSync } = requireSqlite()
      const db = new DatabaseSync(this.dbPath, { readOnly: true })
      try {
        const row = db.prepare('SELECT encrypted_key, iv, auth_tag FROM api_keys WHERE id = ?').get(keyId)
        if (row === undefined) return undefined
        return {
          encryptedKey: String(row.encrypted_key),
          iv: String(row.iv),
          authTag: String(row.auth_tag),
        }
      } finally {
        db.close()
      }
    } catch (error) {
      this.logger.warn('freellmapi: reading an API key failed:', error instanceof Error ? error.message : error)
      return undefined
    }
  }

  /**
   * Resolve everything one attempt needs for a model: endpoint, credential, bucket.
   * @param {InventoryModel} model - the route to call.
   * @returns {{baseUrl: string, auth: string, apiKey: string, keyId: number | null, bucket: string} | undefined} the call target.
   */
  targetFor(model) {
    const endpoint = model.endpoint ?? this.endpointForRow({
      platform: model.platform,
      modelId: model.modelId,
      keyId: model.keyId,
      endpointScope: '',
      keys: this.snapshot.keys,
    })
    if (endpoint === undefined) return undefined
    const keyId = model.keyId ?? endpoint.keyId
    const apiKey = keyId === null ? '' : this.secretFor(keyId) ?? ''
    if (apiKey === '' && endpoint.auth !== 'none') return undefined
    return {
      baseUrl: endpoint.baseUrl,
      auth: endpoint.auth,
      apiKey,
      keyId,
      bucket: `${model.platform}:${keyId ?? 0}`,
    }
  }

  /**
   * Look up one pinned model by the id the selector advertises.
   * @param {string} pin - the pinned id.
   * @returns {InventoryModel | undefined} the route.
   */
  modelByPin(pin) {
    return this.snapshot.pins.get(pin)
  }

  /**
   * The store's own unified API key, used only by the proxy transport.
   *
   * This is the token the FreeLLMAPI app issues to its callers; it is stored in
   * the settings table rather than in `api_keys`, and it is never one of the
   * upstream provider keys.
   *
   * @returns {string | undefined} the token, when the store holds one.
   */
  unifiedKey() {
    if (this.cachedUnifiedKey !== undefined) return this.cachedUnifiedKey
    if (this.dbPath === '' || !existsSync(this.dbPath)) return undefined
    try {
      const { DatabaseSync } = requireSqlite()
      const db = new DatabaseSync(this.dbPath, { readOnly: true })
      try {
        const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('unified_api_key')
        const value = row === undefined ? '' : String(row.value).trim()
        if (value !== '') this.cachedUnifiedKey = value
        return value === '' ? undefined : value
      } finally {
        db.close()
      }
    } catch (error) {
      this.logger.warn('freellmapi: reading the unified API key failed:', error instanceof Error ? error.message : error)
      return undefined
    }
  }
}

/**
 * Import `node:sqlite`, explaining the failure when the runtime is too old.
 * @returns {{DatabaseSync: any}} the module.
 */
function requireSqlite() {
  // eslint-disable-next-line n/no-unsupported-features/node-builtins
  const module = process.getBuiltinModule?.('node:sqlite')
  if (module === undefined) {
    throw new Error('this Node runtime has no `node:sqlite`; FreeLLMAPI inventory needs Node 22.5 or newer')
  }
  if (typeof module.DatabaseSync !== 'function') {
    throw new Error('`node:sqlite` does not expose DatabaseSync in this runtime')
  }
  return module
}

/**
 * Pick the healthiest enabled key for a platform that did not bind a model to one.
 * @param {string} platform - upstream platform id.
 * @param {Map<number, any>} keys - enabled keys by id.
 * @returns {any | undefined} the chosen key.
 */
export function bestKeyFor(platform, keys) {
  let fallback
  for (const key of keys.values()) {
    if (key.platform !== platform) continue
    if (key.status === 'healthy') return key
    if (fallback === undefined && key.status !== 'invalid') fallback = key
  }
  return fallback
}

/**
 * Build the selector id of one route: the endpoint host for gateway platforms,
 * the platform id otherwise. Two gateways can serve the same model id, so the
 * host is what keeps the ids unique and recognisable.
 * @param {string} platform - upstream platform id.
 * @param {string} baseUrl - resolved endpoint.
 * @param {string} modelId - upstream model id.
 * @returns {string} the pinned id.
 */
export function pinFor(platform, baseUrl, modelId) {
  let label = platform
  if (platform === 'custom') {
    try {
      label = new URL(baseUrl).host
    } catch {
      label = 'custom'
    }
  }
  return `${label}/${modelId}`.replace(/\s+/g, '')
}

/**
 * Seed per-key usage windows with what the store already recorded very recently,
 * so a second free-tier client does not spend the same minute twice.
 * @param {any} db - an open DatabaseSync handle.
 * @param {number} windowMs - how far back to read.
 * @returns {Map<string, {requests: number, tokens: number}>} usage by bucket id.
 */
function readRecentUsage(db, windowMs) {
  const since = Date.now() - windowMs
  const rows = db.prepare(`
    SELECT platform, key_id, kind, COUNT(*) AS events, COALESCE(SUM(tokens), 0) AS tokens
    FROM rate_limit_usage
    WHERE created_at_ms >= ?
    GROUP BY platform, key_id, kind
  `).all(since)
  /** @type {Map<string, {requests: number, tokens: number}>} */
  const usage = new Map()
  for (const row of rows) {
    const bucket = `${String(row.platform)}:${Number(row.key_id)}`
    const current = usage.get(bucket) ?? { requests: 0, tokens: 0 }
    if (String(row.kind) === 'request') current.requests += Number(row.events)
    if (String(row.kind) === 'tokens') current.tokens += Number(row.tokens)
    usage.set(bucket, current)
  }
  return usage
}

/**
 * Read a whole-store row set without crashing on a schema that has drifted.
 * @param {any} db - an open DatabaseSync handle.
 * @param {string} sql - the query.
 * @param {readonly unknown[]} [params] - bound parameters.
 * @returns {any[]} the rows, or an empty list when the query does not fit the store.
 */
export function safeAll(db, sql, params = []) {
  try {
    return db.prepare(sql).all(...params)
  } catch {
    return []
  }
}
