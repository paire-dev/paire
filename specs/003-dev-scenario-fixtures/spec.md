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

```ts
// test/support/scenarios/types.ts (illustrative)
type ScenarioClaim = {
  threadId: string;
  title: string;
  importance: ClaimImportance;
  workStatus?: ClaimWorkStatus;         // default "pending"
  lifecycleStatus?: ClaimLifecycleStatus; // default "active"
  humanStatus?: HumanStatus;
  before?: string | null;
  after?: string | null;
  description?: string;
  evidence: { path: string; startLine: number; endLine: number; change: string }[];
};

export type Scenario = {
  name: string;
  mode: "committed" | "uncommitted";
  files: Record<string, { base: string; head: string }>; // per-file before/after contents
  threads: { id: string; title: string; summary?: string }[];
  claims: ScenarioClaim[];
};
```

`mode` drives repo generation:
- **committed** → commit `base` files, apply `head` edits, commit again → target `{ mode:"committed", baseCommit, currentCommit }`.
- **uncommitted** → commit `base` files, apply `head` edits to the working tree and **leave them dirty** → target `{ mode:"uncommitted", currentCommit: base, worktreeHash }`.

Either way the UI's live `git diff` produces a real diff and evidence line numbers resolve.

## Builder API

Two entry points, so unit tests don't pay for a git repo they don't need:

- `scenarioState(scenario): { state: ReviewState; context: ReviewContext }` — pure, in-memory. Builds via `createReviewState()` + the reflector reducers; synthesizes a `ReviewContext` from the scenario (declared changed files / touched ranges). No git, no DB. For **unit** tests and component-prop harnesses.
- `materializeScenario(scenario, opts): { repoRoot; reviewId; db }` — generates the fixture git repo (committed or dirty per `mode`), runs the **real** `getOrCreateReviewForTarget()` deterministic path, applies the scenario's claims through `applyReflectorCommand()`, persists via `persistNewReviewState()`, and sets the review selection. For **visual** and **integration** use. `opts` carries `paireHome` (temp for tests) and `outDir` (where the repo is generated).

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

## Open questions / couplings to verify during implementation

1. Can `getOrCreateReviewForTarget()` + persistence run outside the normal CLI/session flow with an arbitrary `repoRoot`/target? May need light extraction of a session-agnostic core.
2. Reuse paire's own **`worktreeHash`** computation for uncommitted-mode targets so the app accepts them.
3. Confirm how the web server picks which session/review to display (`review_selections` + `resolveReviewForCli`) so `--serve` reliably shows the seeded review.
4. Confirm the default fixture-repo location and lifecycle (persist while viewing, regenerate on re-seed, easy to clean).

## Milestones

1. `Scenario` type + 2–3 example scenarios.
2. `scenarioState()` + unit-test helper (no git/DB) — immediately unblocks unit tests.
3. `materializeScenario()` — repo generation (committed + uncommitted) + reuse of create/reflector/persist into an isolated home; resolve couplings (1)–(2).
4. `paire dev seed` CLI (`--scenario`, `--list`, `--serve`), dev-gated.
5. `withScenarioDb()` integration helper hitting the real API routes; resolve coupling (3).
6. Seed the example-scenario library; document usage in `AGENTS.md` / `README`.

## Acceptance criteria

- A contributor runs `paire dev seed --scenario dense-claims --serve` and sees the full review page — claim cards **and** a working diff panel with evidence highlighting — with no model call.
- A unit test does `const { state } = scenarioState(scenario)` and asserts on threads/claims/evidence without touching git or the DB.
- An integration test materializes committed **and** uncommitted scenarios into an isolated `PAIRE_HOME`, asserts `/api/review` and `/api/review/diff` return the expected shape with a resolvable diff, and tears down cleanly — leaving `~/.paire` untouched.
- Adding/renaming a `ReviewState` field breaks the scenario builders at **compile time**.

## Test plan

- **Unit:** `scenarioState()` produces the expected `ReviewState`; evidence falls within declared touched ranges; claim status/importance/lifecycle map through correctly.
- **Integration:** `materializeScenario()` for both modes → real repo + persisted row; API routes return seeded data and a live-resolvable diff; teardown removes the temp home + repo.
