# Implementation Plan: Developer Scenario Fixtures (v1, single-revision)

## Summary

Implement the v1 slice of `spec.md`: a typed `Scenario` definition plus two builders (`scenarioState` in-memory, `materializeScenario` git+DB) that turn one scenario into either a unit-test `ReviewState` or a real seeded review viewable in the local UI, with no model call.
Add a contributor-only `paire dev seed` entrypoint and a `withScenarioDb` integration helper, both built on scaffolding extracted from `test/cli.test.ts`.
v1 is single-revision only; the multi-version revision-chain walk (issue #17 timeline) is deferred to milestone 7 and gets its own follow-up plan.

## Scope

**In (v1):** shared test scaffolding extraction, `Scenario` type, `scenarioState()`, single-revision `materializeScenario()` (committed + uncommitted), `paire dev seed` CLI (`--scenario`, `--list`, `--serve`, `--clean`), `withScenarioDb()`, 2-3 example scenarios, docs.

**Deferred (milestone 7, not this plan):** walking a multi-revision chain through the real carry-forward/remap pipeline, and the red-first issue-#17 timeline tests. The `Scenario` type is authored revision-ready now so this is a later implementation extension, not a reshape. In v1, a scenario with `revisions.length > 1` is rejected.

## Current State (grounding)

### The deterministic seed path already exists as one private function

`src/cli.ts` is a 5-line shim into `runCli(argv)` (`local-engine.ts:304`). Inside, `resolveReviewForCli(ctx, selector, { create, select })` (`local-engine.ts:895`) is the whole model-free pipeline:

- ensures a session for the repo (`ensureSessionForGit`, `:1047`),
- resolves the target (explicit `--diff/--base/--head`, dirty worktree, or next committed range),
- computes the diff, `createReviewState()`, carry-forward, `buildReviewContext()` (`:1119`),
- `persistNewReviewState()` (`:1233`) and `selectReview()` (`:1293`),
- returns `{ state, context, session, git, row }`.

The selector shape is `{ reviewId?, diff?, base?, head? }`. Two paths matter for fixtures:

- **Uncommitted mode:** an empty selector `{}` falls through to the dirty-worktree branch (`:928-944`) and produces the right target automatically. Leave the tree dirty and call `resolveReviewForCli(ctx, {}, { create:true, select:true })`.
- **Committed mode: an empty selector is WRONG.** On a fresh fixture, `latestCommitted` is null so `baseCommit = session.baseCommit` (`:958-962`), which `ensureSessionForGit` computed as `merge-base HEAD baseRef` (`:1055-1058`) with `detectBaseRef` returning `"main"` for the generated repo. If the revision `edits` are already committed on `main`, then `HEAD == main`, so `baseCommit == HEAD` and `git diff -w HEAD..HEAD` is **empty** (`:1002`) - blank diff panel, zero changed files. The generator knows both SHAs, so it must pass an **explicit** `{ base: <baseSha>, head: <headSha> }`; the `--diff/--base/--head` branch (`:913-925`) uses `resolveDiffSelector` (`:1099`) and skips base-ref heuristics entirely.

**So `materializeScenario` is mostly: point a `Context` at a fixtures `PAIRE_HOME`, generate a git repo, then call `resolveReviewForCli` - `{ base, head }` for committed, `{}` (dirty tree) for uncommitted - and apply the scenario's claim ops.** This is the "minimal new logic" the spec promised. (`cli.test.ts` sidesteps the committed base problem only because it runs `paire start --base main` while HEAD is still at base; the builder has no such step, so it uses the explicit selector instead.)

### Everything the builder needs is currently module-private

`resolveReviewForCli`, `getOrCreateReviewForTarget` (`:977`), `buildReviewContext`, `persistNewReviewState`, `persistReviewState` (`:1269`), `selectReview`, `computeWorktreeHash` (`:2344`), `makeContext`/`Context` (`:364`), and `ensureSessionForGit` are all **unexported**. Already exported and reusable: `createReviewState()` + `CreateReviewStateInput` (`review-state.ts:242/222`), `deriveFileProgress` (`:203`), `applyReflectorCommand()` and the `reduce*` reducers (`reflector.ts:228/259`). This is the "light extraction of a session-agnostic core" from spec open question 1 - see decision D1.

### Reflector application shape

`applyReflectorCommand(state, command, options): ReflectorResult` returns a discriminated union with `ok`; `reflectReviewCommand` (`reflector.ts:249`) throws `ReflectorError` on `!ok`. The builder applies each scenario op through this and must fail loudly on rejection (evidence out of touched range, unknown file, etc.), since a bad fixture should not persist.

### Test scaffolding to reuse (do not rebuild)

`test/cli.test.ts` has private helpers we extract to `test/support/`: `createFixtureRepo()` (`:365`, temp repo + isolated `PAIRE_HOME` + tracked in a module `fixtures[]` array), `runPaire()` (`:382`), `run()` (`:402`), `commitAll()` (`:409`), plus DB/server helpers `latestReviewState`, `onlySessionId`, `waitForServerState` (`:442`), `reviewApiUrl`/`reviewApiFetch` (`:453/458`), and `text`. Cleanup today is a module-level `fixtures[]` + `afterAll`; extraction must expose an explicit disposer/registry so both `cli.test.ts` and the scenario helpers share one lifecycle (see W1).

### `--serve` review resolution

Server routes are per-session: `sessionRoute` (`:3603`) resolves a `SessionRow` from a per-request token, and `getSelectedReview(db, sessionId)` (`:1301`) reads `review_selections`. Because `resolveReviewForCli(..., { select: true })` already writes that selection, no *new selection* wiring is needed - open question 3 holds. But the daemon only serves a session that has been **registered** (token minted via the register POST, `:3470-3502`); the production path that does spawn + register + open-token-URL in one shot is `openReviewUi`/`ensureReviewServer` (`:3212/3243`). So `--serve` reuses that, not a bare `_review-serve` spawn (see W6).

### Distribution reality

`scripts/build.ts` compiles a single binary via `bun build ... compile` from entrypoint `src/cli.ts`. Anything reachable from that import graph (static or literal dynamic import) is embedded regardless of any `PAIRE_VERSION` check. This drives decision D2.

## Key design decisions

### D1. Extract a session-agnostic core from `local-engine.ts`

Export a minimal, stable surface so the builders reuse the real pipeline instead of reimplementing it. The set is driven by what W3-W7 actually consume:

- **Seed pipeline:** `createContext({ cwd, paireHome, env? }): Context` (thin wrapper over the existing `makeContext` logic - DB open + dir bootstrap keyed on `PAIRE_HOME`), `resolveReviewForCli` (rename-export as `resolveReview` if preferred), `persistReviewState`, `selectReview`, `computeWorktreeHash`, `getGitState` (`:4746`).
- **Diff helpers for `scenarioState`/context parity (W3/W4):** `summarizeChangedFiles`, `touchedRanges`, `touchedSnippets` (`:4904/5001/4928`).
- **Serve for `--serve` (W6):** `openReviewUi`/`ensureReviewServer` (`:3212/3243`) - see W6.

Keep them internally unchanged; this is export-only plus one small `createContext` factory. No behavior change to the shipped CLI. Guard with existing `cli.test.ts` (still green after extraction).

### D2. Distribution: a separate contributor entrypoint, not a branch in `runCli`

The scenario library + builders + `dev seed` CLI live under `test/support/**` and are invoked through a dedicated entrypoint, e.g. `test/support/dev-cli.ts`, run as `bun run dev-seed -- --scenario <name>` (package.json script) or `bun test/support/dev-cli.ts …`. **`src/cli.ts` never imports `test/support`,** so the compiled binary cannot embed it - this is the real guarantee, not the runtime version check. Optionally add a friendly `paire dev` hint in `runCli` that, when `PAIRE_VERSION === "dev"`, prints "run `bun run dev-seed`" and otherwise reports unknown command - but it must not statically import the dev module. A release-binary smoke test (W8) proves `dev`/`test/support`/scenario names are absent from `dist/paire`.

### D3. One shared changed-files/touched-range helper (spec open question 5 + comment ⑤)

`scenarioState` (no git) and `materializeScenario` (real git) must derive `ReviewContext` changed files + touched ranges from the *same* logic, or a unit fixture can pass while the visual one rejects the same evidence. The engine's `summarizeChangedFiles`/`touchedRanges`/`touchedSnippets` (`:4904/5001/4928`) only *parse* a diff (via `parsePatchFiles` from `@pierre/diffs`); nothing in the repo *generates* one in memory - the only producer is `git diff -w` (`:1002`). So parity is real work, not free:

- Generate the in-memory diff with **jsdiff** (`diff@8.x`, already transitive via `@pierre/diffs`), then parse it through the same `summarizeChangedFiles`/touched-range helpers.
- Mirror git's hunking or ranges diverge: git uses `-w` (ignore-all-whitespace) - **whitespace-normalize both inputs** so a whitespace-only edit yields no hunk; and **pin jsdiff `context: 3`** (git's default; jsdiff defaults to 4) so hunk offsets line up.
- **Assert parity on the derived changed-files + touched-ranges, not on raw diff text.** If range-parity proves infeasible for some edit shape, the fallback is to derive `scenarioState`'s ranges from git in a throwaway temp worktree (dents the "no git" purity but guarantees correctness).

