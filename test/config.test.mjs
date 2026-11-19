import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { resolveConfig } from '../index.js'
import { dataDirCandidates, resolveDataDir, storePath } from '../src/paths.js'

test('defaults resolve without a row config', () => {
  const config = resolveConfig(undefined)
  assert.equal(config.maxAttempts, 6)
  assert.equal(config.firstTokenTimeoutMs, 7000)
  assert.equal(config.streamIdleTimeoutMs, 12_000)
  assert.equal(config.autoModelName, 'Auto (FreeLLMApi)')
  assert.deepEqual(config.endpoints, {})
})

test('row config overrides defaults', () => {
  const config = resolveConfig({ maxAttempts: 2, autoModelName: 'Mine', dataDir: 'C:/x' })
  assert.equal(config.maxAttempts, 2)
  assert.equal(config.autoModelName, 'Mine')
  assert.equal(config.dataDir, 'C:/x')
})

test('invalid configuration is rejected with a readable message', () => {
  assert.throws(() => resolveConfig({ maxAttempts: 0 }), /maxAttempts must be an integer >= 1/)
  assert.throws(() => resolveConfig({ tokensPerCharacter: 3 }), /tokensPerCharacter must be in \(0, 1\]/)
  assert.throws(() => resolveConfig({ endpoints: [1, 2] }), /endpoints must be a mapping/)
  assert.throws(() => resolveConfig({ autoModelName: '   ' }), /autoModelName must be non-empty/)
  assert.throws(() => resolveConfig({ firstTokenTimeoutMs: -1 }), /firstTokenTimeoutMs must be a positive number/)
})

test('data directory candidates prefer configuration, then the environment, then platform defaults', () => {
  const windows = dataDirCandidates({ dataDir: 'C:/explicit' }, { FREELMAPI_HOME: 'C:/env', APPDATA: 'C:/appdata/roaming' }, 'win32')
  assert.equal(windows[0], 'C:/explicit')
  assert.equal(windows[1], 'C:/env')
  assert.ok(windows.includes(join('C:/appdata/roaming', 'freellmapi')))

  const linux = dataDirCandidates({}, { XDG_CONFIG_HOME: '/srv/deploy/.config' }, 'linux')
  assert.equal(linux[0], join('/srv/deploy/.config', 'freellmapi'))

  const mac = dataDirCandidates({}, {}, 'darwin')
  assert.equal(mac[0], join(homedir(), 'Library', 'Application Support', 'freellmapi'))
})

test('the resolver picks the directory that actually holds a store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'freellmapi-store-'))
  writeFileSync(join(dir, 'freeapi.db'), '', 'utf8')
  assert.equal(resolveDataDir({ dataDir: dir }, {}, 'win32'), dir)
  assert.equal(storePath(dir), join(dir, 'freeapi.db'))
  assert.equal(storePath(''), '')

  // No candidate exists: the resolver still answers with a directory instead of
  // failing, so the warning it prints can name where a store was expected.
  const missing = dataDirCandidates({ dataDir: join(dir, 'absent') }, {}, 'linux')[0]
  assert.equal(typeof resolveDataDir({ dataDir: missing }, {}, 'linux'), 'string')
})
