# Changelog

All notable product changes are recorded here. Versions follow semantic
versioning; provider attempt receipts contain the runtime product version.

## 1.1.0 - 2026-08-04

### Fixed

- Restored the conservative `text-sources.v1` Perplexity SSE request profile.
  The previous change advertised upstream UI/workflow blocks and could yield a
  fully searched thread with citations but no parsable answer body.
- Extract public URLs from a text-only completion if upstream omits its
  structured sources block.

### Added

- Product identity and API/artifact contract versions in `/health` and
  completion receipts.
- Fixture coverage for inline-source answers and product/package version drift.
- This product card and explicit release gate.

### Consumer Impact

- The `research-perplexity-direct-gateway` mat-skill must accept and persist
  `perplexity.gateway_product` in its provider artifact.
- Hermes and TradeScope routing behavior is unchanged: a typed technical
  failure still goes to the caller's bounded fallback policy.

### Rollback

- Revert `4715823` and this release as one unit only if the prior
  `workflow` protocol has a tested parser and a release artifact. Do not toggle
  request flags ad hoc in production.
