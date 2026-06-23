# Implementation Plan: Local UI Polish — Context, Filtering, and Navigation

## Summary

Implement the three requirements from `spec.md`: branch summary, GitHub-style stats, and claim-scoped file filtering with a breadcrumb. All changes are confined to the local React UI (`src/local-app/main.tsx`) and the two review API endpoints.

## Current State

### API

`GET /api/review` returns:

```ts
type ReviewData = {
  session: { goal: string | null; projectKey: string };
  git: { branch: string; head: string; clean: boolean; status: string };
  burden: string; // e.g. "29 new"
  generatedAt: number;
  threads: Thread[];
};
```

`GET /api/worktree/diff` already returns per-file `additions`/`deletions` (used in `WorktreePreview`), but committed reviews expose no equivalent data.

### UI

- **Header** shows `reviewBurden` as a plain `<Badge>` — ambiguous to reviewers.
- **Claim panel** renders threads and claims; no reference to which files a claim touches.
- **Code panel** receives `codeItems` (all changed files) unconditionally; `selectedEvidence` only scrolls, it never filters.

## API Changes

### Extend `ReviewData` (committed)

```ts
type ReviewData = {
  // existing fields unchanged
  session: { goal: string | null; projectKey: string };
  git: { branch: string; head: string; clean: boolean; status: string };
  burden: string; // keep for backward compat
  generatedAt: number;
  threads: Thread[];

  // new
  summary: {
    text: string;
    source: "goal" | "threads" | "branch";
  };
  stats: {
    breakdown: {
      critical: number;   // combined lines touched (additions + deletions)
      important: number;
      minor: number;
      noise: { lines: number; files: number };
      uncategorized: { lines: number; files: number }; // files with no claim coverage
    };
  };
};
```

**`summary` derivation (server-side, in priority order):**

1. `session.goal` non-empty → `{ text: session.goal, source: "goal" }`.
2. Threads exist → join thread titles with `"; "` (truncate to 240 chars) → `{ text, source: "threads" }`.
3. Fallback → `{ text: git.branch, source: "branch" }`.

**`stats` derivation:**

1. For each changed file, compute `lines = additions + deletions`.
2. Determine the file's importance: the highest importance of any active claim whose evidence references that file. If no claim covers the file, it is `uncategorized`.
3. Accumulate `lines` into the matching bucket (`critical`, `important`, `minor`, `noise`, or `uncategorized`).
4. `noise` and `uncategorized` also track `files` (count of distinct files in that bucket).

Source data: `DraftPacket.changedFiles` for file line counts; active claims in the applied review for importance lookup.

### Extend `WorktreeReviewData`

Add identical `summary` and `stats` fields. `stats` uses the worktree diff file list (same data already in `WorktreeDiffData.files`). `summary` follows the same derivation using the worktree session goal and threads.

This makes both code paths in the UI symmetric.

## UI Changes

### 1. Branch Summary — `ReviewSummary`

New component rendered above `<ReviewClaims>` inside the review scroll panel.

```tsx
function ReviewSummary({ summary }: { summary: ReviewData["summary"] }) {
  if (!summary.text) return null;
  return (
    <p className="pb-4 text-lg leading-relaxed text-muted-foreground max-w-prose">
      {summary.text}
    </p>
  );
}
```

- Render for both committed and worktree paths.
- No visual distinction by `source` in v1; source is available for future use.

### 2. Importance Breakdown Bar — `ReviewStats`

Replace `<Badge variant="outline">{reviewBurden}</Badge>` in the header.

The bar shows critical / important / minor as proportional colored segments with their line counts always visible. Noise and uncategorized appear outside the bar, muted.

```tsx
function ReviewStats({ stats }: { stats: ReviewData["stats"] }) {
  const { breakdown } = stats;
  const barTotal = breakdown.critical + breakdown.important + breakdown.minor;

  return (
    <div className="flex items-center gap-2 text-xs">
      {barTotal > 0 && (
        <div className="flex h-2 w-24 overflow-hidden rounded-full">
          <BarSegment value={breakdown.critical} total={barTotal} className="bg-violet-500" />
          <BarSegment value={breakdown.important} total={barTotal} className="bg-orange-500" />
          <BarSegment value={breakdown.minor} total={barTotal} className="bg-muted-foreground" />
        </div>
      )}
      <div className="flex items-center gap-1.5 font-mono">
        {breakdown.critical > 0 && (
          <span className="text-violet-500">{fmt(breakdown.critical)}</span>
        )}
        {breakdown.important > 0 && (
          <span className="text-orange-500">{fmt(breakdown.important)}</span>
        )}
        {breakdown.minor > 0 && (
          <span className="text-muted-foreground">{fmt(breakdown.minor)}</span>
        )}
        {breakdown.noise.lines > 0 && (
          <span className="text-muted-foreground/50">
            {fmt(breakdown.noise.lines)} in {breakdown.noise.files}f noise
          </span>
        )}
        {breakdown.uncategorized.lines > 0 && (
          <span className="text-muted-foreground/50">
            {fmt(breakdown.uncategorized.lines)} in {breakdown.uncategorized.files}f uncategorized
          </span>
        )}
      </div>
    </div>
  );
}

// formats line counts: 1200 → "1.2k"
function fmt(n: number) { ... }

function BarSegment({ value, total, className }: { value: number; total: number; className: string }) {
  if (value === 0) return null;
  return <div className={className} style={{ width: `${(value / total) * 100}%` }} />;
}
```

While the API is being updated, fall back to placing all lines from `worktreeDiff.files` into `uncategorized` for the worktree path.

