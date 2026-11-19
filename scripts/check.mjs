#!/usr/bin/env node
/**
 * Repository check: manifests, resources, secrets, and syntax.
 *
 * Run `npm run check` before committing. It fails on the two mistakes that hurt:
 * a manifest that no longer matches the files (a bundle that installs and then
 * does nothing), and anything that looks like a credential or a personal path in
 * a public repository.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, extname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const problems = []
const notes = []

/**
 * Report one failed rule.
 * @param {string} message - what failed.
 * @returns {void}
 */
function fail(message) {
  problems.push(message)
}

/**
 * Read and parse a JSON file.
 * @param {string} path - absolute path.
 * @returns {any} the parsed value.
 */
function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * List every text file that belongs to the repository.
 * @param {string} directory - directory to walk.
 * @returns {string[]} absolute file paths.
 */
function walk(directory) {
  /** @type {string[]} */
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'coverage') continue
    const full = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...walk(full))
    else if (entry.isFile()) files.push(full)
  }
  return files
}

const manifest = readJson(join(root, 'package.json'))
const pluginManifestPath = join(root, 'dsh.plugin.json')

// 1. The bundle manifest must point at files that exist and declare the same
//    package name the Loader row names.
if (typeof manifest.dsh?.bundle?.patch !== 'string') fail('package.json: dsh.bundle.patch is missing')
else if (!existsSync(join(root, manifest.dsh.bundle.patch))) fail(`package.json: ${manifest.dsh.bundle.patch} does not exist`)

for (const key of ['main']) {
  if (typeof manifest[key] !== 'string' || !existsSync(join(root, manifest[key]))) {
    fail(`package.json: ${key} does not point at an existing file`)
  }
}
for (const entry of Object.values(manifest.exports ?? {})) {
  if (typeof entry !== 'string' || entry.includes('*')) continue
  if (!existsSync(join(root, entry))) fail(`package.json: export target ${entry} does not exist`)
}

if (existsSync(pluginManifestPath)) {
  const plugin = readJson(pluginManifestPath)
  if (plugin.name !== manifest.name) fail('dsh.plugin.json: name differs from package.json')
  if (plugin.version !== manifest.version) fail('dsh.plugin.json: version differs from package.json')
  for (const key of ['host', 'patch']) {
    const path = plugin.entry?.[key]
    if (typeof path !== 'string' || !existsSync(join(root, path))) {
      fail(`dsh.plugin.json: entry.${key} ${String(path)} does not exist`)
    }
  }
  // A client half is optional; when declared it must exist.
  if (plugin.entry?.client !== undefined) {
    const path = plugin.entry.client
    if (typeof path !== 'string' || !existsSync(join(root, path))) {
      fail(`dsh.plugin.json: entry.client ${String(path)} does not exist`)
    }
  }
} else {
  notes.push('dsh.plugin.json is absent')
}

// 2. The runtime version constant must not drift from the package version.
const identitySource = readFileSync(join(root, 'src', 'identity.js'), 'utf8')
const versionMatch = /PLUGIN_VERSION = '([^']+)'/.exec(identitySource)
if (versionMatch === null) fail('src/identity.js: PLUGIN_VERSION is not declared')
else if (versionMatch[1] !== manifest.version) {
  fail(`src/identity.js: PLUGIN_VERSION ${versionMatch[1]} differs from package.json ${manifest.version}`)
}

// 3. Locale metadata and the detail document are what Plugin Manager shows.
const localeDir = join(root, 'locale')
const locales = existsSync(localeDir)
  ? readdirSync(localeDir).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5))
  : []
if (!locales.includes('en')) fail('locale/en.json is missing')
for (const locale of locales) {
  const path = join(localeDir, `${locale}.json`)
  let value
  try {
    value = readJson(path)
  } catch (error) {
    fail(`locale/${locale}.json is not valid JSON: ${error instanceof Error ? error.message : error}`)
    continue
  }
  if (typeof value.meta?.title !== 'string' || value.meta.title.trim() === '') fail(`locale/${locale}.json: meta.title is missing`)
  if (typeof value.meta?.description !== 'string' || value.meta.description.trim() === '') fail(`locale/${locale}.json: meta.description is missing`)
  if (typeof value.meta?.detail === 'string' && !existsSync(join(root, value.meta.detail))) {
    fail(`locale/${locale}.json: meta.detail ${value.meta.detail} does not exist`)
  }
}

