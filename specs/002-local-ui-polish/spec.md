# Spec: Local UI Polish — Context, Filtering, and Navigation

## Problem

The local review UI shows claims well but does not give reviewers enough context to understand what a PR is about at a glance, and it does not connect claims to the specific code they describe.

Three concrete pain points:

1. **No overall summary.** A reviewer must read all claim threads before understanding what the PR changes. There is no one-line answer to "what is this PR?"

2. **Confusing stats.** The header shows a burden string like `"29 new"`. It is not clear whether that counts files, claims, or lines. Reviewers expect GitHub-style stats: lines added, lines deleted, files changed.

3. **No claim-to-code focus.** The code panel shows every changed file all the time. Selecting a claim scrolls to its evidence but does not narrow the view — reviewers still have to locate the relevant file themselves among all changed files.

## Goals

- A reviewer opening the UI should immediately understand what the PR is about.
- A reviewer clicking into a claim should see only the code that claim is about.
- A reviewer looking at the code panel should know which claim and file they are currently viewing.
- Stats in the header should be unambiguous and match what developers expect from code review tools.

## Requirements

### Branch Summary

- The top of the review panel shows a one-sentence summary of what the PR changes.
- The summary is derived automatically; no manual editing is required.
- The derivation source is transparent so reviewers can tell how confident the summary is.

### Stats Display

- The header shows total lines added, total lines deleted, and total files changed.
- Per-file line counts are available when the reviewer opens the code panel.
- The stats are consistent between committed and worktree reviews.

### Claim-Scoped File Filtering

- When a reviewer expands a claim, the code panel narrows to show only the files that claim references.
- The reviewer can tell at a glance that the view is filtered (visible indicator).
- The reviewer can return to the full diff with a single click.
- The filter follows the reviewer as they navigate between claims with the keyboard.

### Claim Navigation Breadcrumb

- While a claim filter is active, the code panel shows which claim is driving the current view.
- When the reviewer has also selected a specific evidence span, the breadcrumb shows the file and line range.
- The breadcrumb disappears when no claim filter is active.

## Out of Scope

- Human-editable branch summaries (derive only).
- Comments or agent feedback on claims.
- Changes to the claim data model, draft format, or apply flow.
- Per-file coverage status or review progress indicators (deferred to Workstream A schema work).

## Success Criteria

- A reviewer can answer "what is this PR about?" without opening any claim.
- A reviewer can answer "how big is this change?" from the header alone.
- Expanding a claim shows only the files that claim touches, with no manual navigation needed.
- A reviewer always knows which claim they are reviewing while looking at code.
- All existing interactions — keyboard navigation, evidence scrolling, human status toggle — continue to work.
