# KESP Public Demo Source

- This is a clean redacted source release, not the private deployment checkout.
- Read README.md and docs/PUBLIC-SOURCE.md before making changes.
- Keep bank prompts, rubric-policy assets, operational inventories, credentials,
  original recordings and source-to-demo mappings out of this repository/history.
- Never replace redacted policy with invented grading rules or silently bypass
  missing-private-asset checks. The public source is intentionally incomplete
  for analysis deployment; document that boundary honestly.
- Preserve demo-only Firebase targeting, authorization, forced masking,
  transactional provider allowance, bounded retries and API limits.
- No production/testing mutations, bank ingestion, outbound email, scheduled
  paid work, public signup, or client-accessible budget/permission bypasses.
- Do not put the reviewer password in README, commits, or test fixtures.
- Never merge the private repository's history into the public release.
- Keep public build artifacts free of private policy even when a developer has
  access to the private runtime. Do not commit compiled server or browser assets.
