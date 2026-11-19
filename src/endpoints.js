/**
 * Provider endpoints and authentication schemes.
 *
 * FreeLLMAPI publishes a catalog of platforms but keeps the wire details in its
 * own adapter code. The table below mirrors that registry — every entry was read
 * from the upstream repository's provider registry rather than guessed — and the
 * plugin still prefers whatever a key row recorded, so a self-hosted or moved
 * gateway keeps working.
 *
 * Precedence for one route is: the key's own `base_url`, the model's published
 * `endpoint_scope`, the profile override in `endpoints`, then this table.
 *
 * Platforms that are search-only, media-only, account-scoped, or retired are
 * listed with an empty `baseUrl`. They stay visible to diagnostics and are never
 * called: a route with no endpoint is skipped instead of failing a turn.
 *
 * @module dsh-freellmapi-auto/endpoints
 */

/**
 * @typedef {object} EndpointSpec
 * @property {string} baseUrl - Chat Completions base; `{baseUrl}/chat/completions` must be valid.
 * @property {'bearer' | 'x-api-key' | 'x-goog-api-key' | 'none'} auth - how the credential travels.
 * @property {boolean} [openaiCompatible] - false when the platform is not a chat gateway at all.
 */

/** @type {Record<string, EndpointSpec>} */
export const BUILTIN_ENDPOINTS = Object.freeze({
  agnes: { baseUrl: 'https://apihub.agnes-ai.com/v1', auth: 'bearer' },
  aihorde: { baseUrl: 'https://oai.aihorde.net/v1', auth: 'bearer' },
  ainative: { baseUrl: 'https://api.ainative.studio/api/v1', auth: 'bearer' },
  aion: { baseUrl: 'https://api.aionlabs.ai/v1', auth: 'bearer' },
  airforce: { baseUrl: 'https://api.airforce/v1', auth: 'bearer' },
  anyapi: { baseUrl: 'https://api.anyapi.ai/v1', auth: 'bearer' },
  apinex: { baseUrl: 'https://api.apinex.bond/v1', auth: 'bearer' },
  bai: { baseUrl: 'https://api.b.ai/v1', auth: 'bearer' },
  bazaarlink: { baseUrl: 'https://bazaarlink.ai/api/v1', auth: 'bearer' },
  beatapi: { baseUrl: 'https://api.beatapi.io/v1', auth: 'bearer' },
  blaze: { baseUrl: 'https://api.blazeapi.org/paid/v1', auth: 'bearer' },
  blockrun: { baseUrl: 'https://api.blockrun.ai/v1', auth: 'bearer' },
  cerebras: { baseUrl: 'https://api.cerebras.ai/v1', auth: 'bearer' },
  clod: { baseUrl: 'https://api.clod.io/v1', auth: 'bearer' },
  cohere: { baseUrl: 'https://api.cohere.ai/compatibility/v1', auth: 'bearer' },
  dreamprompting: { baseUrl: 'https://dreamprompting.com/api/v1', auth: 'bearer' },
  electronhub: { baseUrl: 'https://api.electronhub.ai/v1', auth: 'bearer' },
  experiental: { baseUrl: 'https://api.experientiallabs.ai/v1', auth: 'bearer' },
  freeinference: { baseUrl: 'https://freeinference.org/v1', auth: 'bearer' },
  gizmo: { baseUrl: 'https://api.gizmoplatforms.com/api/v1', auth: 'bearer' },
  google: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', auth: 'bearer' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', auth: 'bearer' },
  huggingface: { baseUrl: 'https://router.huggingface.co/v1', auth: 'bearer' },
  inferbase: { baseUrl: 'https://api.inferbase.ai/v1', auth: 'bearer' },
  iteracompute: { baseUrl: 'https://api.iteracompute.com/v1', auth: 'bearer' },
  jamai: { baseUrl: 'https://api.jamaibase.com/api/v1', auth: 'bearer' },
  kilo: { baseUrl: 'https://api.kilo.ai/api/gateway/v1', auth: 'none' },
  kiosapi: { baseUrl: 'https://api.kiosapi.id/v1', auth: 'bearer' },
  llm7: { baseUrl: 'https://api.llm7.io/v1', auth: 'bearer' },
  logfare: { baseUrl: 'https://logfare.ai/v1', auth: 'bearer' },
  longcat: { baseUrl: 'https://api.longcat.chat/openai/v1', auth: 'bearer' },
  lucidity: { baseUrl: 'https://composite.lucidity.sh/v1', auth: 'bearer' },
  mistral: { baseUrl: 'https://api.mistral.ai/v1', auth: 'bearer' },
  modelscope: { baseUrl: 'https://api-inference.modelscope.cn/v1', auth: 'bearer' },
  moondream: { baseUrl: 'https://api.moondream.ai/v1', auth: 'bearer' },
  nabh: { baseUrl: 'https://api.nabh.cloud/v1', auth: 'bearer' },
  nara: { baseUrl: 'https://router.bynara.id/v1', auth: 'bearer' },
  navy: { baseUrl: 'https://api.navy/v1', auth: 'bearer' },
  novai: { baseUrl: 'https://aiapi-pro.com/v1', auth: 'bearer' },
  nvidia: { baseUrl: 'https://integrate.api.nvidia.com/v1', auth: 'bearer' },
  ollama: { baseUrl: 'https://ollama.com/v1', auth: 'bearer' },
  onomeo: { baseUrl: 'https://onomeo.com/v1', auth: 'bearer' },
  opencode: { baseUrl: 'https://opencode.ai/zen/v1', auth: 'bearer' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', auth: 'bearer' },
  orcarouter: { baseUrl: 'https://api.orcarouter.ai/v1', auth: 'bearer' },
  ovh: { baseUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1', auth: 'none' },
  plugsky: { baseUrl: 'https://plugsky.com/v1', auth: 'bearer' },
  pollinations: { baseUrl: 'https://gen.pollinations.ai/v1', auth: 'bearer' },
  powertokens: { baseUrl: 'https://api.powertokens.ai/v1', auth: 'bearer' },
  qianfan: { baseUrl: 'https://qianfan.baidubce.com/v2', auth: 'bearer' },
  radeon: { baseUrl: 'https://developer.amd.com.cn/radeon/api/v1', auth: 'bearer' },
  reka: { baseUrl: 'https://api.reka.ai/v1', auth: 'bearer' },
  requesty: { baseUrl: 'https://router.requesty.ai/v1', auth: 'bearer' },
  router9: { baseUrl: 'https://api.router9.com/v1', auth: 'bearer' },
  routeway: { baseUrl: 'https://api.routeway.ai/v1', auth: 'bearer' },
  sambanova: { baseUrl: 'https://api.sambanova.ai/v1', auth: 'bearer' },
  sealion: { baseUrl: 'https://api.sea-lion.ai/v1', auth: 'bearer' },
  septor: { baseUrl: 'https://api.septorlabs.com/v1', auth: 'bearer' },
  simplellm: { baseUrl: 'https://api.simplellm.eu/v1', auth: 'bearer' },
  speka: { baseUrl: 'https://speka.me/v1', auth: 'bearer' },
  together: { baseUrl: 'https://api.together.ai/v1', auth: 'bearer' },
  typhoon: { baseUrl: 'https://api.opentyphoon.ai/v1', auth: 'bearer' },
  unorouter: { baseUrl: 'https://api.unorouter.com/v1', auth: 'bearer' },
  volcengine: { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', auth: 'bearer' },
  waterfall: { baseUrl: 'https://api.getwaterfall.org/v1', auth: 'bearer' },
  xfyun: { baseUrl: 'https://spark-api-open.xf-yun.com/v1', auth: 'bearer' },
  xkiro: { baseUrl: 'https://api.xkiro.com/v1', auth: 'bearer' },
  zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', auth: 'bearer' },
  zai: { baseUrl: 'https://api.z.ai/api/paas/v4', auth: 'bearer' },

  // Present in the platform catalog, but not a Chat Completions gateway.
  cloudflare: { baseUrl: '', auth: 'bearer', openaiCompatible: false },
  github: { baseUrl: '', auth: 'bearer', openaiCompatible: false },
  sail: { baseUrl: '', auth: 'bearer', openaiCompatible: false },
  freeai: { baseUrl: '', auth: 'bearer', openaiCompatible: false },
  brave: { baseUrl: '', auth: 'bearer', openaiCompatible: false },
  tavily: { baseUrl: '', auth: 'bearer', openaiCompatible: false },
  exa: { baseUrl: '', auth: 'x-api-key', openaiCompatible: false },
  firecrawl: { baseUrl: '', auth: 'bearer', openaiCompatible: false },
  linkup: { baseUrl: '', auth: 'bearer', openaiCompatible: false },
  parallel: { baseUrl: '', auth: 'bearer', openaiCompatible: false },
  serpsearch: { baseUrl: '', auth: 'bearer', openaiCompatible: false },
  halx: { baseUrl: '', auth: 'none', openaiCompatible: false },
  aisense: { baseUrl: '', auth: 'none', openaiCompatible: false },
  keenable: { baseUrl: '', auth: 'bearer', openaiCompatible: false },
})

/**
 * Normalize a base URL: absolute http(s), no trailing slash, no query or fragment.
 * @param {unknown} value - the candidate.
 * @returns {string} the normalized URL, or an empty string when unusable.
 */
export function normalizeBaseUrl(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (trimmed === '') return ''
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    url.search = ''
    url.hash = ''
    const path = url.pathname.replace(/\/+$/, '')
    return `${url.origin}${path}`
  } catch {
    return ''
  }
}

/**
 * Build the headers that authenticate one request.
 * @param {'bearer' | 'x-api-key' | 'x-goog-api-key' | 'none' | string} auth - the scheme.
 * @param {string} apiKey - the credential; ignored by `none`.
 * @returns {Record<string, string>} the authentication headers.
 */
export function authHeaders(auth, apiKey) {
  if (auth === 'none' || apiKey === '') return {}
  if (auth === 'x-api-key') return { 'x-api-key': apiKey }
  if (auth === 'x-goog-api-key') return { 'x-goog-api-key': apiKey }
  return { authorization: `Bearer ${apiKey}` }
}

/**
 * Presentation label for one platform id.
 * @param {string} platform - the platform id.
 * @returns {string} a human-readable name.
 */
export function platformLabel(platform) {
  /** @type {Record<string, string>} */
  const names = {
    aihorde: 'AI Horde',
    bazaarlink: 'BazaarLink',
    cerebras: 'Cerebras',
    cloudflare: 'Cloudflare Workers AI',
    cohere: 'Cohere',
    electronhub: 'Electron Hub',
    github: 'GitHub Models',
    google: 'Google AI Studio',
    groq: 'Groq',
    huggingface: 'Hugging Face',
    kilo: 'Kilo Code',
    modelscope: 'ModelScope',
    nvidia: 'NVIDIA NIM',
    openrouter: 'OpenRouter',
    requesty: 'Requesty',
    routeway: 'Routeway',
    sambanova: 'SambaNova',
    together: 'Together AI',
    volcengine: 'Volcengine Ark',
    zhipu: 'Z.ai (GLM)',
  }
  return names[platform] ?? platform
}
