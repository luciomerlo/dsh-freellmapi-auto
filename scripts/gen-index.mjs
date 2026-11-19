#!/usr/bin/env node
/**
 * Generate `index.json`, the DeepSeek Harness plugin-market index for this
 * repository.
 *
 * The format pins one Git commit per version, so the index has to name a commit
 * of *this* repository. Two cases work:
 *
 *   node scripts/gen-index.mjs            # HEAD (commit the index afterwards)
 *   node scripts/gen-index.mjs --commit <sha>
 *
 * The first release therefore uses two commits: the code commit, then the index
 * commit that references it.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const repositoryUrl = typeof manifest.repository?.url === 'string'
  ? manifest.repository.url.replace(/^git\+/u, '').replace(/\.git$/u, '')
  : ''
if (repositoryUrl === '') {
  console.error('error: package.json repository.url is not set')
  process.exit(1)
}

const args = process.argv.slice(2)
const explicit = args.indexOf('--commit')
let commit = explicit >= 0 ? args[explicit + 1] : ''

if (commit === undefined || commit === '') {
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  } catch {
    console.error('error: no commit given and git could not read HEAD')
    process.exit(1)
  }
}
if (!/^[0-9a-f]{40}$/u.test(commit)) {
  console.error(`error: ${commit} is not a 40-character lowercase commit SHA`)
  process.exit(1)
}

const locale = JSON.parse(readFileSync(join(root, 'locale', 'en.json'), 'utf8'))
const spanish = JSON.parse(readFileSync(join(root, 'locale', 'es.json'), 'utf8'))
const homepage = `https://github.com/${repositoryUrl.split('/').slice(-2).join('/')}`

const index = {
  format: 1,
  title: { en: 'FreeLLMAPI Auto', es: 'FreeLLMAPI Auto' },
  description: {
    en: 'A DeepSeek Harness bundle that routes free-tier model providers with context- and TPM-aware selection.',
    es: 'Un bundle de DeepSeek Harness que enruta proveedores gratuitos con selección por contexto y TPM.',
  },
  metadata: {
    categories: { routing: { title: { en: 'Routing', es: 'Enrutamiento' } } },
    labels: {
      failover: { title: { en: 'Failover', es: 'Conmutación' } },
      'llm-provider': { title: { en: 'LLM provider', es: 'Proveedor LLM' } },
    },
  },
  plugins: [
    {
      name: manifest.name,
      title: { en: locale.meta.title, es: spanish.meta.title },
      description: { en: locale.meta.description, es: spanish.meta.description },
      icon: `https://raw.githubusercontent.com/${repositoryUrl.split('/').slice(-2).join('/')}/main/icon.svg`,
      author: 'Lucio Merlo',
      homepage,
      repository: { url: repositoryUrl },
      metadata: {
        category: 'routing',
        keywords: [
          'deepseek-harness',
          'cordis-plugin',
          'llm-router',
          'failover',
          'freellmapi',
          'openai-compatible',
        ],
        labels: ['failover', 'llm-provider'],
      },
      versions: [
        {
          version: manifest.version,
          publishTimestamp: Math.floor(Date.now() / 1000),
          source: { type: 'git', url: repositoryUrl, commit },
        },
      ],
    },
  ],
}

const target = join(root, 'index.json')
writeFileSync(target, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
console.log(`wrote ${target} pinning ${commit}`)
if (!existsSync(join(root, '.git'))) {
  console.log('note: this directory is not a Git work tree yet; the pinned commit must exist before publishing')
}
