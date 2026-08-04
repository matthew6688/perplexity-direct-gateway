# Perplexity Direct Gateway Product Card

## Identity

| Field | Value |
| --- | --- |
| Product ID | `perplexity-direct-gateway` |
| Product version | `1.1.0` |
| API contract | `openai-chat-completions.v1` |
| Research artifact contract | `ai_mode_research.v1` |
| SSE protocol profile | `text-sources.v1` |
| Runtime mode | Direct local HTTP; no browser per request |

`src/product.mjs` is the runtime source of truth. `/health` and every
completion receipt expose this identity. A consumer must store it with its
provider attempt so an old result is always attributable to an exact product
release.

## What This Product Does

It converts an already authenticated Perplexity subscription session into a
bounded local OpenAI-compatible research API. It returns Chinese or English
answer text, public-source citations, the Perplexity thread URL, applied model
and usage estimate. It is source discovery only: it never writes CRM, decides
ICP, sends outreach, opens OpenCLI, or controls a foreground browser.

## Stable Contracts

1. `/health` exposes product identity, queue depth and session readiness.
2. `/v1/chat/completions` returns an OpenAI-style `choices[0].message.content`.
3. A successful research receipt preserves non-empty answer text, citations
   when available, and the Perplexity thread URL.
4. `strict_model: true` means this product never changes the requested model;
   routing and fallback are owned by the caller's versioned policy.
5. An empty upstream answer is a typed technical failure (`EMPTY_COMPLETION`),
   never a business conclusion or a candidate discard.

## Compatibility And Change Rules

| Change | Versioning | Required release evidence |
| --- | --- | --- |
| Parser bug fix with unchanged receipt shape | patch | SSE fixtures + two public-company smoke calls |
| New optional receipt fields / models | minor | fixtures, model smoke and consumer compatibility check |
| Changed endpoint, removed receipt field, or altered lifecycle | major | migration guide, consumer rollout and rollback plan |

Before a release, the change owner must identify these consumers:

- `mat-skills/skills/research-perplexity-direct-gateway`
- Hermes `hs-company-research-v2`
- TradeScope Worker provider policy and stored provider-attempt receipts

The release is not complete until each consumer either accepts the advertised
contract or is versioned and deployed with it.

## Operational Guardrails

- LaunchAgent `ai.perplexity-direct.gateway` is the only long-running runtime
  owner.
- `PERPLEXITY_DISABLE_CDP_FALLBACK=1` in production: expired sessions become a
  visible health failure rather than starting Chrome.
- One local FIFO request queue prevents subscription-session contention.
- Retries are bounded. The gateway does not retry forever or start duplicate
  processes.
- Logs contain protocol shape/count diagnostics only, never cookies or private
  prompts.

## Release Gate

1. `npm run test:sse` passes, including the installed product-version check.
2. Gateway `/health` exposes the expected product and contract versions.
3. Two serial public-company research smoke calls return non-empty text and at
   least one retained public source URL each.
4. The mat-skill adapter accepts the current receipt and stores
   `gateway_product` in its artifact.
5. `CHANGELOG.md` names the cause, user-visible impact, rollback commit, and
   affected consumers.
