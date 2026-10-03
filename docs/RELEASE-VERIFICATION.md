# Demo Verification

Security update: October 3, 2026. This document distinguishes the hosted private
runtime from this intentionally redacted public source snapshot.

Subsequent configuration update: the operator authorized re-enabling paid
processing and raising the total allowance to USD30 without resetting spending
or reservations. The paused-budget figures below are the earlier verification
snapshot; the app displays current availability and remaining allowance. This
configuration change alone does not generate a new report or paid call.

## Hosted Runtime

- Existing-data backend readiness checks: **93/93 passed**.
- Both legacy audio download tokens were removed. Old bearer links failed;
  authenticated playback returned the original bytes. Audio generations and
  unrelated metadata were unchanged. All 13 stored audio objects are token-free.
- The temporary two-object metadata-update permission was removed immediately.
- Existing examples: 13 completed calls, including 11 eligible final feedback
  records and two short calls. The reconstructed portfolio has ten calls during
  September 21-27, 2026. Daily and weekly PDFs use stored results.
- Processing remains operator-paused. Budget is unchanged: USD14.966271 spent,
  no outstanding reservations, approximately USD10.03 remaining. This update
  did not run paid transcription, analysis, or portfolio generation.
- A fresh upload smoke test and the paid portfolio pattern report are not
  represented as completed by these read-only verification results.

## Dependency and Authorization Validation

The private runtime dependency update passed 517 backend unit tests, 221 frontend
Node tests, 12 frontend Jest tests, 45 authorization emulator checks, 22 password
access scenarios, and 17 seed tests. The subsequent reference-redaction update
adds two frontend checks. Backend/frontend builds, lint, and demo-target checks
passed; existing lint and bundle-size warnings remain.

Fresh full and production-only dependency audits report **zero known advisories**
for both npm projects. Ten focused dependency regression/compatibility checks passed, including
malformed multipart input, UUID bounds, and gRPC error handling. This is not a
claim of an exhaustive security assessment. See [dependency notes](DEPENDENCY-REVIEW.md).

## Public Source Checks

Private prompts, evaluation constants, reference tables, and associated policy
fixtures are removed or replaced with explicit unavailable placeholders.
Orchestration remains visible, but a public checkout cannot build/deploy a working
analysis backend without separately supplied compatible private policy assets.
The build guard intentionally fails rather than silently using invented rules.

The publication gate compares the export against an external private fingerprint
manifest; the manifest itself must never be committed. A matching renamed private
asset is also rejected. This check complements, not replaces, a secrets and
Git-history review. The public repository starts with a clean root commit and
does not share the private repository's earlier commits.

Useful local checks (Node.js 22):

```sh
npm --prefix web ci
npm --prefix web/functions ci
node --test scripts/publication.test.mjs web/src/lib/rubricV2Descriptions.test.mjs
npm --prefix web run lint
npm --prefix web run build:demo
npm --prefix web run verify:demo
npm --prefix web audit --omit=dev
npm --prefix web/functions audit --omit=dev
npm --prefix web audit
npm --prefix web/functions audit
git diff --check
```

These commands do not deploy, send email, or perform paid model calls. Do not run
private-policy scoring tests against redacted stubs and interpret them as grading
validation. The hosted demo uses the separately maintained private runtime.