// 4. The icon must be a real SVG inside the size limit.
const iconPath = join(root, 'icon.svg')
if (!existsSync(iconPath)) {
  fail('icon.svg is missing')
} else {
  const bytes = statSync(iconPath).size
  if (bytes > 256 * 1024) fail(`icon.svg is ${String(bytes)} bytes, over the 256 KiB limit`)
  const text = readFileSync(iconPath, 'utf8')
  if (!text.includes('<svg')) fail('icon.svg does not contain an <svg> element')
}

// 5. The patch row must name this package, or the bundle installs nothing.
const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
if (!patch.includes(`name: ${manifest.name}`)) fail(`cordis.patch.yml: no row names ${manifest.name}`)

// 6. No credential and no personal path may reach a public repository.
const secretPatterns = [
  { name: 'an API key literal', pattern: /\b(?:sk-[A-Za-z0-9]{16,}|gsk_[A-Za-z0-9]{16,}|nvapi-[A-Za-z0-9_-]{16,}|csk-[A-Za-z0-9]{16,}|xai-[A-Za-z0-9]{16,})/u },
  { name: 'a provider token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|fla_[A-Za-z0-9]{16,})/u },
  { name: 'a private key block', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u },
  { name: 'a personal home directory', pattern: /(?:[A-Za-z]:\\Users\\[^\\\s"']+|\/Users\/[^/\s"']+|\/home\/[^/\s"']+)/u },
  { name: 'a real FreeLLMAPI unified key', pattern: /freellmapi-[a-f0-9]{16,}/u },
]

const textExtensions = new Set(['.js', '.mjs', '.json', '.yml', '.yaml', '.md', '.svg', '.txt', '.example', ''])
for (const file of walk(root)) {
  const name = relative(root, file)
  if (name === '.env.example') continue
  const extension = extname(file)
  if (!textExtensions.has(extension)) continue
  if (statSync(file).size > 512 * 1024) continue
  const text = readFileSync(file, 'utf8')
  for (const { name: label, pattern } of secretPatterns) {
    if (pattern.test(text)) fail(`${name}: looks like it contains ${label}`)
  }
}

// 7. Every shipped module must parse.
const sources = walk(root).filter((file) => extname(file) === '.js' || extname(file) === '.mjs')
for (const file of sources) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } catch (error) {
    const detail = error instanceof Error ? error.message.split('\n').slice(0, 3).join(' ') : String(error)
    fail(`${relative(root, file)}: does not parse — ${detail}`)
  }
}

// 8. The generated market index, when present, must satisfy the shipped
//    validator. Resolution needs a DSH installation; without one this is a note.
const indexPath = join(root, 'index.json')
if (existsSync(indexPath)) {
  const installDir = process.env.DSH_INSTALL_DIR ?? ''
  if (installDir === '') {
    notes.push('index.json was not validated: DSH_INSTALL_DIR is not set')
  } else {
    try {
      const resolver = createRequire(join(installDir, 'package.json'))
      const validator = await import(pathToFileURL(resolver.resolve('@deepseek-ai/dsh-plugin-market-index')).href)
      validator.parseMarketIndex(
        readJson(indexPath),
        `https://raw.githubusercontent.com/luciomerlo/${manifest.name}/main/index.json`,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('Cannot find') || message.includes('ERR_MODULE_NOT_FOUND') || message.includes('MODULE_NOT_FOUND')) {
        notes.push('index.json was not validated: the market index validator is not resolvable from DSH_INSTALL_DIR')
      } else {
        fail(`index.json: ${message}`)
      }
    }
  }
} else {
  notes.push('index.json is absent; run `npm run index` after the first commit')
}

for (const note of notes) console.log(`note: ${note}`)
if (problems.length > 0) {
  for (const problem of problems) console.error(`error: ${problem}`)
  console.error(`\n${String(problems.length)} problem(s) found.`)
  process.exit(1)
}
console.log(`ok: ${String(sources.length)} module(s) parse, manifests and resources agree, no secrets or personal paths found.`)
