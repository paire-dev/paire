# Implementation Plan: Local UI Polish — Context, Filtering, and Navigation

## Summary

Make the local review UI the primary lens through which a human understands what changed and why. Today the UI shows claims well but lacks context about the overall change and doesn't let reviewers connect a claim directly to the code it describes. This plan adds a branch summary header, GitHub-style change stats, claim-scoped file filtering, and a claim→file→evidence breadcrumb — making it possible to review a PR end-to-end without leaving the Paire UI.

## Current State

The local React UI (`src/local-app/main.tsx`) has three areas: a sticky header, a claim scroll panel, and a resizable code panel.

**Header** shows:
- Project identity + branch badge
- Human-status filter nav (All / Unreviewed / Accepted) + expand/collapse toggle
- Burden badge (e.g., `"29 new"`) + mode toggle

**Claim panel** shows threads → claims with importance icons, before/after delta panels, and evidence blocks that scroll the code panel when clicked.

**Code panel** shows the full diff for every changed file. It does not filter based on which claim is open.

### Current API shape

`GET /api/review` returns:

```ts
type ReviewData = {
  session: { goal: string | null; projectKey: string };
  git: { branch: string; head: string; clean: boolean; status: string };
  burden: string; // e.g. "29 new" — confusing to reviewers
  generatedAt: number;
  threads: Thread[];
};
```

`GET /api/worktree/diff` already returns per-file `additions`/`deletions` (used in `WorktreePreview`), but committed reviews expose no per-file stats.

### What is missing

1. **No branch summary.** Reviewers must read all threads before understanding what the PR is about.
2. **Confusing stats.** `burden: "29 new"` is ambiguous: is that files, claims, or lines?
3. **No claim→code focus.** The code panel shows all files always; selecting a claim only scrolls to its evidence but doesn't hide unrelated files.
4. **No breadcrumb.** After clicking an evidence block there is no persistent indication of which claim and file the code view is showing.

## Goals

- Show a one-line branch summary at the top of the review panel, auto-derived from `session.goal` or thread titles.
- Replace the burden badge with GitHub-style stats: `+123 / -45 / 21 files`.
- Filter the code panel to show only files referenced by the currently expanded claim.
- Add a visible `N of M files` count and a reset control when the claim filter is active.
- Add a breadcrumb inside the code panel that shows the current claim → file → evidence span while a claim filter is active.

## Non-Goals

- Do not add human-editable summaries; derive only.
- Do not redesign the claim panel layout or thread grouping.
- Do not add comments, remote collaboration, or the agent feedback loop (deferred).
- Do not change the evidence data model, draft format, or apply flow.
- Do not add new Radix UI dependencies; use existing shadcn/Base UI components and lucide icons.

## API Changes

### Extend `/api/review`

Add `summary` and `stats` to the committed review response:

```ts
type ReviewData = {
  // existing fields unchanged
  session: { goal: string | null; projectKey: string };
  git: { branch: string; head: string; clean: boolean; status: string };
  burden: string;
  generatedAt: number;
  threads: Thread[];

  // new
  summary: {
    text: string;
    source: "goal" | "threads" | "branch";
  };
  stats: {
    filesChanged: number;
    additions: number;
    deletions: number;
    files: Array<{ path: string; additions: number; deletions: number }>;
  };
};
```

**`summary` derivation (server-side, in priority order):**

1. If `session.goal` is non-empty → `{ text: session.goal, source: "goal" }`.
2. Else if threads exist → join thread titles with `"; "` (truncate to 120 chars) → `{ text, source: "threads" }`.
3. Else → `{ text: git.branch, source: "branch" }`.

**`stats` derivation:**

- Source from `DraftPacket.changedFiles` (already tracked per session).
- `filesChanged = changedFiles.length`.
- `additions` and `deletions` are sums across all files.
- `files` is the per-file breakdown directly from `changedFiles`.

### Extend `/api/worktree/review`

Add the same `summary` and `stats` fields. For worktree reviews:

- `stats` comes from the worktree diff computation (same data as `WorktreeDiffData.files`).
- `summary` follows the same derivation rules using the worktree session goal and threads.

This makes the UI code symmetric: both code paths receive identical shapes.

## UI Changes

### 1. Branch Summary

**Where:** Immediately above the thread list, inside the review scroll panel.

**Component:** New `ReviewSummary`.

