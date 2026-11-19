# dsh-freellmapi-auto

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Cordis bundle
that routes model calls across the free-tier providers already configured in
[FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi).

Free tiers are not monthly quotas. They are a set of small, independent
per-minute budgets: 10 requests a minute here, 250k tokens a minute there, an 8k
context on a third route. A router that treats them as one pool spends the
fastest budget first and then stalls mid-turn. This bundle models the shape they
actually have.

- Reads the inventory FreeLLMAPI already keeps on this machine, read-only.
- Filters by context fit, per-minute token budget, tool support, and reported quota.
- Ranks by capability, coding strength, recent health, and latency.
- Fails over silently while nothing has been shown to you.
- Never touches global `ANTHROPIC_*` environment variables.

---

## Contents

- [Architecture](#architecture)
- [Routing modes](#routing-modes)
- [Installation](#installation)
- [Configuration](#configuration)
- [Authentication](#authentication)
- [Observability](#observability)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Limits](#limits)

---

## Architecture

```
                 ┌──────────────────────── DeepSeek Harness ───────────────────────┐
   model picker  │  freellmapi-auto / -large-context / -fast / -coding / -models    │
        │        └───────────────────────────────┬─────────────────────────────────┘
        ▼                                        ▼
  ┌──────────────┐   estimate   ┌──────────────────────────────┐   rank    ┌────────────┐
  │ route + model│ ───────────► │ context / TPM / tool filters │ ────────► │ candidates │
  └──────────────┘              └──────────────────────────────┘           └─────┬──────┘
                                                                                │ try in order
                     ┌──────────────────────────────────────────────────────────▼────────┐
                     │ attempt: HTTPS POST {baseUrl}/chat/completions, SSE, watchdog       │
                     └───────────────┬───────────────────────────────┬─────────────────────┘
                          first token│                               │success
                                     ▼                               ▼
                     ┌──────────────────────────────┐        ┌───────────────┐
                     │ cooldown the (platform, key) │        │ StreamChunks  │
                     │ bucket, try the next route   │        │ to the loop   │
                     └──────────────────────────────┘        └───────────────┘
```

### Inventory

The adapter reads the SQLite store the FreeLLMAPI desktop app maintains
(`<dataDir>/freeapi.db`), always with `readOnly: true`, through Node's built-in
`node:sqlite`. One sync produces an immutable snapshot:

| Table | What it contributes |
|---|---|
| `models` | enabled routes, published intelligence/speed rank, RPM/TPM/RPD/TPD, context window, tool and vision support |
| `api_keys` | enabled credentials, per-key `base_url`, health status |
| `provider_quota_state` | provider-reported remaining quota and reset time |
| `rate_limit_usage` | very recent usage, used to seed the first minute window |

A snapshot is swapped in whole, so a request that started under one configuration
never finishes under another. A sync runs at startup, when the profile asks for
one, and after a quota failure.

### Ranking

1. **Filter.** Drop routes that cannot serve this request at all: no tool calling
   when the request declares tools, published context below the estimated size,
   published TPM below the estimated size, a bucket in cooldown, an exhausted
   RPM/TPM/RPD/TPD window, or reported quota already spent.
2. **Score.** A weighted sum of capability (intelligence rank), coding strength
   (model family plus parameter count), recent health (EWMA success rate and
   time-to-first-token), and context headroom. Weights are per profile.
3. **Diversify.** Consecutive picks avoid the same physical provider, so a fast
   agent loop does not burn one gateway's RPM on near-identical aliases.
4. **Degrade.** If nothing passes the strict budget, the token filter is lifted,
   then the context filter, before the turn is allowed to fail.

### Shared-quota buckets

Every alias behind one provider account spends the same budget, so quota,
cooldown, and health are keyed by `platform + key_id`, never by model name. A
`429` on one OpenRouter alias puts that whole bucket in cooldown and rotates to a
different physical provider instead of trying a sibling alias.

### Failover pipeline

| Failure | Action |
|---|---|
| `400` context overflow | cooldown bucket, try a wider route |
| `401` / `403` | rotate; a key problem is not worth retrying the same bucket |
| `402`, `403` with quota wording, `429` with quota wording | bucket cooldown up to `cooldownMaxMs`, resync the store |
| `408`, `504` | cooldown, rotate |
| `413` payload / TPM exceeded | cooldown, rotate to a route whose budget fits |
| `500`, `502`, `503` | short cooldown, rotate |
| `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT` | short cooldown, rotate |
| empty completion | retryable: rotate and let the harness retry the step |

A failure **before any visible chunk** is retried on the next route with nothing
shown to the user. A failure **after visible output** ends the attempt with the
classified error, because replaying half an answer into a second provider would
duplicate it; the harness retry policy then re-runs the step on a different route.

### SSE watchdog

Two deadlines, both configurable:

- **Time to first token** (`firstTokenTimeoutMs`, 7s) — headers *and* the first
  frame. A provider that accepts the connection and then thinks forever is
  abandoned, and the next route is tried.
- **Stream idle** (`streamIdleTimeoutMs`, 12s) — any later gap between frames.

The SSE reader releases the body iterator with a bounded wait, so a stalled read
cannot hold the turn open even if the socket never settles.

---

## Routing modes

| Route | Selector group | Behavior |
|---|---|---|
| `freellmapi-auto` | **FreeLLMApi - Auto** | Balanced: capability, coding strength, health, latency. |
| `freellmapi-large-context` | **FreeLLMApi - Large Context** | Requires at least 64k tokens and weights context headroom heavily. |
| `freellmapi-fast` | **FreeLLMApi - Ultra Fast** | Weights speed rank, measured TTFT, and recent success. |
| `freellmapi-coding` | **FreeLLMApi - Coding & Tools** | Only routes that advertise tool calling, ranked by coding strength. |
| `freellmapi-models` | **FreeLLMApi - Models** | Individual upstream routes, pinned by `endpoint host / model id`. |

Each profile group exposes one virtual `auto` model plus the group's best pinned
routes (`pinsPerRoute`). The `models` group lists `modelsRouteSize` pinned routes.

Selecting a pinned route disables routing for that turn: the request goes to that
exact upstream model, which is what you want when the router's choice is not the
one you need.

---

## Installation

### From the plugin market

Add this repository's index as a custom plugin source, then install from
**Plugins → Discover**:

```
https://raw.githubusercontent.com/luciomerlo/dsh-freellmapi-auto/main/index.json
```

To add it from a shell:

```sh
dsh plugin market set-indexes \
  "https://raw.githubusercontent.com/luciomerlo/dsh-freellmapi-auto/main/index.json"
```

`index.json` is a format-1 plugin market index; each version pins an exact commit
of this repository.

### Manual local install

```sh
git clone https://github.com/luciomerlo/dsh-freellmapi-auto.git
cd dsh-freellmapi-auto
node --test        # 60 tests, no network access required
```

Then point the Harness at the directory:

```sh
dsh plugin install /absolute/path/to/dsh-freellmapi-auto
```

Or install it from **Plugins → Add plugin** with the directory path.

Either way, follow with a restart if the Harness reports `restart-required`, and
pick a **FreeLLMApi** group in the model selector.

### Requirements

- DeepSeek Harness with the `llm` service (every shipped profile).
- Node 22.5+ for `node:sqlite`.
- A FreeLLMAPI installation with at least one enabled key, or `dataDir` pointing
  at a store somewhere else.

---

## Configuration

The loader row is `freellmapi-auto`; its defaults ship in `cordis.patch.yml`.
Override any key from the profile's `cordis.patch.yml`:

```yaml
- id: freellmapi-auto
  config:
    dataDir: '/srv/freellmapi'
    maxAttempts: 8
    firstTokenTimeoutMs: 5000
    autoContextWindow: 262144
    endpoints:
      my-gateway:
        baseUrl: 'https://gateway.example/v1'
        auth: bearer
```

| Key | Default | Meaning |
|---|---|---|
| `dataDir` | resolved | Directory holding `freeapi.db` and `.encryption-key`. |
| `syncOnStart` | `true` | Read the inventory during activation. |
| `syncOnQuotaError` | `true` | Re-read the store after a quota or throttle failure. |
| `minSyncIntervalMs` | `30000` | Minimum gap between store reads while serving. |
| `autoModelName` | `Auto (FreeLLMApi)` | Selector name of the Auto model. |
| `maxAttempts` | `6` | Provider attempts per turn, including the first. |
| `harnessMaxRetries` | `1` | Harness retries for post-output failures. |
| `requestTimeoutMs` | `180000` | Whole-attempt HTTP deadline. |
| `firstTokenTimeoutMs` | `7000` | Time-to-first-token watchdog. |
| `streamIdleTimeoutMs` | `12000` | Mid-stream freeze watchdog. |
| `tokensPerCharacter` | `0.25` | Estimator density. |
| `requestTokenMargin` | `512` | Safety margin added to every estimate. |
| `defaultContextWindow` | `131072` | Capacity assumed when a route publishes none. |
| `autoContextWindow` | `131072` | Capacity the virtual model reports; drives compaction. |
| `defaultMaxOutputTokens` | `8192` | Output cap when the request names none. |
| `codingWeight` and friends | `1` | Multipliers on the per-profile weights. |
| `diversityWindow` | `2` | How many previous picks a provider must not repeat. |
| `degradeToSmallModels` | `true` | Allow the relaxed pass that reaches small models. |
| `respectReportedQuota` | `true` | Skip buckets whose reported quota is spent. |
| `seedUsageWindowMs` | `60000` | Seed the first minute window from the store. |
| `includeUsage` | `false` | Ask gateways to report usage in-stream. |
| `cooldownBaseMs` / `cooldownMaxMs` | `20000` / `900000` | Cooldown floor and ceiling. |
| `pinsPerRoute` | `4` | Pinned routes listed in each profile group. |
| `modelsRouteSize` | `48` | Size of the `FreeLLMApi - Models` group. |
| `endpoints` | `{}` | Extra `{ platform: { baseUrl, auth } }` entries. |

`dataDir` resolution order: the configured value, `FREELMAPI_HOME`, the platform
user-data directory, then `~/.freellmapi`.

---

## Authentication

The bundle does not ask for API keys. It uses the ones FreeLLMAPI already stored:
each row is AES-256-GCM encrypted under `<dataDir>/.encryption-key`, decrypted in
this process at first use, cached in memory, and never logged, returned by an HTTP
route, or written anywhere.

Consequences worth knowing:

- Add or rotate keys in FreeLLMAPI, then press **Resync inventory** (or restart the
  Harness). The decryption cache is per process.
- If a key cannot be decrypted, its routes are skipped with a warning rather than
  failing a turn.
- Keyless gateways (Kilo, OVH, a local Ollama endpoint) work through their
  published `auth: none` and need no key row.

Global environment variables are never read or written by this plugin. Nothing
here can break a native Claude CLI installation on the same machine.

---

## Observability

Two same-origin HTTP routes:

- `GET /freellmapi-auto/status` — counters, reachable route count, per-bucket
  cooldowns, and the last turns.
- `POST /freellmapi-auto/sync` — re-read the store now.

The composer dock shows the same data live: the physical route that answered
(`cerebras → qwen-3-coder`), estimated tokens against that route's TPM cap, the
silent-fallback counter, and every bucket in cooldown with its remaining time.

Logs are one line per handoff:

```
freellmapi: groq -> llama-3.3-70b-versatile failed (RATE_LIMIT); switching to cerebras -> qwen-3-coder
```

---

## Troubleshooting

**The group is selectable but every turn fails with `NO_MODEL_AVAILABLE`.**
No store was read. Check the path in the status route (`inventory.dbPath`) and the
warnings it lists. On Windows the default is `%APPDATA%\freellmapi`.

**`NO_MODEL_AVAILABLE` names `filtered out: 6000 context`-style counts.**
The request is larger than every enabled route's published context. Raise
`autoContextWindow` only if the routes really can hold it; otherwise reduce the
request (compaction, smaller tool set).

**Turns land on small models unexpectedly.**
Either every large route is cooling down, or `degradeToSmallModels` lifted the
token filter. The status route shows the refusal counts per turn.

**A route is never used even though it has a key.**
Either its platform is account-scoped, search-only, or retired (the endpoint table
ships these with no base URL), or its `baseUrl` could not be resolved. Add an
`endpoints` entry for that platform.

**`AUTH` cooldowns pile up.**
The stored key is rejected upstream. Re-check it in FreeLLMAPI; a rejected key
cools its bucket for `cooldownMaxMs`.

---

## Development

```sh
npm test        # unit tests (node:test)
npm run check   # manifests, resources, secrets, syntax
npm run index   # regenerate index.json for the current commit
```

The plugin imports nothing from `@deepseek-ai/*`. The `llm` service validates an
adapter through `providerInfo` and `providerRetryPolicy`, so a plain object
satisfies the contract and the bundle cannot bind to the wrong harness build.

Layout:

```
index.js              activation, config validation, HTTP routes
src/adapter.js        adapter contract, plan execution, failover loop
src/inventory.js      read-only FreeLLMAPI store reader
src/buckets.js        quota windows, cooldowns, EWMA health
src/ranking.js        filters, scoring, diversity, profiles
src/payload.js        harness messages -> Chat Completions
src/transport.js      HTTP, error classification, body decoding
src/stream.js         SSE frames -> harness StreamChunks
src/sse.js            SSE decoding and the two watchdogs
src/tokens.js         request-size estimation
src/telemetry.js      bounded, credential-free status buffer
client.js             composer dock status cell
```

---

## Limits

- **Text only.** Image and file blocks are projected as short markers.
- **Reasoning is not replayed** to upstream providers.
- **No proxy dependency.** The bundle talks to providers directly; it does not
  start or route through the FreeLLMAPI desktop app.
- **In-memory cooldowns.** Restarting clears them; the store's reported quota is
  still respected.
- **Published limits only.** A route that publishes no TPM or context is assumed
  to fit `defaultContextWindow` and to have no token cap.

---

## License

MIT. See [LICENSE](LICENSE).