A corpus parity test (W9) is the guard that this held.

### D4. Isolation

Both builders target a disposable fixtures `PAIRE_HOME` (default `~/.paire-fixtures`, overridable), never `~/.paire`. `withScenarioDb` uses a temp home and removes it in `finally`. Reseed replaces a scenario's rows before regenerating its repo (spec: "reseed is a replace"). `review_states` has no scenario column and rows are keyed by `reviewId = reviewIdForTarget(repoRoot, target)` with `insert ... on conflict(id) do nothing` (`:1247`), so after regeneration the SHAs (and thus ids) change and old rows would linger. **Delete predicate: each scenario owns a fixed fixture `repoRoot` (`<fixturesHome>/repos/<scenario>/`), so reseed/`--clean` deletes `review_states`/`review_selections`/`sessions` rows `where repoRoot = <that path>` before regenerating.** `paire dev seed --clean [--scenario <name>]` drops one scenario's repo+rows or wipes the whole fixtures home.

## New module layout

```
test/support/
  fixtures.ts          # extracted: createFixtureRepo, runPaire, commitAll, disposer/registry
  review-api.ts        # extracted: server spawn + waitForServerState + reviewApiFetch helpers
  scenarios/
    types.ts           # Scenario, Revision, ScenarioClaimOp (thin wrappers over reflector inputs)
    context.ts         # shared changed-files/touched-range derivation (D3)
    scenario-state.ts  # scenarioState(scenario) -> { state, context }   (no git/DB)
    materialize.ts     # materializeScenario(scenario, opts) -> { repoRoot, reviewIds, db }
    with-scenario-db.ts# withScenarioDb(scenario, fn)  integration helper
    library/           # example scenarios (dense-claims, blocked-claim, uncommitted, ...)
    index.ts           # scenarios registry (name -> Scenario)
  dev-cli.ts           # `dev seed` entrypoint (contributor-only), imports scenarios/*
```