```tsx
function ReviewSummary({ summary }: { summary: ReviewData["summary"] }) {
  if (!summary.text) return null;
  return (
    <p className="pb-4 text-lg leading-relaxed text-muted-foreground max-w-prose">
      {summary.text}
      {summary.source === "branch" && (
        <span className="ml-1.5 text-sm opacity-60">({summary.text})</span>
      )}
    </p>
  );
}
```

Insert between `<header>` and `<ReviewClaims>` in the review scroll panel.

### 2. Stats Display

**Where:** Replace the `reviewBurden` badge in the header.

**Before:**
```tsx
<Badge variant="outline">{reviewBurden}</Badge>
```

**After:**
```tsx
function ReviewStats({ stats }: { stats: ReviewData["stats"] }) {
  return (
    <Badge variant="outline" className="font-mono text-xs gap-1">
      <span className="text-green-600 dark:text-green-400">+{stats.additions}</span>
      <span className="text-muted-foreground">/</span>
      <span className="text-red-600 dark:text-red-400">-{stats.deletions}</span>
      <span className="text-muted-foreground">/</span>
      <span>{stats.filesChanged} files</span>
    </Badge>
  );
}
```

- For committed reviews: use `data.stats`.
- For worktree reviews: use `worktreeReview.stats` (or fall back to computing from `worktreeDiff.files` while the API is being updated).
- Keep `burden` available in the response for backward compatibility; stop rendering it in the UI.

### 3. Claim-Scoped File Filtering

**Goal:** Expanding a claim narrows the code panel to only files that claim's evidences reference.

**New state in `ReviewScreen`:**

```tsx
const [selectedClaimId, setSelectedClaimId] = React.useState<string | null>(null);
```

**Flat claim list** (needed for lookup):

```tsx
const allClaims = React.useMemo(
  () => reviewThreads.flatMap((t) => t.claims),
  [reviewThreads],
);
```

**Filtered code items:**

```tsx
const filteredCodeItems = React.useMemo(() => {
  if (!selectedClaimId) return codeItems;
  const claim = allClaims.find((c) => c.id === selectedClaimId);
  if (!claim || claim.evidences.length === 0) return codeItems;
  const paths = new Set(claim.evidences.map((e) => normalizeFilePath(e.filePath)));
  return codeItems.filter(
    (item) => item.type === "diff" && paths.has(normalizeFilePath(item.fileDiff.name)),
  );
}, [codeItems, selectedClaimId, allClaims]);
```

Pass `filteredCodeItems` to both `ReviewCodePanel` and `ReviewCodeSheet` instead of `codeItems`.

**When to set `selectedClaimId`:**

- Set to `claimId` when a `ClaimCard` opens (`onClaimOpenChange(claimId, true)`).
- Clear to `null` when a claim closes **and** it was the currently selected claim.
- Clear to `null` when the user clicks the reset button in the code panel toolbar.

**Keyboard nav interaction:** `j`/`k` navigation already calls `onClaimOpenChange`; the filtering will follow automatically.

### 4. Filter Affordance in Code Panel Toolbar

**Where:** In `ReviewCodePanel`, the toolbar area that currently shows `{items.length} files`.

Update `ReviewCodePanel` props:

```tsx
type ReviewCodePanelProps = {
  // existing
  items: CodeViewItem[];
  // new
  totalItems: number; // unfiltered count, always pass codeItems.length
  onClearFilter?: () => void; // present when filter is active
  // ...rest unchanged
};
```

**Render when filter is inactive** (`items.length === totalItems`):
```tsx
<Badge variant="outline" className="text-muted-foreground">
  {items.length} {items.length === 1 ? "file" : "files"}
</Badge>
```

**Render when filter is active** (`items.length < totalItems`):
```tsx
<Badge variant="outline" className="text-muted-foreground">
  {items.length} of {totalItems} files
</Badge>
<Button size="icon" variant="ghost" className="size-7" onClick={onClearFilter}
  aria-label="Show all files" title="Show all files">
  <X />
</Button>
```

### 5. Claim Breadcrumb

**Where:** Inside `ReviewCodePanel`, between the toolbar and the `CodeView`, only when `selectedClaimId` is set.

**Component:** New `ClaimBreadcrumb`.

