# Incremental Reviews — Brainstorm & Design Notes

> Working notes on moving paire to incremental reviews — where each run reuses the prior
> review state plus what changed, instead of recomputing from scratch. Captures the blindspots
> found and the design decisions reached, with pointers into the current codebase.

## Problems we're solving

1. **Speed** — reviews are slow (~2–3 min small PRs, 10–15 min large ones); adding claims one-by-one (since PR #14) added latency.
2. **Stale evidence** — a carried-over "unchanged" claim keeps its old evidence line numbers, which drift as the code moves. Tracked as [issue #17](https://github.com/paire-dev/paire/issues/17) ("Evidence line numbers go stale as branch evolves").
3. **Multi-user consistency** — versions are used for navigation. A reviewer who saw a PR at v10 must, at v11, be able to see *what's new* while everything they already read stays **consistent** (claims not silently reworded when their meaning is unchanged).

These are three *separate* goals. Incrementality alone does not guarantee speed (re-evaluating claims can add model round-trips); it clearly helps staleness and consistency. Speed only improves if the model is fed strictly less (the delta) and carried claims are re-validated **deterministically**.

**Scope caveat — first reviews stay slow.** Everything below only helps the *second review onward*: carry-forward, remap, and provenance all need a prior state to reuse. The **first review of a large PR is a cold start** — every file/hunk is new, so every claim is model-generated from scratch, and none of the remap tiers apply. Speeding up the first pass is a *separate* problem with its own levers (parallelism across files, cheap-model triage then escalate, batching claim submission to recover some of PR #14's per-claim latency, prompt-caching the diff context across calls). Out of scope for these notes, but tracked in "Secondary concerns" so it isn't mistaken for solved.

## What paire already has (don't rebuild)

- **Version chaining** via `sourceReviewId` + `carryForwardClaims()` — `src/cli/local-engine.ts:1168`. New reviews already inherit active claims from the prior finalized one.
- **Append-only event log** `ReviewEvent` — `src/cli/review-state.ts:98`; **immutable per-edit snapshots** `ReviewClaimRevision` — `review-state.ts:77-85`.
- **Full accumulated state stored per review row** as one JSON blob (`stateJson`, `persistReviewState` in `local-engine.ts:1233-1288`) → a single-row read already gives fast retrieval.
- **Status taxonomy** the agent already declares: `new | unchanged | evidence_moved | amended | invalidated | superseded` — `apply-validation.ts:1`; plus `lifecycleStatus` (active/invalidated/superseded) and `humanStatus` (unreviewed/accepted).
- **Evidence** = `{filePath, startLine, endLine, change, symbol?, fingerprint?}` on post-change HEAD lines — `review-state.ts:87-96`. `symbol`/`fingerprint` are currently unused.
- **Diff line-mapping engine already exists**: `annotateHunkText` in `src/cli/diff-line-numbers.ts` produces per-line `oldLine`/`newLine` — the exact old→new map needed for evidence remap. Today only `addedLineRanges()` is harvested from it.

---

_Sections are ordered by priority, highest first._

## A. Deterministic evidence remap (the linchpin)

**Targets:** #2 (stale evidence) primarily; also #1 (fewer model calls) and #3 (no silent reword).

Move evidence-shift from an **agent-declared** status (`evidence_moved`) to **CLI-computed** remap, consuming the `oldLine→newLine` map `annotateHunkText` already produces. Tiered — only the last tier costs a model call:

1. **Line-shift** (deterministic) — span sits in an unchanged region; shift by hunk delta. Dominant case (unrelated churn, reformatting/prettier). Free, and wording never changes.
2. **Fingerprint re-anchor** (deterministic) — relocated block; **unique** fingerprint match only, else fall through. (Guards against false-match misanchoring, which would be a *consistency violation* worse than staleness.)
3. **Symbol re-anchor** (deterministic, coarse) — enclosing symbol survives; clamp evidence to it.
4. **Model re-eval** — only when the anchored content itself changed semantically, or 1–3 fail (deleted file, vanished symbol). Also where amend/supersede is decided.

**What the fingerprint is (tier 2):** a content hash of an evidence span's anchored lines (optionally plus a little surrounding context), recorded when the claim is written. It's a *stable identity* for the code the claim points at, independent of line numbers — so when a block is moved or restructured, tier 2 searches the new file(s) for the block whose content hashes to the same value and re-anchors to it. The `fingerprint` field **already exists** on `ReviewEvidenceState` (`review-state.ts:87-96`) but is currently **unpopulated and unread** — so this is "wire up + backfill," not "add a new field." Two choices to settle when populating it: (a) hash *exact bytes* (stricter; a reformat breaks the match — fine, since tier 1 already handles reformat-in-place) vs. *normalized* whitespace (survives reformatting but raises collision risk); (b) span the evidence lines only vs. evidence + a few context lines (more context → more unique → fewer ambiguous matches).

**What symbol re-anchor is (tier 3):** the coarse fallback when the fingerprint no longer matches (the block's own content changed) but the *enclosing symbol* — the function/method/class/type the evidence lived inside — still exists in the new file. Instead of a precise line remap, you locate that symbol's current span and **clamp the evidence to it** (point it at the symbol, or its changed lines). Lower fidelity than tiers 1–2 — you're saying "the exact lines shifted in a way I can't track, but the claim's subject is still *this function*" — but far better than dropping straight to a model call or leaving the evidence dangling. Needs the enclosing symbol name captured on the evidence: the `symbol` field is also already present on `ReviewEvidenceState` and also unused today. Extracting it needs per-language awareness (e.g. tree-sitter), which is why tier 3 is the heaviest to build and the one to defer until instrumentation shows a real "fingerprint gone but symbol survived" residue.

Payoff on speed (#1): a 100-claim PR where a new commit touches 2 files may resolve ~95 claims via tiers 1–3 for free and send only a handful to the model. The flow inverts — the CLI *computes* the remap at carry-forward time and surfaces only the unresolved residue; agent-declared `evidence_moved` becomes an **override**, not an input.

**Two distinct diffs — don't conflate:** claim generation diffs vs the **target branch**; evidence remap diffs the branch's own **old-HEAD → new-HEAD** progression.

**Relation to [issue #17](https://github.com/paire-dev/paire/issues/17):** the issue is problem #2, and proposes two fixes — Option A (resolve line numbers at *render* time through revision history) and Option B (re-anchor on *apply*, shifting line numbers for insertions/deletions above). This tiered remap is essentially **Option B as tier 1**, extended to cover the exact weakness the issue calls out for Option B — "loses fidelity if the referenced code itself was moved or restructured" — via fingerprint (tier 2) and symbol (tier 3) re-anchoring, with genuine semantic changes routed to the model (tier 4). We materialize on apply (line numbers as a derived cache) rather than resolving at render, but keep `fingerprint`/`symbol` as stable identity so re-derivation stays possible. Note: the issue references a `revisionId` field on evidence as the hook; the live `ReviewEvidenceState` (`review-state.ts:87-96`) exposes `symbol?`/`fingerprint?` but not `revisionId` — worth confirming where revision identity actually lives before building.

### Rollout recommendation
- **Tier 1 live.** Small, self-contained, no false-match hazard. On a **tier-1 miss**, the claim falls through to **tier 4 (the model)**, which re-emits fresh evidence and decides unchanged/amend/supersede/invalidate. Two kinds of miss: (a) the claim's code was genuinely edited → the model *should* judge it, this is correct routing; (b) code unchanged but relocated → a wasteful model call (it'll likely say "unchanged") — this is the residue tier 2 targets. Safe either way: verbatim-carry validation (§C, invariant 1) blocks silent rewording, and nothing is left pointing at stale lines.
- **Populate `fingerprint` and `symbol` on evidence immediately** — both fields exist on `ReviewEvidenceState` but are unused today. Cheap now, and it avoids a cold start when tiers 2/3 land (they can only match claims that had a fingerprint recorded at creation).
- **Tier 2 in shadow mode.** Build the matcher, compute what it *would* re-anchor on each carry-forward, **log it — don't apply it**. Tier 1 still does the real remap. This yields (i) the near-complete implementation, (ii) real data on how often tier 2 fires and its unique-vs-ambiguous-vs-no-match distribution, at (iii) zero misanchoring risk. Flip it live once the logs show the unique-match rule is trustworthy. (Shadow mode doubles as the residue instrumentation — "would tier 2 have helped here?" needs the tier-2 matcher to answer anyway.)
- **Tier 3 deferred.** Needs per-language symbol parsing (tree-sitter/LSP) — a real build, not a toggle. Do it only if the shadow logs show a meaningful "fingerprint gone but symbol survived" residue.

## B. Persistence & fast version retrieval

**Targets:** #3 (what's-new navigation) primarily; also #2 (line numbers as a derived cache).

Retrieval only needs to *feel fast in the UI*, and it already is: each review row stores the full accumulated `ReviewState`, so serving any version is a single-row read — no runtime accumulation to avoid.

One tempting idea is to store, per version, a split of `{carried from previous}` vs `{new this version}` so the UI can tell what's new. Skip it: a binary bucket can't express the real taxonomy (carried / evidence-edited / amended / superseded / new), and "what's new" is per-*reviewer* anyway (see §C), not a fixed property of a version. Instead:

- Add **per-claim provenance**: `introducedInVersion`, `lastModifiedInVersion`, `supersededInVersion`. "What's new" becomes a **filter**, not a stored bucket.
- Make evidence **line numbers a derived cache**, recomputed each version via the remap; `fingerprint`/`symbol` are the stable identity. This is the clean structural fix for staleness (#2).

## C. Multi-user consistency

**Targets:** #3 (multi-user version navigation).

The guarantee — *seen claims keep their wording unless meaning changes; every real change is an explicit transition* — reduces to two enforced invariants plus a per-reviewer cursor:

- **Invariant 1 — verbatim carry.** Carried claims copy `title/before/after/description` byte-for-byte; only evidence line numbers change. **Enforce** in `apply-validation.ts`: an `unchanged` claim whose text differs from its prior `ClaimRevision` snapshot → `PAIRE_COMMAND_REJECTED`. (Turns "please don't reword" into a hard failure.)
- **Invariant 2 — explicit transitions.** Rewording is legal only via `amend` / `supersede` (tier 4), each snapshotting prior text into `ClaimRevision` and recording an event.
- **Model scoping + anchor dedup.** The model only produces claims for the delta. A new claim whose anchor (fingerprint / overlapping lines / enclosing symbol) matches a carried claim is **deduped → keep the carried verbatim**, not accepted as a reword. Keep dedup deterministic (don't ask the model "same issue?").
- **`humanStatus` = the per-reviewer surfacing signal.** Carried-verbatim → `humanStatus` preserved (reviewer not re-bothered). Amended/superseded → reset to `unreviewed` (re-surfaces as "new to me"; reword now legitimate). **"What's new for reviewer X" = claims where X's `humanStatus` is `unreviewed`** — this is per-reviewer, which a fixed per-version bucket cannot express. (Consistent with commit `3565fc0`, which treats human-status changes as separate from claim revisions.)
- **Supersession in a version range** (needs the provenance fields from §B). For range `[lo, hi]`: a claim is active-in-range if `introduced ≤ hi` and (still active or `terminated > lo`). Collapse `A → B` to show B with a "replaces A (from vN)" lineage note when both are new to the reviewer; else show B alone. A stays reconstructable from its `ClaimRevision` for anyone who saw it.

## D. Rebase / force-push handling

**Targets:** robustness of the incremental machinery — protects #1 (avoid needless full re-reviews) and #3 (avoid consistency loss) when history is rewritten.

"Commits since last review" assumes linearly-appendable history; rebase/squash/amend/force-push break it. The discriminator that matters is **"did the base move?"** — because a moved base is what pollutes an old→new diff with the target's churn.

**v1 rule (3-way):**
1. `is-ancestor(prev.currentCommit, HEAD)` **true** → clean append → **incremental**.
2. else **base unchanged** (`prev.baseCommit == currentBase`) → amend / reword / reorder / in-branch squash → **still incremental** (`diff(prev.currentCommit..HEAD)` is author-only). Guard: if `cat-file -e prev.currentCommit` fails (tip GC'd / fresh clone) → drop to (3).
3. else **base moved** (true rebase onto advanced target) → **full re-review** vs the fresh target.

Why this shape:
- Catches the most common force-push (tip `--amend`) on the fast, consistency-preserving path.
- Lets v1 **defer baseline-content storage** entirely — a full re-review needs no old baseline.
- Version = **review-run ordinal**, never commit count (already true via `sourceReviewId`). Reviewer read-position keyed on **version + claim IDs**, never a commit SHA (rebase invalidates SHAs).

**Conscious v1 tradeoffs:** full re-review **drops the consistency guarantee on rebase versions** (model rewords) — mark such versions "history changed here"; and if the team rebases heavily, the slow path fires often.

**Later optimization:** reframe reviews around **author-delta-vs-target** (`diff(target_N, HEAD_N)`) — i.e. always compare against the base commit as the fixed reference point. This recovers speed + consistency on rebases and short-circuits **no-op rebases** (a naive old→new diff otherwise surfaces all of the target's advancement as if the author wrote it).

## E. Concurrency

**Targets:** robustness of version creation — keeps the incremental chain well-formed when triggers overlap.

v1 scope: single checkout / CI-driven review generation, **no multi-user review page yet**. So we only need to stop overlapping *generation* runs from corrupting the chain — not the full multi-user machinery.

- **Single-flight per branch + idempotency by `(chain, currentCommit)`.** A per-branch queue coalesces triggers and runs one generation at a time; a version for a given HEAD is unique, so duplicate triggers on the same commit collapse to one. Together these prevent a **forked `sourceReviewId` chain** (two v11s branched off the same v10).
- **Stale-HEAD → record exact HEAD + enqueue follow-up.** Generation isn't instant, so HEAD can advance mid-run. On start, capture the reviewed commit `X` and store it on the version (`target.currentCommit`); it labels the version, is the baseline the next incremental run diffs from, and detects staleness. After persisting version N for `X`, re-read HEAD: if unchanged, done; if it moved, **keep the `X` review and enqueue a follow-up** that catches up to the latest as version N+1. This avoids wasted work and livelock (vs. abort-and-restart), and fits the model — a stale review is just "version N at commit X," and catching up is the cheap `X → latest` delta. Because **version = review-run ordinal, not commit count** (§D), coalescing a burst of pushes into one catch-up version is fine.
- **Keep version writes atomic.** Today the whole state is one JSON row per review, so a version write is atomic for free and readers never see a half-built version — preserve this (or add explicit transactions) if claims/evidence are ever normalized into separate tables.

**Deferred until the multi-user review page lands (note only):** `humanStatus` is a single scalar today; multi-user needs it *per reviewer*, which means pulling human state (status/assignee/acceptance) out of the versioned claim snapshot into a **per-user overlay** keyed by `(user, claim-identity)`. That also removes a human-write-vs-version-creation race. Not needed for v1 — but don't bake `humanStatus` so deep into the version snapshot that extracting it later hurts. (Commit `3565fc0`, which already keeps human-status changes out of claim revisions, is the right direction.)

---

## Secondary concerns (decided / deferred)

- **No-op / empty versions (v1: don't bother)** — a run may mint a version even when no claim content changed. Fine for v1: empty versions add **no claims** to the accumulated review (the latest view stays clean regardless), only an entry to the version *timeline* — and the version-range navigation UI that would care is itself a **future feature**. So there's nowhere for them to show up now. Only real cost: each version persists a full-state row (storage, not correctness). Revisit when range-nav lands: tag versions with a delta summary so empty ones collapse / don't ping the cursor, or split a "reviewed-up-to watermark" from "content-milestone versions."
- **Renames (accepted limitation, v1)** — evidence matches files by path, so `git mv` orphans a claim: the renamed file shows up as a new file and its claims get **regenerated** (reworded + ack lost) rather than silently dropped. Judged a minor, rare, self-correcting annoyance — **not worth handling in v1.** Cheap future fix if it proves noisy: enable `git diff -M` and remap evidence `filePath` on carry-forward before the §A line tiers (and let tier-2 fingerprint search span files for renames git's similarity threshold misses).
- **Target-branch semantics (decided)** — pin the review to a fixed point of the target: the **merge-base, recomputed each run** (three-dot diff `merge-base(target, HEAD)..HEAD`). Consequences: the target advancing *on the remote* **does not affect the review** (merge-base unchanged); only a **branch action that moves the base** — rebasing onto the target, or merging the target into the branch — changes it, which is exactly §D's "base moved" path. Nuance: merge-from-target is an *append* by §D's is-ancestor test yet moves the base — fine, because the incremental `prev..HEAD` diff already includes the merged files, so they get re-examined without a special case. Accepted residual: a claim that *references* unchanged target code can silently age if the target later changes it (inherent to snapshot review). To verify when building: diff against a **recomputed merge-base**, never a frozen `baseCommit` SHA.
- **First-review (cold-start) speed** — separate track from the incremental design; the incremental work here does nothing for the first review of a PR. Key fact: **paire has no LLM** — the external agent (Claude Code) does all model work and calls paire commands — so most speed levers aren't paire's. Split:
  - *paire-owns (buildable here):* **batch claim submission** — accept structured, per-item-validated claims (NDJSON/manifest, not hand-edited JSON) with partial-success + per-item rejects, recovering PR #14's per-claim round-trip latency without regressing its error isolation; **leaner exported context** (`paire review context` / annotated diff — hunks + minimal surround, pre-flag mechanical files); **progressive surfacing** (stream claims to the UI as they land — perceived-speed win); **shard/merge seams** — expose diff pre-sharded by file and own the claim/thread merge+dedup so agent-side parallelism is safe.
  - *agent-owns (paire can only nudge via `install-agent-instructions.ts`):* parallel subagents per file/shard, cheap-model triage → escalate, prompt-caching the shared diff prefix. Likely the biggest wall-clock win for big PRs, but it's the orchestrator's job, not paire's.

## Suggested build order (rough)

0. **Resolve the `revisionId` question** (§A note) — confirm where revision identity actually lives on evidence before building remap.
1. **Tier-1 remap live** — consume `annotateHunkText`'s old→new map to shift carried evidence; wire tier-1 misses to the model (tier 4). Start **populating `fingerprint`/`symbol`** on evidence at claim-add time (no consumption yet).
2. **Provenance fields** (`introducedInVersion` / `lastModifiedInVersion` / `supersededInVersion`) + **`unchanged`-text validation rule** (verbatim-carry enforcement, §C).
3. **Diff/base semantics** — recomputed merge-base per run (target-branch decision) + **rebase v1 3-way rule** (§D: append / base-unchanged / base-moved → full re-review).
4. **Concurrency guards** (§E) — single-flight per branch + idempotency by `(chain, currentCommit)` + record-exact-HEAD / enqueue-follow-up; keep version writes atomic.
5. **Tier-2 fingerprint in shadow mode** (§A) — log would-be re-anchors, flip live once the unique-match rule is proven.
6. **Deferred (when multi-user / range-nav UI lands):** `humanStatus` per-user overlay + per-reviewer "what's new" filter + version-range rendering; tier 3 (symbol re-anchor); author-delta reframe; first-review speed levers.
