# FreeLLMAPI Auto

Free-tier model pools are not linear quotas. They are a set of small, independent
per-minute budgets: 10 requests a minute on one gateway, 250k tokens a minute on
another, an 8k context on a third. A router that treats them as one big pool
spends the fastest budget first and then stalls mid-turn.

This plugin makes DeepSeek Harness aware of that shape. It reads the inventory
FreeLLMAPI already keeps on the machine — no second configuration, no duplicate
key list — and routes each turn to a route that can actually serve it.

## What it adds

Five provider groups in the model selector:

| Group | What it does |
|---|---|
| **FreeLLMApi - Auto** | Balanced: frontier capability, coding and tool strength, recent health, latency. |
| **FreeLLMApi - Large Context** | Prefers the widest context windows; requires at least 64k tokens of capacity. |
| **FreeLLMApi - Ultra Fast** | Prefers low time-to-first-token and high recent success over raw capability. |
| **FreeLLMApi - Coding & Tools** | Only routes that advertise tool calling, ranked by coding strength. |
| **FreeLLMApi - Models** | Individual upstream routes, pinned by endpoint host and model id. |

Every group exposes one virtual model, `Auto`, plus the group's best pinned
routes, so an exact upstream model is one click away when the router's choice is
not what you want.

## How a turn is routed

1. **Estimate.** The request — history, system prompt, tool schemas, and image or
   file markers — is sized before anything is sent.
2. **Filter.** A route is dropped when it lacks tool calling for a tool-using
   turn, when its published context is smaller than the request, when its
   published TPM is smaller than the request, when its quota bucket is cooling
   down, or when its RPM/TPM window for this process is already spent.
3. **Score.** Capability (intelligence rank), coding strength (family and
   parameter count), recent EWMA success rate and time-to-first-token, and context
   headroom, weighted per profile.
4. **Diversify.** Consecutive picks avoid the same physical provider, so a fast
   agent loop does not burn one gateway's RPM on near-identical aliases.
5. **Attempt and fail over.** Up to six routes, silently, while nothing has been
   shown to you.

Quota, cooldown, and health state are keyed by the physical
`platform + API key`, never by model name. Two OpenRouter aliases share one
budget, and the router knows it.

## Two watchdogs

- **First token** (`firstTokenTimeoutMs`, 7s): a provider that accepts the
  connection but never starts answering is abandoned and the next route is tried.
  Nothing has been displayed, so this handoff is invisible.
- **Stream idle** (`streamIdleTimeoutMs`, 12s): a stream that goes quiet
  mid-answer is aborted. If no visible text was emitted, the handoff is still
  invisible. If text was already on screen, the attempt ends with a classified
  error and the harness retries the step on a different route, because replaying
  half an answer into a second provider would duplicate it.

## What it never does

- It does not write to the FreeLLMAPI database. Every read is `readOnly`.
- It does not modify the process environment. No `ANTHROPIC_BASE_URL`,
  `ANTHROPIC_AUTH_TOKEN`, or similar variable is set, read, or persisted, so a
  native Claude CLI installation on the same machine is unaffected.
- It does not print or transmit credentials. Telemetry carries platform names,
  model ids, token counts, and error codes only.

## Requirements

- DeepSeek Harness with the `llm` service (every shipped profile).
- Node 22.5 or newer, for `node:sqlite`.
- A FreeLLMAPI installation with at least one enabled key, or a store directory
  you point at with `dataDir`.

## Configuration

See the profile patch row for the full list. The useful ones:

| Key | Default | Meaning |
|---|---|---|
| `dataDir` | resolved | Directory holding `freeapi.db` and `.encryption-key`. |
| `maxAttempts` | `6` | Provider attempts per turn, including the first. |
| `firstTokenTimeoutMs` | `7000` | Time-to-first-token watchdog. |
| `streamIdleTimeoutMs` | `12000` | Mid-stream freeze watchdog. |
| `autoContextWindow` | `131072` | Context the virtual model reports, which drives compaction. |
| `respectReportedQuota` | `true` | Skip routes whose reported remaining quota is spent. |
| `endpoints` | `{}` | Extra `{ platform: { baseUrl, auth } }` entries. |

## Status surface

The plugin owns four same-origin HTTP routes:

- `GET /freellmapi-auto/status` — counters, reachable routes, per-bucket
  cooldowns, and the last turns.
- `POST /freellmapi-auto/sync` — re-read the store now.
- `GET` / `PUT /freellmapi-auto/settings` — the connection state.
- `POST /freellmapi-auto/detect` — probe the local free ports for a proxy.

## Settings → FreeLLMAPI

One settings page, and nothing in the conversation. It picks the transport
(direct providers, or the FreeLLMAPI proxy), sets the proxy host and port, detects
a live proxy on the local ports, and saves through the profile's config editor.
Port `0` means autodetect: the app's own `config.json` port first, then 31415,
3000, 8000, 8080, 5000, and 11434. Detection calls `GET /v1/models` with the store's
unified token, so a detected proxy is one that is running and accepts the token.

The status route reports the active physical route, estimated tokens against that
route's TPM, the silent-fallback counter, and every bucket in cooldown with its
remaining time. The plugin's only UI is the Settings page above; it adds nothing
to the conversation.

## Limits worth knowing

- Text only. Image and file blocks are projected as short markers, so a
  vision-capable route is not used for its vision.
- Reasoning blocks are never sent back to providers.
- Direct routing calls each provider itself; the proxy transport hands one request
  to the FreeLLMAPI app instead. Neither mode starts the app.
- In proxy mode the plugin exposes one virtual model; per-provider routing and
  cooldown are the app's, not this plugin's.
- Endpoints are shipped from the upstream registry; a platform whose endpoint is
  account-scoped, search-only, or retired is listed but never called.
- Cooldown state is in memory, so restarting DSH resets it. The store's own
  recorded quota is still respected.
