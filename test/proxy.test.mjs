import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  COMMON_PROXY_PORTS,
  candidatePorts,
  detectProxy,
  normalizeProxyHost,
  probeProxy,
  proxyBaseUrl,
  storeConfigPort,
} from '../src/proxy.js'

/**
 * Start a server that answers `/v1/models`.
 * @param {(res: import('node:http').ServerResponse) => void} handler - response writer.
 * @returns {Promise<{port: number, close: () => Promise<void>}>} the server.
 */
async function serve(handler) {
  const server = createServer((req, res) => handler(res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    port: typeof address === 'object' && address !== null ? address.port : 0,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

test('the app config names its port when the file is usable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'freellmapi-port-'))
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ port: 31415, locale: 'es' }), 'utf8')
  assert.equal(storeConfigPort(dir), 31415)

  writeFileSync(join(dir, 'config.json'), JSON.stringify({ port: 'nope' }), 'utf8')
  assert.equal(storeConfigPort(dir), undefined)

  writeFileSync(join(dir, 'config.json'), '{not json', 'utf8')
  assert.equal(storeConfigPort(dir), undefined)

  assert.equal(storeConfigPort(''), undefined)
  assert.equal(storeConfigPort(join(dir, 'absent')), undefined)
})

test('a live proxy is detected with its published model count', async () => {
  const server = await serve((res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'auto' }, { id: 'fusion' }] }))
  })
  try {
    const probe = await probeProxy({ host: '127.0.0.1', port: server.port })
    assert.equal(probe.ok, true)
    assert.equal(probe.models, 2)
  } finally {
    await server.close()
  }
})

test('an unauthorized or silent port is reported, not thrown', async () => {
  const server = await serve((res) => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'unauthorized' }))
  })
  try {
    const probe = await probeProxy({ host: '127.0.0.1', port: server.port })
    assert.equal(probe.ok, false)
    assert.equal(probe.status, 401)
    assert.equal(probe.detail, 'HTTP 401')
  } finally {
    await server.close()
  }

  const closed = await serve(() => {})
  const closedPort = closed.port
  await closed.close()
  const silent = await probeProxy({ host: '127.0.0.1', port: closedPort, timeoutMs: 300 })
  assert.equal(silent.ok, false)
  assert.equal(silent.status, 0)
})

test('detection keeps probing until one port answers', async () => {
  const server = await serve((res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'auto' }] }))
  })
  const dead = await serve(() => {})
  const deadPort = dead.port
  await dead.close()
  try {
    const detected = await detectProxy({
      host: '127.0.0.1',
      candidates: [deadPort, server.port],
      apiKey: 'token',
    })
    assert.deepEqual(detected.found, { host: '127.0.0.1', port: server.port, models: 1 })
    assert.equal(detected.tried.length, 2)
    assert.equal(detected.tried[0].ok, false)
    assert.equal(detected.tried[1].ok, true)
  } finally {
    await server.close()
  }
})

test('detection reports nothing found when every candidate is dead', async () => {
  const dead = await serve(() => {})
  const port = dead.port
  await dead.close()
  const detected = await detectProxy({ host: '127.0.0.1', candidates: [port] })
  assert.equal(detected.found, undefined)
  assert.equal(detected.tried.length, 1)
})

test('candidate ports prefer the profile, then the app, then the usual ones', () => {
  const ports = candidatePorts({ configured: 4000, storePort: 31415 })
  assert.equal(ports[0], 4000)
  assert.equal(ports[1], 31415)
  for (const port of COMMON_PROXY_PORTS) assert.ok(ports.includes(port), String(port))
  assert.equal(new Set(ports).size, ports.length)

  const auto = candidatePorts({ configured: 0, storePort: 31415 })
  assert.equal(auto[0], 31415)

  const none = candidatePorts({})
  assert.deepEqual(none, [...COMMON_PROXY_PORTS])
})

test('hosts normalize from a bare host or an absolute URL', () => {
  assert.equal(normalizeProxyHost('127.0.0.1'), '127.0.0.1')
  assert.equal(normalizeProxyHost(' 127.0.0.1/ '), '127.0.0.1')
  assert.equal(normalizeProxyHost('http://127.0.0.1:31415/v1'), '127.0.0.1:31415')
  assert.equal(normalizeProxyHost(''), '')
  assert.equal(normalizeProxyHost(42), '')
  assert.equal(proxyBaseUrl('127.0.0.1', 31415), 'http://127.0.0.1:31415/v1')
})
