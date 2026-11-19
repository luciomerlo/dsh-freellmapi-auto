/**
 * Locating the FreeLLMAPI data directory.
 *
 * The desktop app stores its SQLite database and its encryption key in the
 * platform user-data directory. A machine may also keep an explicit directory
 * for a portable install, and `FREELMAPI_HOME` overrides both. Nothing here
 * writes: the resolver only reports which directory the reader should open.
 *
 * @module dsh-freellmapi-auto/paths
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Candidate data directories, most specific first.
 * @param {Record<string, any>} [config] - resolved plugin config.
 * @param {Record<string, string | undefined>} [env] - environment to read.
 * @param {NodeJS.Platform} [platform] - target platform.
 * @returns {string[]} existing-first candidate list.
 */
export function dataDirCandidates(config = {}, env = process.env, platform = process.platform) {
  /** @type {string[]} */
  const candidates = []
  const configured = typeof config.dataDir === 'string' ? config.dataDir.trim() : ''
  if (configured !== '') candidates.push(configured)
  const fromEnvironment = typeof env.FREELMAPI_HOME === 'string' ? env.FREELMAPI_HOME.trim() : ''
  if (fromEnvironment !== '') candidates.push(fromEnvironment)

  if (platform === 'win32') {
    const appData = env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
    candidates.push(join(appData, 'freellmapi'))
    candidates.push(join(appData, 'FreeLLMAPI'))
  } else if (platform === 'darwin') {
    candidates.push(join(homedir(), 'Library', 'Application Support', 'freellmapi'))
    candidates.push(join(homedir(), '.freellmapi'))
  } else {
    candidates.push(join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'freellmapi'))
    candidates.push(join(homedir(), '.freellmapi'))
  }
  candidates.push(join(homedir(), '.freellmapi'))

  // Keep the order stable while dropping duplicates.
  return [...new Set(candidates.filter((value) => value !== ''))]
}

/**
 * Pick the first candidate that actually holds a store.
 * @param {Record<string, any>} [config] - resolved plugin config.
 * @param {Record<string, string | undefined>} [env] - environment to read.
 * @param {NodeJS.Platform} [platform] - target platform.
 * @returns {string} the directory, or the configured candidate when none exists.
 */
export function resolveDataDir(config = {}, env = process.env, platform = process.platform) {
  const candidates = dataDirCandidates(config, env, platform)
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'freeapi.db'))) return candidate
  }
  return candidates[0] ?? ''
}

/**
 * The store path for a directory.
 * @param {string} dataDir - the data directory.
 * @returns {string} the SQLite file path.
 */
export function storePath(dataDir) {
  return dataDir === '' ? '' : join(dataDir, 'freeapi.db')
}