## Work units (parallelizable)

Each unit lists `depends-on` and `done-when`. Units with no unmet dependency can run concurrently; the lanes below show the intended parallelism for a looped agent pool.

- **W0 - Export the session-agnostic core (D1).** `depends-on:` none. Export the full D1 surface (seed pipeline + diff helpers + serve helpers) from `local-engine.ts` (or a new `local-engine-core.ts` re-export). `done-when:` `bun run typecheck` passes and existing `cli.test.ts` is green; no behavior change.

- **W1 - Extract test scaffolding (spec milestone 1).** `depends-on:` none. Move `createFixtureRepo/runPaire/run/commitAll` to `test/support/fixtures.ts` and the server/API helpers to `test/support/review-api.ts` with an explicit disposer; refactor `cli.test.ts` onto them. `done-when:` `bun test test/cli.test.ts` green with zero behavior change.

- **W2 - `Scenario` type (spec milestone 2, comment ②).** `depends-on:` none. Author `types.ts`: `ScenarioClaimOp` = thin wrappers over real reflector inputs - `add` (with stable fixture-local `ref`, optional `supersedesRef`, inline `threadId/threadTitle/threadSummary`), `edit` (by `ref`), `acknowledge`. No `supersede` op, no standalone `threads` list. `Revision`, `Scenario` (`mode`, `base`, `revisions`). `done-when:` types compile and reference real exported reflector input types so a schema change breaks compilation.

