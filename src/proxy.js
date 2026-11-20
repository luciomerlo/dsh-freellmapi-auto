/**
 * The optional FreeLLMAPI proxy transport.
 *
 * Direct routing calls each provider with the key the store holds. The proxy
 * mode is the opposite trade: one local endpoint decides which free route serves
 * the turn, and this plugin becomes a thin client of that decision. It exists
 * because the desktop app already implements per-provider quirks and fallback,
 * and some users prefer one configuration surface over per-route control.
 *
 * Everything here is read-only toward the app: the plugin reads its `config.json`
 * for the port, its `settings.unified_api_key` for the bearer token, and never
 * writes either.
 *
 * @module dsh-freellmapi-auto/proxy
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { normalizeBaseUrl } from './endpoints.js'

/** Ports probed when neither the profile nor the app names one. */
export const COMMON_PROXY_PORTS = Object.freeze([31415, 3000, 8000, 8080, 5000, 11434])

/** Deadline for one probe. */
const PROBE_TIMEOUT_MS = 1500

/**
 * Read the port the FreeLLMAPI app recorded for itself.
 * @param {string} dataDir - the store directory.
 * @returns {number | undefined} the configured port, when the file is readable.
 */
export function storeConfigPort(dataDir) {
  if (dataDir === '') return undefined
  const path = join(dataDir, 'config.json')
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const port = Number(parsed?.port)
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined
  } catch {
    return undefined
  }
}

/**
 * Probe one candidate endpoint for a live FreeLLMAPI proxy.
 * @param {object} input - the probe.
 * @param {string} input.host - host to probe.
 * @param {number} input.port - port to probe.
 * @param {string} [input.apiKey] - bearer token to send, when known.
 * @param {number} [input.timeoutMs] - deadline for this probe.
 * @returns {Promise<{port: number, ok: boolean, status: number, models: number, detail: string}>} the probe result.
 */
export async function probeProxy({ host, port, apiKey, timeoutMs = PROBE_TIMEOUT_MS }) {
  const url = `http://${host}:${String(port)}/v1/models`
  try {
    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
        ...(apiKey === undefined || apiKey === '' ? {} : { authorization: `Bearer ${apiKey}` }),
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      return { port, ok: false, status: response.status, models: 0, detail: `HTTP ${String(response.status)}` }
    }
    const body = await response.json().catch(() => undefined)
    const data = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : []
    return { port, ok: true, status: response.status, models: data.length, detail: '' }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { port, ok: false, status: 0, models: 0, detail: detail.includes('timeout') ? 'timed out' : detail }
  }
}

/**
 * Probe the profile port first, then the app's own port, then the usual ones.
 * @param {object} input - the search.
 * @param {string} input.host - host to probe.
 * @param {number[]} input.candidates - ports in preference order.
 * @param {string} [input.apiKey] - bearer token to send, when known.
 * @returns {Promise<{found: {host: string, port: number, models: number} | undefined, tried: object[]}>} the result.
 */
export async function detectProxy({ host, candidates, apiKey }) {
  const seen = new Set()
  const tried = []
  for (const port of candidates) {
    if (!Number.isInteger(port) || port <= 0 || port > 65_535 || seen.has(port)) continue
    seen.add(port)
    const result = await probeProxy({ host, port, apiKey })
    tried.push(result)
    if (result.ok) {
      return { found: { host, port: result.port, models: result.models }, tried }
    }
  }
  return { found: undefined, tried }
}

/**
 * Candidate ports for one detection run, most likely first.
 * @param {object} input - the inputs.
 * @param {number} [input.configured] - port saved in the plugin config; 0 means autodetect.
 * @param {number} [input.storePort] - port the FreeLLMAPI app recorded.
 * @returns {number[]} the ordered candidates.
 */
export function candidatePorts({ configured, storePort }) {
  const ordered = []
  if (Number.isInteger(configured) && configured > 0) ordered.push(configured)
  if (Number.isInteger(storePort) && storePort > 0) ordered.push(storePort)
  ordered.push(...COMMON_PROXY_PORTS)
  return [...new Set(ordered)]
}

/**
 * Normalize a proxy host: a bare host or an absolute URL both work.
 * @param {unknown} value - the configured value.
 * @returns {string} a host, or an empty string when unusable.
 */
export function normalizeProxyHost(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (trimmed === '') return ''
  if (/^https?:\/\//iu.test(trimmed)) {
    try {
      return new URL(trimmed).host
    } catch {
      return ''
    }
  }
  return trimmed.replace(/\/+$/u, '')
}

/**
 * Build the proxy base URL.
 * @param {string} host - normalized host.
 * @param {number} port - port.
 * @returns {string} the `.../v1` base.
 */
export function proxyBaseUrl(host, port) {
  return normalizeBaseUrl(`http://${host}:${String(port)}/v1`)
}
