# Spec: Developer Scenario Fixtures (visual + test)

## Summary

A **scenario-fixture system** for repo contributors. One typed scenario definition can be materialized two ways:

1. **Visual** — seed a synthetic review into a fixture repo + local DB and view the **full review page** (claim cards *and* the live diff panel with evidence highlighting) in the local web UI, with no model-driven review run.
2. **Automated tests** — reuse the same scenarios as fixtures in `bun test` (unit *and* integration), so review behaviour and rendering can be asserted deterministically.

It is built almost entirely on existing code: the deterministic review-setup path and the programmatic claim reducers. No LLM/agent is involved.

## Motivation

- **Slow, non-deterministic loop today.** To see a UI change you must edit code → run a real (agent-driven) `paire` review → open the local server. Reproducing a *specific* state (superseded claim, blocked claim, many/long claims, multi-evidence, empty states) is hard and flaky.
- **No reusable fixtures for tests.** Exercising review logic or rendering in tests means hand-building `ReviewState` JSON, which is verbose and silently rots as the schema evolves.
- **One source of truth.** The same scenario should drive both the browser and `bun test` so they never diverge.

## Key architectural facts (grounding)

- A review is one `review_states` row: `stateJson` (`ReviewState` — threads/claims/evidence/events) + `contextJson` (`ReviewContext`). See `src/cli/review-state.ts`; persistence `src/cli/local-engine.ts` (`persistNewReviewState` / `persistReviewState`, ~1233–1288).
- **The diff panel is computed live from git at view time** — `diffForReviewTarget()` runs `git diff -w base..head` (committed) or the worktree diff (uncommitted); evidence highlighting hits `git diff` per file (`local-engine.ts` ~4175, route handlers ~3930/3961). **Consequence: a fixture must have a real repo + commit range (or a dirty worktree); fake JSON alone will not render the diff.**
- **The deterministic half needs no model** — `getOrCreateReviewForTarget()` (`local-engine.ts` ~977) computes diff, changed files, touched ranges, context, and carry-forward.
- **Claims are programmatic and validated** — `applyReflectorCommand()` / the `reduce*` reducers (`src/cli/reflector.ts` ~228) apply `claim.add` / `claim.edit` / `evidence.*` / `file.acknowledge` / `review.finalize`, with evidence-range validation (`src/cli/apply-validation.ts`). A fixture therefore *cannot* carry evidence that doesn't resolve to the diff.
- **Isolation seam** — the DB is global at `~/.paire/paire.db`, but `PAIRE_HOME` relocates the entire home (`local-engine.ts:370`), and the `db` handle is injectable. Tests/fixtures point `PAIRE_HOME` at a temp dir (or use an in-memory DB) so nothing touches the developer's real reviews.

## Goals

- A typed **`Scenario`** definition authored against the real `ReviewState` / reflector-input types, covering `committed` and `uncommitted` (worktree) modes.
- A **builder** that materializes a scenario into a real fixture repo + `ReviewState` + `ReviewContext`, reusing the existing create/reflector/persist code.
- **Visual path:** `paire dev seed --scenario <name>` → generate repo, build + persist the review, wire the review selection, serve — with Bun HMR for fast component iteration afterward.
- **Test path:** helpers for `bun test` that support both
  - **unit** — build an in-memory `ReviewState` from a scenario with no git/DB, for asserting on state logic; and
  - **integration** — seed an isolated `PAIRE_HOME` + temp repo and exercise the real persistence/API (`/api/review`, `/api/review/diff`, evidence-diff), then tear down.
- A small **library of example scenarios** (checked in) covering key states, shared by both paths.

## Non-Goals

- A screenshot / visual-regression harness (this spec *enables* it; it is not built here).
- Any model/agent-driven review generation.
- Multi-user / team fixtures.
- Reading or mutating a developer's real production review data.

## Scenario definition

Authored in TS so it fails to **compile** when the schema changes.

The type is **revision-oriented** from the start: a scenario is a branch fork point (`base`) plus an ordered list of `revisions` (v1, v2, …). A plain single-review scenario is just `revisions.length === 1`; multi-version scenarios (needed to test incremental behaviour — carry-forward, stale evidence, provenance — see "Multi-version scenarios" below) simply add more revisions. Designing the type this way now avoids a breaking reshape of every scenario later.