- **W3 - Shared context derivation (D3).** `depends-on:` W0. `context.ts`: given `base` + `edits`, generate an in-memory unified diff with jsdiff (whitespace-normalized inputs, `context: 3`), then derive changed files + touched ranges through the exported `summarizeChangedFiles`/touched-range helpers. `done-when:` unit test shows the **derived changed-files + touched-ranges** (not raw diff text) match those from the equivalent `git diff -w` for the example edit shapes; if any shape can't reach parity, the git-temp-worktree fallback (D3) is wired instead.

- **W4 - `scenarioState()` (spec milestone 3).** `depends-on:` W2, W3. Build a single-revision `ReviewState` via `createReviewState()` + reducers, synthesize `ReviewContext` from W3 (fill required fields `annotatedDiffPath`/`diffArtifactPath`/`safeInspectionCommands` with inert placeholders, since it must not call `buildReviewContext`, which writes to disk). Apply each op through `applyReflectorCommand(state, cmd, { touchedRanges })` so evidence validation actually fires (the span check early-returns valid when `touchedRanges` is absent, `:1476`). Resolve each op's `ref` to the engine claim id for later `edit`/`supersedesRef`. No git, no DB. `done-when:` unit tests assert threads/claims/evidence/importance/status map through, and a deliberately out-of-range evidence op is rejected (not persisted).

- **W5 - `materializeScenario()` single-revision (spec milestone 4).** `depends-on:` W0, W1, W2. Generate fixture repo on `test/support/fixtures.ts`; commit `base`; `createContext({ cwd: repo, paireHome })`. **Committed mode:** commit the revision's `edits`, then `resolveReviewForCli(ctx, { base: <baseSha>, head: <headSha> }, { create:true, select:true })` (explicit selector - see P1-1). **Uncommitted mode:** leave `edits` dirty, `resolveReviewForCli(ctx, {}, { create:true, select:true })`. Apply claim ops via `applyReflectorCommand` (throw on `!ok`); `persistReviewState`. Reject `revisions.length > 1` with a clear "multi-version is milestone 7" message. `done-when:` integration test persists a real row for both modes with a **non-empty** resolvable diff. (Context comes from the git pipeline, so no dependency on W3.)

- **W6 - `paire dev seed` CLI + entrypoint (spec milestone 5, D2).** `depends-on:` W5. `test/support/dev-cli.ts` with `--scenario`, `--list`, `--serve`, `--out`, `--clean`; package.json `dev-seed` script. `--serve` must go through the real `openReviewUi(ctx, session, git, true)`/`ensureReviewServer` path (which spawns the daemon **and** registers the session **and** opens the token-bearing URL) - just spawning `_review-serve` renders nothing (no session registration/token, `:3470-3502`). `src/cli.ts` stays free of any `test/support` import. `done-when:` `bun run dev-seed -- --list` and `--scenario <name> --serve` open a populated review page from a checkout; `dist/paire` unaffected.

- **W7 - `withScenarioDb()` (spec milestone 6).** `depends-on:` W5. Temp `PAIRE_HOME` + repo via `materializeScenario`, invoke `fn({ db, repoRoot, reviewId, state })`, teardown in `finally`. `done-when:` integration test hits `/api/review` + `/api/review/diff` through `review-api.ts` and tears down, leaving `~/.paire` untouched.

