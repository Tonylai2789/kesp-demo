# Public Source and Redactions

This repository is a clean, redacted source snapshot of the isolated demo.
It is not a fork carrying the private repository's Git object history.

## Info Redacted

- Evaluation prompt bodies, including historical prompt versions.
- Bank-specific criterion descriptions, scoring weights, policy thresholds,
  credit-repair rules, and criterion-specific evidence heuristics.
- Tests that reproduce those private policy rules.
- Production release inventories and operational provenance artifacts.

Visible types, task identifiers, version contracts, authentication, budget and
rate-limit controls, queue orchestration, state handling, generic output guards,
report plumbing, and UI rendering illustrate the engineering without publishing
the private policy. Redaction placeholders are not functional grading assets.

The hosted analyzer uses an authorized private server bundle. A public checkout
cannot reproduce its analysis behavior without compatible private assets.
Missing-policy checks deliberately block backend build/deployment; they must not
be bypassed or replaced with invented weights to make a demo appear functional.

Frontend reference-policy descriptions are redacted rather than packed into
public browser JavaScript. Existing permitted call results remain displayable;
that does not give reviewers the original prompt files.

## What Is Not Included

No original customer audio, source-to-demo identity mapping, provider keys,
reviewer password, database export, compiled server bundle, or old Git history is
included. Reconstructed examples live in the protected demo project, not Git.
Public Firebase web configuration identifies the demo project; it is not an
administrator credential and does not replace authorization rules.

The historical private repository and a restricted backup remain private. New
public commits must not import that history or add a private runtime overlay.
Review both source and generated browser assets before publishing future changes.
