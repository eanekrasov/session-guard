# ODD Task Tracker: Fix Smoke Default Provider Selection

## Objective

Make host smoke retain the provider selected by an explicit or configured default model, using the
provider name and compound model identifier rather than provider-map key order.

## Problem

The isolated OpenCode V1 smoke configuration can omit the provider required by a configured default
model such as `crpt/deepseek-ai/DeepSeek-V4-Flash-small`. The current filter recognizes only the
whole compound ID or final model segment as a configured model key, while a provider may use a
host-supported alias or upstream identifier.

## Why This Work Unit

Host smoke must faithfully reproduce the operator-selected model without retaining arbitrary
providers or silently selecting another model. A real provider-model lookup currently fails before
the smoke scenario can execute.

## Scope

- Characterize the generated isolated configuration at the production transformation seam.
- Cover legacy `provider` and modern `providers` together with a compound model identifier.
- Implement the smallest deterministic provider/model matching rule for OpenCode V1 smoke.
- Preserve provider metadata and remove unrelated providers.
- Update host-smoke documentation only if the verified config flow requires it.

## Constraints

- `HOST_SMOKE_MODEL` takes precedence over top-level operator-config `model`.
- Never fall back to an arbitrary provider or model.
- Keep the missing-model error explicit.
- Apply only verified OpenCode V1 behavior; do not migrate smoke to V2 semantics.
- Do not expose credentials or secret configuration.
- Keep technical artifacts in English.

## Stable Task IDs

- [x] HSDP-001 Inspect the real isolated-config transformation and identify the V1 model/provider
      naming mismatch using a non-secret fixture.
- [x] HSDP-002 Add a focused red regression at the transformation seam covering both provider maps,
      a compound model ID, preserved metadata, and removal of unrelated providers.
- [x] HSDP-003 Implement deterministic matching for the selected model and provider.
- [x] HSDP-004 Run focused host-smoke harness tests red then green.
- [x] HSDP-005 Run `mise run check`, `mise run build`, and `git diff --check`.
- [x] HSDP-006 Run `HOST_SMOKE_DEBUG=1 mise run smoke plugin-loads` once and redact its result.
- [x] HSDP-007 Review the final scope and commit the session-owned work unit through GitButler.

## Acceptance Criteria

1. A selected explicit or configured model retains its intended provider by provider name and model
   ID regardless of map key order.
2. Both `provider` and `providers` are filtered independently in the generated isolated config.
3. The intended provider keeps all required metadata and unrelated providers are absent.
4. `HOST_SMOKE_MODEL` precedence and the clear missing-model error are preserved.
5. No arbitrary model fallback exists.
6. The focused regression fails before the implementation and passes after it.

## Checks

```bash
bun test test/app/host-smoke-harness.test.ts
mise run check
mise run build
git diff --check
HOST_SMOKE_DEBUG=1 mise run smoke plugin-loads
```

## Advisory Forecast

| Field                    | Forecast                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| Expected authored change | Under 150 lines across harness, focused test, tracker, and possible README correction         |
| Review risk              | V1 configuration alias semantics must be demonstrated from real generated output, not assumed |
| Delivery strategy        | One cohesive fix with a single conventional commit                                            |
| Escalation trigger       | Matching requires a broad host-version migration or a model-specific compatibility table      |

## Progress

- Status: verification complete; smoke remains externally blocked after host startup.
- Completed: task tracking created; CodeGraph context, governing documentation, and existing harness
  tests reviewed.
- Completed: HSDP-001 through HSDP-004. The fixture reproduces the selected V1 model
  `crpt/deepseek-ai/DeepSeek-V4-Flash-small` with provider key `crpt` and model key
  `deepseek-ai/DeepSeek-V4-Flash-small`; the prior implementation returned no provider.
- Completed: HSDP-005 and HSDP-006. `mise run check` passed (1,821 tests, 3,958 expectations);
  `mise run build` passed; `git diff --check` passed.
- Completed: HSDP-007 scope review found only the provider-selection helper, its production-seam
  regression, the accurate host-smoke documentation correction, and this tracker.
- Blockers: the required single debug smoke invocation reached OpenCode V1 1.18.32 startup with the
  selected `crpt/deepseek-ai/DeepSeek-V4-Flash-small`, then `POST /session` returned HTTP 401. The
  host explicitly logged that V1 omits native `providers`; this is a credentials/host-compatibility
  blocker after the targeted provider-selection transformation, not grounds to select another model.

## Evidence Log

- Current CodeGraph flow: `defaultModel` → `operatorProviders` → `filterProviders` →
  `providerContainsModel`.
- The generated config applies `filterProviders` independently to legacy `provider` and modern
  `providers` before serializing the isolated `opencode.json`.
- The regression was red: the prior helper did not match the V1 provider key `crpt` plus upstream
  model ID `deepseek-ai/DeepSeek-V4-Flash-small`, returning `{}`. It is green after matching the
  compound model's first segment to the provider key and the remainder by its full upstream ID or
  final host-supported alias.
- The smoke host is OpenCode CLI V1 1.18.32; V2 package support in this repository is not evidence
  for V1 host configuration behavior.
- The exact one-time smoke command was `HOST_SMOKE_DEBUG=1 mise run smoke plugin-loads`; it reported
  the expected model, loaded the plugin, and stopped at `POST /session → 401`. No credentials or
  provider secrets were written to the tracker.

## Next Step

Investigate the independent 401/legacy `providers` compatibility only as a separate authorized task.