### 3. Claim-Scoped Filtering

**New state in `ReviewScreen`:**

```tsx
const [selectedClaimId, setSelectedClaimId] = React.useState<string | null>(null);
```

**Flat claim list for lookups:**

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

**Wiring:**

- Pass `filteredCodeItems` (not `codeItems`) to `ReviewCodePanel` and `ReviewCodeSheet`.
- Set `selectedClaimId` when a `ClaimCard` opens; clear it when the active claim closes.
- Clear `selectedClaimId` when the reset button is clicked (see §4).
- Keyboard `j`/`k` navigation already calls `onClaimOpenChange`; filtering follows automatically.
- Add `←`/`→` keyboard navigation to cycle between evidence spans within the selected claim, scrolling the code panel to each span in turn.

### 4. Filter Affordance in Code Panel Toolbar

Update `ReviewCodePanel` to accept:

```tsx
totalItems: number;       // always codeItems.length (unfiltered)
onClearFilter?: () => void;
```

Render when inactive (`items.length === totalItems`):

```tsx
<Badge variant="outline" className="text-muted-foreground">
  {items.length} {items.length === 1 ? "file" : "files"}
</Badge>
```

Render when active (`items.length < totalItems`):

```tsx
<Badge variant="outline" className="text-muted-foreground">
  {items.length} of {totalItems} files
</Badge>
<Button size="icon" variant="ghost" className="size-7"
  aria-label="Show all files" title="Show all files"
  onClick={onClearFilter}>
  <X />
</Button>
```

`X` is already available from lucide-react.

### 5. Claim Breadcrumb — `ClaimBreadcrumb`

Rendered inside `ReviewCodePanel`, between the toolbar and the `CodeView`, only when `selectedClaimId` is set.

The breadcrumb follows the full navigation path: **Thread > Claim > Evidence > Code**.

```tsx
function ClaimBreadcrumb({
  thread,
  claim,
  selectedEvidence,
  items,
}: {
  thread: Thread | null;
  claim: Claim | null;
  selectedEvidence: EvidenceSelection | null;
  items: CodeViewItem[];
}) {
  if (!claim || !thread) return null;

  const activeItem = selectedEvidence
    ? items.find((i) => i.id === selectedEvidence.id)
    : items[0];
  const activePath =
    activeItem?.type === "diff"
      ? normalizeFilePath(activeItem.fileDiff.name)
      : null;

  return (
    <div className="flex items-center gap-1 border-b px-3 py-1.5 text-xs text-muted-foreground overflow-hidden shrink-0">
      <span className="truncate font-medium">{thread.title}</span>
      <ChevronRight className="size-3 shrink-0" aria-hidden />
      <span className="truncate font-medium text-foreground">{claim.title}</span>
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

Pass the `Thread` and `Claim` objects (looked up from `selectedClaimId` + `reviewThreads`) and `filteredCodeItems` down through `ReviewCodePanel` props.

## Implementation Steps

1. **Server: extend `/api/review`** — add `summary` and `stats` to the committed review response.
2. **Server: extend `/api/worktree/review`** — add same fields for worktree path.
3. **UI: update `ReviewData` and `WorktreeReviewData` types** in `main.tsx`.
4. **UI: add `ReviewSummary`** — render above `ReviewClaims` in the scroll panel.
5. **UI: add `ReviewStats`** — replace the burden badge in the header.
6. **UI: add loading skeleton** — replace the current `null` loading return with a skeleton layout matching the header + claim panel structure.
7. **UI: add `selectedClaimId` state and `allClaims` memo** to `ReviewScreen`.
8. **UI: compute `filteredCodeItems`** and pass to `ReviewCodePanel`/`ReviewCodeSheet`.
9. **UI: update `ReviewCodePanel`** — accept `totalItems` + `onClearFilter`; render filter affordance.
10. **UI: add `ClaimBreadcrumb`** — render inside `ReviewCodePanel` above `CodeView`; pass thread + claim objects.
11. **UI: add `←`/`→` keyboard navigation** — cycle through evidence spans of the selected claim.

## Test Plan

- `bun test`
- `bun run typecheck`

**API:**
- `/api/review` returns `summary.source === "goal"` when session goal is set.
- `/api/review` returns `summary.source === "threads"` when goal is null and threads exist.
- `/api/review` returns `summary.source === "branch"` when goal is null and no threads exist.
- `/api/review` `stats` totals match sum of `changedFiles`.
- `/api/worktree/review` returns matching `summary` and `stats` shapes.

**UI:**
- `ReviewSummary` renders when text is non-empty; absent when empty.
- `ReviewStats` bar segments are proportional to their line counts; critical + important + minor sum matches total non-noise/non-uncategorized lines.
- `ReviewStats` noise and uncategorized indicators show correct line and file counts.
- A file referenced by claims of multiple importance levels is counted at the highest level only.
- Opening a claim sets `filteredCodeItems` to only that claim's files.
- Closing the claim (or clicking X) restores `codeItems`.
- Code panel toolbar shows `N of M files` + X when filtered.
- `ClaimBreadcrumb` shows `thread → claim → file` with no evidence selected.
- `ClaimBreadcrumb` shows `thread → claim → file → start–end` with evidence selected.
- `ClaimBreadcrumb` absent when no claim filter is active.
- `j`/`k` keyboard navigation updates `selectedClaimId` correctly.
- `←`/`→` keyboard navigation cycles through evidence spans of the selected claim.
- Loading skeleton renders during initial page load (before first API response).
- All existing interactions (evidence scroll, human status toggle, theme toggle) unchanged.