```ts
// test/support/scenarios/types.ts (illustrative)
type ScenarioClaimOp =
  | { op: "add"; threadId: string; title: string; importance: ClaimImportance;
      workStatus?: ClaimWorkStatus; lifecycleStatus?: ClaimLifecycleStatus;
      humanStatus?: HumanStatus; before?: string | null; after?: string | null;
      description?: string;
      evidence: { path: string; startLine: number; endLine: number; change: string }[] }
  | { op: "edit"; claimRef: string; /* fields to change */ }
  | { op: "supersede"; claimRef: string; /* replacement claim fields */ }
  | { op: "acknowledge"; path: string; reason: string };

type Revision = {
  edits: Record<string, string | null>;                 // file → new full content (null = delete)
  threads?: { id: string; title: string; summary?: string }[]; // threads introduced at this version
  claims?: ScenarioClaimOp[];                            // claim ops applied at this version
};

export type Scenario = {
  name: string;
  mode: "committed" | "uncommitted";
  base: Record<string, string>;   // file contents at the branch fork point (the diff comparison base)
  revisions: Revision[];          // v1, v2, … ; single-review scenario = exactly one revision
};
```

`mode` drives repo generation:
- **committed** → commit `base`, then for each revision apply its `edits` and commit → each revision is a HEAD; review vN diffs `base..headN`.
- **uncommitted** → commit `base`, apply the (single) revision's `edits` to the working tree and **leave them dirty** → target `{ mode:"uncommitted", currentCommit: base, worktreeHash }`. (Uncommitted mode is intended for single-revision scenarios; multi-version timelines use committed mode.)

Either way the UI's live `git diff` produces a real diff and evidence line numbers resolve.

## Builder API

Two entry points, so unit tests don't pay for a git repo they don't need:

- `scenarioState(scenario): { state: ReviewState; context: ReviewContext }` — pure, in-memory. Builds a **single** version's state via `createReviewState()` + the reflector reducers; synthesizes a `ReviewContext` from the scenario (declared changed files / touched ranges). No git, no DB. For **unit** tests and component-prop harnesses. (Cross-version behaviour needs real diffs, so it's exercised via `materializeScenario`, not here.)
- `materializeScenario(scenario, opts): { repoRoot; reviewIds: string[]; db }` — generates the fixture git repo and **walks the scenario's revisions through the real incremental pipeline**: commit `base`; for each revision, commit its `edits`, run `getOrCreateReviewForTarget()` with `sourceReviewId` = the prior review (real carry-forward + remap), apply that revision's claim ops via `applyReflectorCommand()`, and persist as version N. Returns the persisted version chain (`reviewIds`) and selects the latest for `--serve`. For **visual** and **integration** use. `opts` carries `paireHome` (temp/fixtures) and `outDir`.

## Multi-version scenarios (testing incremental reviews)