```tsx
function ClaimBreadcrumb({
  claim,
  selectedEvidence,
  codeItems,
}: {
  claim: Claim | null;
  selectedEvidence: EvidenceSelection | null;
  codeItems: CodeViewItem[];
}) {
  if (!claim) return null;

  const activeItem = selectedEvidence
    ? codeItems.find((i) => i.id === selectedEvidence.id)
    : codeItems[0];
  const activePath =
    activeItem?.type === "diff"
      ? normalizeFilePath(activeItem.fileDiff.name)
      : null;

  return (
    <div className="flex items-center gap-1 border-b px-3 py-1.5 text-xs text-muted-foreground overflow-hidden shrink-0">
      <span className="truncate max-w-[40%] font-medium text-foreground">
        {claim.title}
      </span>
      {activePath && (
        <>
          <ChevronRight className="size-3 shrink-0" aria-hidden />
          <span className="truncate font-mono">{activePath}</span>
        </>
      )}
      {selectedEvidence && (
        <>
          <ChevronRight className="size-3 shrink-0" aria-hidden />
          <span className="font-mono tabular-nums shrink-0">
            {selectedEvidence.range.start}–{selectedEvidence.range.end}
          </span>
        </>
      )}
    </div>
  );
}
```

Pass the selected `Claim` object (looked up from `selectedClaimId`) and existing `selectedEvidence` and `filteredCodeItems` into the panel.

## Implementation Steps

1. **Server: extend `/api/review`**
   - Add `summary` derivation from goal → thread titles → branch name.
   - Add `stats` from `DraftPacket.changedFiles`.
   - Update the TypeScript type returned by the endpoint.

2. **Server: extend `/api/worktree/review`**
   - Add `summary` using same derivation logic for worktree session.
   - Add `stats` from worktree diff file list.

3. **UI: `ReviewSummary` component**
   - Add above `<ReviewClaims>` in the review scroll panel for both committed and worktree paths.

4. **UI: `ReviewStats` component**
   - Replace the `reviewBurden` badge in the header.
   - Use `data.stats` for committed; compute from `worktreeDiff.files` for worktree (or `worktreeReview.stats` once the API is updated).

5. **UI: claim-scoped filtering state**
   - Add `selectedClaimId` state and `allClaims` memo to `ReviewScreen`.
   - Wire `onClaimOpenChange` in `ReviewClaims` to call back with the claim id.
   - Compute `filteredCodeItems` memo.
   - Pass `filteredCodeItems` and `totalItems={codeItems.length}` to `ReviewCodePanel`/`ReviewCodeSheet`.
   - Pass `onClearFilter` callback.

6. **UI: filter affordance in code panel toolbar**
   - Update `ReviewCodePanel` to accept `totalItems` and `onClearFilter`.
   - Render `N of M files` + X button when filter is active.

7. **UI: `ClaimBreadcrumb`**
   - Render inside `ReviewCodePanel` between toolbar and `CodeView`.
   - Look up active `Claim` from `selectedClaimId` + `allClaims`; pass down through props.

## Test Plan

- `bun test`
- `bun run typecheck`

**API tests:**
- `/api/review` returns `summary.source === "goal"` when session goal is set.
- `/api/review` returns `summary.source === "threads"` when goal is null but threads exist.
- `/api/review` returns `summary.source === "branch"` when goal is null and no threads.
- `/api/review` `stats.additions` and `stats.deletions` match sum of `changedFiles`.
- `/api/worktree/review` returns matching `summary` and `stats` shapes.

**UI/integration tests:**
- `ReviewSummary` renders goal text when source is `"goal"`.
- `ReviewSummary` does not render when `text` is empty.
- `ReviewStats` shows `+N / -N / N files` with correct numbers.
- Expanding a claim filters `filteredCodeItems` to only files that claim references.
- Closing the claim clears `selectedClaimId` and restores full file list.
- The X reset button in the code panel toolbar restores the full file list.
- `ClaimBreadcrumb` renders `claim title → file` when no evidence is selected.
- `ClaimBreadcrumb` renders `claim title → file → start–end` when evidence is selected.
- `ClaimBreadcrumb` is absent when no claim filter is active.
- Filtering works on both committed and worktree review paths.
- Existing keyboard shortcuts (`j`/`k` navigation, `a` approval) still work.

## Acceptance Criteria

- A reviewer opening the UI immediately sees a one-line summary of what the PR is about.
- The header shows `+N / -N / N files` instead of the old burden string.
- Expanding a claim narrows the code panel to only files that claim references.
- When a filter is active, the toolbar shows `N of M files` and a clear-filter button.
- A breadcrumb in the code panel shows which claim, file, and span the current view corresponds to.
- All existing interactions — evidence scrolling, human status toggle, keyboard nav, theme toggle — continue to work unchanged.
- No new Radix UI dependencies are introduced.
