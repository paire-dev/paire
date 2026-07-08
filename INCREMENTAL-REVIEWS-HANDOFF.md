# Handoff — Incremental Reviews Investigation

> **Temporary file — will be removed later.** Purpose: hand off an in-progress design
> investigation to another agent so it can continue where we left off. Read this first,
> then the detailed notes in [`docs/incremental-reviews-brainstorm.md`](docs/incremental-reviews-brainstorm.md).

## What we're investigating

Moving paire from full re-reviews to **incremental reviews**: each run reuses the prior review
state plus what changed, instead of recomputing from scratch. Three problems drive it:

1. **Speed** — reviews are slow (~2–3 min small PRs, 10–15 min large); per-claim adds since PR #14 added latency.
2. **Stale evidence** — carried "unchanged" claims keep old line numbers that drift as code moves. This is [issue #17](https://github.com/paire-dev/paire/issues/17).
3. **Multi-user consistency** — versions are used for navigation; a reviewer who saw v10 must see *what's new* at v11 while everything they already read stays byte-consistent (no silent rewording).

Full detail (design, tiers, invariants, rationale) lives in `docs/incremental-reviews-brainstorm.md`. This file is just the orientation + state + next steps.

## Decisions reached so far

- **Deterministic evidence remap (§A)** is the linchpin. Replace agent-declared `evidence_moved` with CLI-computed re-anchoring in tiers; only the last costs a model call:
  - Tier 1 — line-shift via existing `annotateHunkText` old→new map. **Ship live.**
  - Tier 2 — fingerprint (content-hash) re-anchor for relocated blocks, **unique match only**. **Build in shadow mode** (log what it would do, don't apply) until logs prove it trustworthy.
  - Tier 3 — enclosing-symbol re-anchor. **Deferred** (needs per-language parsing / tree-sitter).
  - Tier 4 — model re-eval; where genuine change / amend / supersede is decided.
  - `fingerprint` and `symbol` fields **already exist** on `ReviewEvidenceState` but are unused — populate them now to avoid a cold start.
- **Persistence (§B)** — retrieval is already fast (full state per review row). Do **not** build a per-version `{carried}` vs `{new}` split. Add per-claim provenance (`introducedInVersion`, `lastModifiedInVersion`, `supersededInVersion`); "what's new" is a filter. Line numbers become a derived cache.
- **Rebase/force-push (§C)** — v1 rule keyed on "**did the base move?**": clean append → incremental; base-unchanged rewrite (amend/reword/reorder/in-branch squash) → still incremental; base moved (true rebase) → full re-review. Lets v1 defer baseline-content storage. Version = review-run ordinal, never commit count; reviewer position keyed on version+claimID, never SHA.
- **Consistency (§D)** — two enforced invariants: verbatim carry (reject text drift on `unchanged` claims in `apply-validation.ts`) + explicit transitions (amend/supersede snapshot prior text). `humanStatus` reset-on-change is the per-reviewer "what's new" signal.
- **Concurrency (§E)** — v1: single-flight per branch + idempotency by `(chain, currentCommit)` (prevents forked chains); stale-HEAD handled by recording exact HEAD + enqueue-follow-up; keep version writes atomic. Multi-user `humanStatus`-overlay deferred (note only) until the review page lands.
- **Secondary concerns (decided):** target-branch semantics → pin to recomputed merge-base per run (remote target advance doesn't affect review; rebase/merge does, via §C); no-op/empty versions → don't bother in v1 (harmless until range-nav UI exists); renames → accepted limitation in v1 (claims regenerate, not silently dropped).
- **Scope limit (important):** none of this speeds up the **first review** of a PR (cold start — everything is new). First-pass speed is a separate track — and since **paire has no LLM** (the external agent does all model work), most levers (parallelism, triage, caching) aren't paire's; paire-owns = batch claim submission, leaner context, progressive surfacing, shard/merge seams.

## Codebase orientation (key files)

- `src/cli/review-state.ts` — canonical types: `ReviewState`, `ReviewClaimState`, `ReviewClaimRevision`, `ReviewEvidenceState` (line ~87-96, has unused `symbol?`/`fingerprint?`), `ReviewEvent` (append-only log).
- `src/cli/local-engine.ts` — persistence (`persistReviewState` ~1233-1288, full state as JSON per row), version chaining (`carryForwardClaims` ~1168, `sourceReviewId`).
- `src/cli/diff-line-numbers.ts` — `annotateHunkText` produces per-line `oldLine`/`newLine` (the map tier-1 remap consumes; today only `addedLineRanges()` is used).
- `src/cli/apply-validation.ts` — agent-facing status enum (`new|unchanged|evidence_moved|amended|invalidated|superseded`) + validation (where the verbatim-carry rule would go).

## Open questions to continue on

- **`revisionId` discrepancy** — issue #17 says evidence stores a `revisionId` hook, but the live `ReviewEvidenceState` shows only `symbol?`/`fingerprint?`. Confirm where revision identity actually lives before building remap. **(resolve first)**
- **Fingerprint design** — hash exact bytes vs. whitespace-normalized; evidence-only span vs. with-context. Affects tier-2 hit rate + collision rate.
- **Diff/base semantics** — verify paire diffs against a **recomputed merge-base** (three-dot), not a frozen `baseCommit` SHA (underpins the target-branch decision + §C).

(Concurrency, no-op versions, renames, and target-branch drift are now *decided* — see "Secondary concerns (decided)" above and the main doc. First-review speed is a separate track, also above.)

## Suggested next steps for the continuing agent

1. Resolve the `revisionId` question (read `review-state.ts` + how evidence is created/consumed).
2. Prototype **tier-1 remap**: consume `annotateHunkText`'s old→new map to shift carried evidence spans; wire tier-1 misses to the model (tier 4).
3. Add fingerprint/symbol population at claim-add time (no consumption yet).
4. Spec the **provenance fields** + the `unchanged`-text validation rule.
5. Then: tier-2 shadow mode, rebase v1 rule, consistency surfacing via `humanStatus`.

Refer back to `docs/incremental-reviews-brainstorm.md` §A–§E for the reasoning behind each.