Because a scenario is a list of revisions, `materializeScenario` produces the real `review_states` **version chain** (v1 → v2 → …) through the actual incremental pipeline — a deterministic, model-free vehicle for testing the incremental-reviews design (carry-forward, stale/outdated evidence per issue #17, provenance, tier-1 remap).

Example — the outdated-evidence regression (issue #17):

```ts
scenario("evidence shifts when unrelated code is added above", {
  mode: "committed",
  base: { "foo.ts": /* 40 lines */ },
  revisions: [
    { edits: { "foo.ts": /* touch lines 40-43 */ },
      claims: [{ op: "add", threadId: "t1", title: "no backoff", importance: "important",
                 evidence: [{ path: "foo.ts", startLine: 40, endLine: 43, change: "modified" }] }] },
    { edits: { "foo.ts": /* +10 unrelated lines above line 40 */ } }, // v2: claim carried forward
  ],
});

// in bun test:
const { reviewIds, db } = materializeScenario(scenario, { paireHome: tmp });
const v2 = loadReviewState(db, reviewIds.at(-1));
const carried = v2.claims.find((c) => c.title === "no backoff");
expect(carried.evidences[0].startLine).toBe(50); // remap applied
expect(carried.title).toBe("no backoff");         // carried verbatim (consistency)
```

Notes:
- **Red-first is expected.** The remap assertion only passes once tier-1 remap exists; before that the same fixture documents the current bug (evidence stuck at 40-43) — a useful tracking test for issue #17.
- **Rebase/force-push timelines** (history rewrite between revisions) need the repo generator to rebase/amend, not just append — a later extension beyond v1.

Scope: the **revision-oriented type** is v1. Full multi-version **materialization** (walking the carry-forward chain across revisions) is a later milestone; v1 materialization can ship single-revision while the type is already timeline-ready.

## CLI surface

New `paire dev` command group:

- `paire dev seed --scenario <name> [--out <dir>] [--serve]` — materialize a scenario and print the fixture repo path + how to view; `--serve` launches the web UI pointed at that repo.
- `paire dev seed --list` — list available scenarios.

### Distribution: contributor-only, never shipped as a product command

Two independent guarantees keep this out of end users' hands:

1. **Dev-build gate.** The `paire dev` group is registered/executed only when `PAIRE_VERSION === "dev"` (i.e. running from source). It is absent from a published binary's `--help` and no-ops otherwise.
2. **Machinery isn't packaged.** The scenario library + builders live under `test/support/**`, which is excluded from the published package (`files` allowlist / `.npmignore`). So even if the command were reachable in a release, there would be no scenarios to run — the exclusion does most of the work.

Contributors invoke it from a checkout (`bun src/cli.ts dev seed …`, i.e. `paire dev seed …` in dev). It is intentionally *not* discoverable or usable by installed end users.

### Isolation & repo generation

- **Dedicated fixtures home.** `dev seed` targets a separate fixtures `PAIRE_HOME` (default `~/.paire-fixtures`, overridable) rather than the developer's real `~/.paire`, and `--serve` launches the web UI against that home — so seeding fake reviews can never pollute or overwrite real ones.
- **Generated repos live outside the main working copy** (default under the fixtures home, e.g. `~/.paire-fixtures/repos/<scenario>/`, overridable via `--out`) to avoid nested-repo / `git status` pollution. They persist while being viewed and are regenerated on each seed.

## Test helpers

Location: `test/support/scenarios/` (co-located with the scenario library).

- `scenarioState(scenario)` — see above; unit tests assert on the returned `ReviewState`.
- `withScenarioDb(scenario, fn)` — integration helper: sets up an isolated `PAIRE_HOME` (temp) + DB + fixture repo via `materializeScenario`, invokes `fn({ db, repoRoot, reviewId, state })`, and tears down (removes temp home + repo) in a `finally`. Never touches `~/.paire`.

Example:

```ts
test("review API returns the seeded claims + a resolvable diff", async () => {
  await withScenarioDb(scenarios.denseClaims, async ({ repoRoot }) => {
    const review = await fetchReview(repoRoot);      // hits /api/review
    expect(review.claims).toHaveLength(12);
    const diff = await fetchReviewDiff(repoRoot);    // hits /api/review/diff
    expect(diff).toContain("src/foo.ts");
  });
});
```

## Reuse map (existing code — minimal new logic)

| Need | Existing code |
| --- | --- |
| Empty state + reducers | `createReviewState`, `reduce*` / `applyReflectorCommand` — `reflector.ts` |
| Deterministic diff/context/carry-forward | `getOrCreateReviewForTarget`, `buildReviewContext` — `local-engine.ts` ~977/1026 |
| Persist + select | `persistNewReviewState`, `selectReview`, session create — `local-engine.ts` |
| Live diff for the panel (unchanged) | `diffForReviewTarget` — `local-engine.ts` ~4175 |
| Isolation | `PAIRE_HOME` env + injectable `db` handle |
| Integration scaffolding (temp repo, `PAIRE_HOME`, CLI runner, server + `/api/review` fetch) | `createFixtureRepo` / `runPaire` / `commitAll` / server+API helpers — **`test/cli.test.ts`** (extract to `test/support/`) |

## Relationship to existing tests (avoiding duplication)

`test/cli.test.ts` already has an integration harness we should **reuse, not rebuild**: `createFixtureRepo()` (temp repo + `git init` + isolated `PAIRE_HOME` + auto-cleanup), `runPaire()` (spawns the real CLI), `commitAll()`, plus helpers that start the review server and fetch `/api/review`. It already asserts on canonical state and the live API. Decisions:

- **Extract that scaffolding into shared `test/support/`** and have `materializeScenario` / `withScenarioDb` build on it. A second temp-repo / `PAIRE_HOME` / server harness would be pure duplication.
- **`scenarioState` reuses the same reducer primitives** (`createReviewState` + `reduce*`) that `reflector.test.ts` already uses — it does not reimplement state construction.
- **Existing unit tests stay authoritative and are not duplicated:** `reflector.test.ts` (reducer behaviour), `apply-validation.test.ts` (validation), `diff-line-numbers.test.ts` (line mapping). Scenario-based tests must target coverage those *don't* provide — **multi-version / incremental behaviour (issue #17), rendering + API over a declarative corpus, and visual seeding** — not re-assert reducer/validation internals.
- **Fidelity split:** `cli.test.ts` drives claims through the real CLI subprocess (covers arg parsing / the command path); the scenario builder applies claims **in-process** via `applyReflectorCommand` (fast, direct state access). Complementary — CLI-path coverage stays in `cli.test.ts`.

## Open questions / couplings to verify during implementation

1. Can `getOrCreateReviewForTarget()` + persistence run outside the normal CLI/session flow with an arbitrary `repoRoot`/target? May need light extraction of a session-agnostic core.
2. Reuse paire's own **`worktreeHash`** computation for uncommitted-mode targets so the app accepts them.
3. Confirm how the web server picks which session/review to display (`review_selections` + `resolveReviewForCli`) so `--serve` reliably shows the seeded review.
4. Confirm the default fixture-repo location and lifecycle (persist while viewing, regenerate on re-seed, easy to clean).

## Milestones

1. **Extract shared scaffolding** from `test/cli.test.ts` (`createFixtureRepo`, `runPaire`, `commitAll`, server + API helpers) into `test/support/`; refactor `cli.test.ts` onto it (no behaviour change).
2. `Scenario` type + 2–3 example scenarios.
3. `scenarioState()` + unit-test helper (reusing the reducer primitives) — immediately unblocks unit tests.
4. `materializeScenario()` **single-revision** — repo generation (committed + uncommitted) on the shared scaffolding + reuse of create/reflector/persist into an isolated home; resolve couplings (1)–(2).
5. `paire dev seed` CLI (`--scenario`, `--list`, `--serve`), dev-gated.
6. `withScenarioDb()` integration helper on the shared scaffolding, hitting the real API routes; resolve coupling (3).
7. **Multi-version materialization** — walk the revision chain (carry-forward + remap) into the real version chain; add issue-#17-style timeline tests (red-first until remap lands).
8. Seed the example-scenario library; document usage in `AGENTS.md` / `README`.

## Acceptance criteria

- A contributor runs `paire dev seed --scenario dense-claims --serve` and sees the full review page — claim cards **and** a working diff panel with evidence highlighting — with no model call.
- A unit test does `const { state } = scenarioState(scenario)` and asserts on threads/claims/evidence without touching git or the DB.
- An integration test materializes committed **and** uncommitted scenarios into an isolated `PAIRE_HOME`, asserts `/api/review` and `/api/review/diff` return the expected shape with a resolvable diff, and tears down cleanly — leaving `~/.paire` untouched.
- A **multi-version** scenario materializes into a real `review_states` chain, and a `bun test` asserts carried-claim evidence + wording across versions (the issue-#17 timeline test).
- The scenario harness **reuses the extracted `test/cli.test.ts` scaffolding**; no second temp-repo / `PAIRE_HOME` / server harness is introduced, and existing unit/CLI tests aren't re-implemented.
- Adding/renaming a `ReviewState` field breaks the scenario builders at **compile time**.

## Test plan

- **Unit:** `scenarioState()` produces the expected `ReviewState`; evidence falls within declared touched ranges; claim status/importance/lifecycle map through correctly.
- **Integration:** `materializeScenario()` for both modes → real repo + persisted row; API routes return seeded data and a live-resolvable diff; teardown removes the temp home + repo.
