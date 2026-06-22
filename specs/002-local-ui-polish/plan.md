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
    filesChanged: number;
    additions: number;
    deletions: number;
    files: Array<{ path: string; additions: number; deletions: number }>;
  };
};
```

**`summary` derivation (server-side, in priority order):**

1. `session.goal` non-empty → `{ text: session.goal, source: "goal" }`.
2. Threads exist → join thread titles with `"; "` (truncate to 240 chars) → `{ text, source: "threads" }`.
3. Fallback → `{ text: git.branch, source: "branch" }`.

**`stats` derivation:**

Source from `DraftPacket.changedFiles` (already tracked per session). Sum `additions`/`deletions` for totals; pass `changedFiles` as `files` directly.

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

### 2. Stats Badge — `ReviewStats`

Replace `<Badge variant="outline">{reviewBurden}</Badge>` in the header.

```tsx
function ReviewStats({ stats }: { stats: ReviewData["stats"] }) {
  return (
    <Badge variant="outline" className="font-mono text-xs gap-1">
      <span className="text-green-600 dark:text-green-400">+{stats.additions}</span>
      <span className="text-muted-foreground">/</span>
      <span className="text-red-600 dark:text-red-400">-{stats.deletions}</span>
      <span className="text-muted-foreground">/</span>
      <span>{stats.filesChanged} {stats.filesChanged === 1 ? "file" : "files"}</span>
    </Badge>
  );
}
```

While the API is being updated, fall back to computing stats from `worktreeDiff.files` for the worktree path (already available client-side).

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

```tsx
function ClaimBreadcrumb({
  claim,
  selectedEvidence,
  items,
}: {
  claim: Claim | null;
  selectedEvidence: EvidenceSelection | null;
  items: CodeViewItem[];
}) {
  if (!claim) return null;

  const activeItem = selectedEvidence
    ? items.find((i) => i.id === selectedEvidence.id)
    : items[0];
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

Pass the `Claim` object (looked up from `selectedClaimId` + `allClaims`) and `filteredCodeItems` down through `ReviewCodePanel` props.

## Implementation Steps

1. **Server: extend `/api/review`** — add `summary` and `stats` to the committed review response.
2. **Server: extend `/api/worktree/review`** — add same fields for worktree path.
3. **UI: update `ReviewData` and `WorktreeReviewData` types** in `main.tsx`.
4. **UI: add `ReviewSummary`** — render above `ReviewClaims` in the scroll panel.
5. **UI: add `ReviewStats`** — replace the burden badge in the header.
6. **UI: add `selectedClaimId` state and `allClaims` memo** to `ReviewScreen`.
7. **UI: compute `filteredCodeItems`** and pass to `ReviewCodePanel`/`ReviewCodeSheet`.
8. **UI: update `ReviewCodePanel`** — accept `totalItems` + `onClearFilter`; render filter affordance.
9. **UI: add `ClaimBreadcrumb`** — render inside `ReviewCodePanel` above `CodeView`.

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
- `ReviewStats` shows `+N / -N / N files` with correct numbers.
- Opening a claim sets `filteredCodeItems` to only that claim's files.
- Closing the claim (or clicking X) restores `codeItems`.
- Code panel toolbar shows `N of M files` + X when filtered.
- `ClaimBreadcrumb` shows `title → file` with no evidence selected.
- `ClaimBreadcrumb` shows `title → file → start–end` with evidence selected.
- `ClaimBreadcrumb` absent when no claim filter is active.
- `j`/`k` keyboard navigation updates `selectedClaimId` correctly.
- All existing interactions (evidence scroll, human status toggle, theme toggle) unchanged.
