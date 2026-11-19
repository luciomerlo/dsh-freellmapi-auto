/**
 * Public application identity sent to upstream providers.
 *
 * A provider request that cannot be attributed is one suspension away from
 * looking like abuse, so every call carries the same user agent. The values are
 * public product facts: no paths, session ids, credentials, or prompt text.
 *
 * The version is checked against `package.json` by `scripts/check.mjs`.
 *
 * @module dsh-freellmapi-auto/identity
 */

/** This plugin's version. */
export const PLUGIN_VERSION = '1.0.0'

/** The harness product this plugin extends. */
export const HARNESS_PRODUCT = 'deepseek-harness'

/** Upstream product home, used as the user-agent comment. */
export const HARNESS_URL = 'https://github.com/deepseek-ai/deepseek-harness'

/**
 * The `User-Agent` every provider request carries.
 * @param {string} [profile] - active DSH profile name, appended as a product token.
 * @returns {string} the user-agent value.
 */
export function userAgent(profile = process.env.DSH_PROFILE ?? '') {
  const suffix = profile === '' ? '' : ` dsh-profile/${encodeToken(profile)}`
  return `${HARNESS_PRODUCT}/unknown (+${HARNESS_URL}) dsh-freellmapi-auto/${PLUGIN_VERSION}${suffix}`
}

/**
 * Percent-encode the bytes of a profile name that are not RFC 9110 tchar.
 * @param {string} value - the profile name.
 * @returns {string} a product-token-safe string.
 */
export function encodeToken(value) {
  return value.replace(/[^A-Za-z0-9!#$%&'*+.^_`|~-]/gu, (character) => {
    const bytes = Buffer.from(character, 'utf8')
    return [...bytes].map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join('')
  })
}