- **W8 - Release-binary smoke test (D2, comment ④).** `depends-on:` W6. Build `dist/paire`; assert no `dev` command, and no `test/support`/scenario-name strings embedded. `done-when:` test fails if the dev machinery ever enters the shipped binary.

- **W9 - Corpus parity test (comment ⑤).** `depends-on:` W4, W5. For every library scenario, assert `scenarioState`'s synthesized `ReviewContext` matches `materializeScenario`'s git-derived one (changed files + touched ranges). `done-when:` green for all example scenarios.

- **W10 - Example scenario library + docs (spec milestone 8).** `depends-on:` W2 (authoring), W4+W5 (validation). `dense-claims`, a `blocked`/`superseded` claim, and an `uncommitted` scenario; document `bun run dev-seed` usage in `AGENTS.md`/`README`. `done-when:` each scenario materializes and serves; docs updated.

**Parallel lanes (for the loop):**
- Lane A (foundation, immediate): **W0**, **W1**, **W2** - no dependencies, run all three at once.
- Lane B (after A): **W5** (needs W0+W1+W2) and **W3** (needs W0) in parallel; then **W4** (needs W2+W3).
- Lane C (after W5): **W6**, **W7** in parallel; **W9** (needs W4+W5) once both land.
- Lane D (after W6): **W8**; **W10** finalizes once W4/W5 are green.

Critical path: W0 -> W5 -> W6 -> W8.

## Test plan

- `bun test` and `bun run typecheck` green throughout; `cli.test.ts` stays green after W0/W1 (no behavior change).
- **Unit:** `scenarioState()` produces expected threads/claims/evidence; evidence within declared touched ranges; a bad-evidence scenario is rejected by the reducer, not persisted.
- **Integration:** `materializeScenario()` committed + uncommitted -> real repo + persisted row + resolvable `/api/review` + `/api/review/diff`; `withScenarioDb` tears down and never touches `~/.paire`.
- **Parity:** W9 corpus test (D3).
- **Distribution:** W8 smoke test (D2).

## Acceptance criteria (v1)

- A contributor runs the dev entrypoint with `--scenario dense-claims --serve` and sees the full review page - claim cards and a working diff panel with evidence highlighting - with no model call.
- `const { state } = scenarioState(scenario)` asserts on threads/claims/evidence with no git/DB.
- An integration test materializes committed and uncommitted scenarios into an isolated `PAIRE_HOME`, asserts the two API routes, and tears down cleanly, leaving `~/.paire` untouched.
- The harness reuses the extracted `cli.test.ts` scaffolding; no second temp-repo/`PAIRE_HOME`/server harness is introduced.
- Adding/renaming a `ReviewState` field breaks the scenario builders at compile time.
- The compiled `dist/paire` contains no `dev` command and no `test/support`/scenario code (W8).
- A `revisions.length > 1` scenario is rejected in v1 with a clear "multi-version is milestone 7" message.

## Open questions from the spec - resolved here

1. **Run the pipeline outside the CLI/session flow?** Yes - `resolveReviewForCli(ctx, {}, { create:true })` is the whole path; D1 exports it + `createContext`. No deep refactor.
2. **Reuse `worktreeHash` for uncommitted targets?** Dissolved - the dirty-worktree branch of `resolveReviewForCli` already calls `computeWorktreeHash`; the builder just leaves the tree dirty. `computeWorktreeHash` is exported (D1) only for direct assertions.
3. **How does `--serve` pick the review?** `resolveReviewForCli(..., { select:true })` writes `review_selections`; reusing `openReviewUi`/`ensureReviewServer` (spawn + register + open token URL) against the fixtures `PAIRE_HOME` serves the selected review. No new selection wiring.
4. **Fixture repo location/lifecycle?** D4 - disposable fixtures home, reseed replaces rows, `--clean` teardown.
5. **In-memory vs git divergence?** D3 shared helper + W9 corpus parity test.
