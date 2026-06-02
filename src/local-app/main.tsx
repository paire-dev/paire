import { parsePatchFiles, resolveTheme } from "@pierre/diffs";
import {
  CodeView,
  type CodeViewHandle,
  type CodeViewItem,
} from "@pierre/diffs/react";
import {
  themeToTreeStyles,
  type GitStatus,
  type GitStatusEntry,
} from "@pierre/trees";
import { FileTree as PierreFileTree, useFileTree } from "@pierre/trees/react";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
  AlertTriangle,
  ArrowLeftFromLine,
  ArrowRightFromLine,
  Bot,
  Check,
  ChevronRight,
  FileCode,
  Files,
  FolderTree,
  MessageSquare,
  Monitor,
  Moon,
  PanelRightClose,
  PanelRightOpen,
  Sun,
  ThumbsUp,
} from "lucide-react";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { Streamdown } from "streamdown";

import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./components/ui/card";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "./components/ui/resizable";
import {
  ThemeProvider,
  useTheme,
  type Theme,
} from "./components/theme-provider";
import { cn } from "./lib/utils";
import "./styles.css";

type HumanStatus = "unreviewed" | "accepted" | "concern" | "irrelevant";
type FilterValue = "all" | string;

type Evidence = {
  claimId: string;
  filePath: string;
  startLine: number;
  endLine: number;
  symbol?: string;
  diff?: string;
  change: string;
};

type Claim = {
  id: string;
  title: string;
  description?: string;
  before?: string | null;
  after?: string | null;
  agentStatus: string;
  humanStatus: HumanStatus;
  updatedAt?: number;
  evidences: Evidence[];
};

type Thread = {
  id: string;
  title: string;
  summary: string;
  claims: Claim[];
};

type ReviewData = {
  session: { goal: string | null; projectKey: string };
  git: { branch: string; head: string; clean: boolean; status: string };
  burden: string;
  generatedAt: number;
  threads: Thread[];
};

type EvidenceSelection = {
  id: string;
  range: {
    start: number;
    end: number;
    side: "additions";
    endSide: "additions";
  };
};

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: "always",
      refetchOnReconnect: "always",
      staleTime: 0,
    },
  },
});

const pageClassName = "mx-auto w-full px-3 pt-5 sm:px-5 sm:pt-6";
const desktopPageClassName = cn(
  pageClassName,
  "flex h-dvh max-h-dvh flex-col overflow-hidden",
);
const proseClassName =
  "min-w-0 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_p]:m-0 [&_ul]:m-0 [&_ol]:m-0 [&_ul]:pl-5 [&_ol]:pl-5 [&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.9em]";
const humanStatusOptions: Array<HumanStatus> = [
  "unreviewed",
  "accepted",
  "concern",
  "irrelevant",
];

async function fetchReview() {
  const response = await fetch("/api/review", { cache: "no-store" });
  if (!response.ok) throw new Error("Failed to load review data.");
  return (await response.json()) as ReviewData;
}

async function fetchReviewDiff() {
  const response = await fetch("/api/review/diff", { cache: "no-store" });
  if (!response.ok) throw new Error("Failed to load review diff.");
  const payload = (await response.json()) as { diff?: string };
  return payload.diff ?? "";
}

function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <ReviewScreen />
      </QueryClientProvider>
    </ThemeProvider>
  );
}

function useMediaQuery(query: string) {
  const [matches, setMatches] = React.useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(query).matches;
  });

  React.useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

function ReviewScreen() {
  const isDesktopLayout = useMediaQuery("(min-width: 768px)");
  const [agentStatusFilter, setAgentStatusFilter] =
    React.useState<FilterValue>("all");
  const [humanStatusFilter, setHumanStatusFilter] =
    React.useState<FilterValue>("all");
  const [codePanelOpen, setCodePanelOpen] = React.useState(false);
  const [selectedEvidence, setSelectedEvidence] =
    React.useState<EvidenceSelection | null>(null);
  const codeViewRef = React.useRef<CodeViewHandle<undefined>>(null);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["review"],
    queryFn: fetchReview,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
  });
  const { data: rawDiff = "", isError: isDiffError } = useQuery({
    queryKey: ["review-diff"],
    queryFn: fetchReviewDiff,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
  });

  const codeItems = React.useMemo(() => parseCodeViewItems(rawDiff), [rawDiff]);
  const gitStatusEntries = React.useMemo(
    () => buildFileTreeGitStatus(codeItems, data?.git.status ?? ""),
    [codeItems, data?.git.status],
  );

  const scrollToEvidence = React.useCallback(
    (evidence: Evidence) => {
      const item = findCodeViewItem(codeItems, evidence.filePath);
      if (!item) return;

      const range = evidenceSelectionRange(evidence);
      const selection = { id: item.id, range };
      setCodePanelOpen(true);
      setSelectedEvidence(selection);
      requestCodeViewScroll(codeViewRef, {
        type: "range",
        id: item.id,
        range,
        align: "center",
        behavior: "smooth",
      });
    },
    [codeItems],
  );

  if (isLoading) {
    return (
      <main className={pageClassName}>
        <EmptyState>Loading review...</EmptyState>
      </main>
    );
  }

  if (isError || !data) {
    return (
      <main className={pageClassName}>
        <EmptyState>Unable to load review data.</EmptyState>
      </main>
    );
  }

  const agentStatusOptions = getAgentStatusOptions(data.threads);
  const filteredThreads = filterThreads(
    data.threads,
    agentStatusFilter,
    humanStatusFilter,
  );
  const totalClaimCount = countClaims(data.threads);
  const filteredClaimCount = countClaims(filteredThreads);
  const filtersAreDefault =
    agentStatusFilter === "all" && humanStatusFilter === "all";
  const filterBar = (
    <FilterBar
      agentStatus={agentStatusFilter}
      humanStatus={humanStatusFilter}
      agentStatusOptions={agentStatusOptions}
      totalClaimCount={totalClaimCount}
      filteredClaimCount={filteredClaimCount}
      sticky={!filtersAreDefault}
      onAgentStatusChange={setAgentStatusFilter}
      onHumanStatusChange={setHumanStatusFilter}
    />
  );
  const reviewContent = (
    <ReviewClaims
      allThreads={data.threads}
      filteredThreads={filteredThreads}
      onEvidenceSelect={scrollToEvidence}
    />
  );
  const reviewPanel = (
    <ReviewScrollPanel
      filterBar={filterBar}
      sidebarCollapsible={!codePanelOpen}
    >
      {!data.git.clean ? <DirtyWorktreeAlert /> : null}
      {reviewContent}
    </ReviewScrollPanel>
  );

  return (
    <main className={isDesktopLayout ? desktopPageClassName : pageClassName}>
      <header
        className={cn(
          "mb-5 flex shrink-0 flex-col gap-4 sm:flex-row sm:items-end sm:justify-between",
          isDesktopLayout && "mb-4",
        )}
      >
        <div>
          <p className="mb-1 text-xs font-bold uppercase text-muted-foreground">
            Paire Review
          </p>
          <div className="flex flex-wrap gap-2">
            <h1 className="text-2xl font-semibold leading-tight tracking-normal">
              {data.session.goal ?? data.session.projectKey}
            </h1>
            <Badge variant="outline">{data.git.branch}</Badge>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 text-sm text-muted-foreground">
          <Badge variant="outline">{data.burden}</Badge>
          <ModeToggle />
        </div>
      </header>

      {isDesktopLayout ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {codePanelOpen ? (
            <ResizablePanelGroup
              orientation="horizontal"
              className="min-h-0 flex-1 gap-0"
            >
              <ResizablePanel
                className="flex min-h-0 min-w-0 flex-col mr-4"
                defaultSize="50%"
              >
                {reviewPanel}
              </ResizablePanel>
              {/* <ResizableHandle className="border-none" withHandle /> */}
              <ResizablePanel
                className="flex min-h-0 flex-col"
                defaultSize="50%"
                minSize="30%"
              >
                <ReviewCodePanel
                  codeViewRef={codeViewRef}
                  className="h-full min-h-0"
                  diffError={isDiffError}
                  gitStatus={gitStatusEntries}
                  items={codeItems}
                  open
                  selectedEvidence={selectedEvidence}
                  onOpenChange={setCodePanelOpen}
                  onSelectedEvidenceChange={setSelectedEvidence}
                />
              </ResizablePanel>
            </ResizablePanelGroup>
          ) : (
            <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_auto] gap-4">
              {reviewPanel}
              <ReviewCodePanel
                codeViewRef={codeViewRef}
                className="h-full min-h-0"
                diffError={isDiffError}
                gitStatus={gitStatusEntries}
                items={codeItems}
                open={false}
                selectedEvidence={selectedEvidence}
                onOpenChange={setCodePanelOpen}
                onSelectedEvidenceChange={setSelectedEvidence}
              />
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {reviewPanel}
          <ReviewCodePanel
            codeViewRef={codeViewRef}
            className="h-[70vh]"
            diffError={isDiffError}
            gitStatus={gitStatusEntries}
            items={codeItems}
            open={codePanelOpen}
            selectedEvidence={selectedEvidence}
            onOpenChange={setCodePanelOpen}
            onSelectedEvidenceChange={setSelectedEvidence}
          />
        </div>
      )}
    </main>
  );
}

function ReviewScrollPanel({
  filterBar,
  children,
  sidebarCollapsible,
}: {
  filterBar: React.ReactNode;
  children: React.ReactNode;
  sidebarCollapsible: boolean;
}) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
        <div
          className={cn(
            "w-full max-w-3xl",
            sidebarCollapsible ? "mx-auto" : "mx-auto",
          )}
        >
          {filterBar}
          {children}
        </div>
      </div>
    </div>
  );
}

function ReviewClaims({
  allThreads,
  filteredThreads,
  onEvidenceSelect,
}: {
  allThreads: Thread[];
  filteredThreads: Thread[];
  onEvidenceSelect: (evidence: Evidence) => void;
}) {
  return (
    <section className="grid gap-3.5">
      {allThreads.length === 0 ? (
        <EmptyState>No review claims have been applied yet.</EmptyState>
      ) : filteredThreads.length === 0 ? (
        <EmptyState>No claims match the current filters.</EmptyState>
      ) : (
        filteredThreads.map((thread) => (
          <ThreadGroup
            key={thread.id}
            thread={thread}
            onEvidenceSelect={onEvidenceSelect}
          />
        ))
      )}
    </section>
  );
}

function parseCodeViewItems(rawDiff: string): CodeViewItem[] {
  if (!rawDiff.trim()) return [];
  return parsePatchFiles(rawDiff, "paire-review", false)
    .flatMap((patch) => patch.files)
    .map((fileDiff, index) => ({
      id: codeViewItemId(fileDiff.name, index),
      type: "diff",
      fileDiff,
    }));
}

function normalizeFilePath(filePath: string) {
  return filePath.replace(/^\.\/+/, "").replace(/\\/g, "/");
}

function parseGitStatusPorcelain(porcelain: string): GitStatusEntry[] {
  const entries: GitStatusEntry[] = [];

  for (const rawLine of porcelain.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line) continue;

    if (line.startsWith("!!")) {
      const path = normalizeFilePath(line.slice(3).trim());
      if (path) entries.push({ path, status: "ignored" });
      continue;
    }

    if (line.length < 4) continue;

    const indexStatus = line[0] ?? " ";
    const workTreeStatus = line[1] ?? " ";
    let pathPart = line.slice(3).trim();

    if (indexStatus === "?" && workTreeStatus === "?") {
      const path = normalizeFilePath(pathPart);
      if (path) entries.push({ path, status: "untracked" });
      continue;
    }

    const renameArrow = " -> ";
    const renameIndex = pathPart.indexOf(renameArrow);
    if (renameIndex >= 0) {
      pathPart = pathPart.slice(renameIndex + renameArrow.length).trim();
    }

    const path = normalizeFilePath(pathPart.replace(/^"|"$/g, ""));
    if (!path) continue;

    const status = gitStatusFromPorcelainCodes(indexStatus, workTreeStatus);
    if (status) entries.push({ path, status });
  }

  return entries;
}

function buildFileTreeGitStatus(
  items: CodeViewItem[],
  porcelain: string,
): GitStatusEntry[] {
  const byPath = new Map<string, GitStatus>();

  for (const entry of parseGitStatusPorcelain(porcelain)) {
    byPath.set(entry.path, entry.status);
  }

  for (const item of items) {
    if (item.type !== "diff") continue;
    const path = normalizeFilePath(item.fileDiff.name);
    if (byPath.has(path)) continue;

    const status = gitStatusFromDiffChangeType(item.fileDiff.type);
    if (status) byPath.set(path, status);
  }

  return [...byPath.entries()].map(([path, status]) => ({ path, status }));
}

function gitStatusFromDiffChangeType(type: string): GitStatus | null {
  switch (type) {
    case "new":
      return "added";
    case "deleted":
      return "deleted";
    case "rename-pure":
    case "rename-changed":
      return "renamed";
    case "change":
      return "modified";
    default:
      return null;
  }
}

function gitStatusFromPorcelainCodes(
  indexStatus: string,
  workTreeStatus: string,
): GitStatus | null {
  if (indexStatus === "R" || workTreeStatus === "R") return "renamed";
  if (indexStatus === "D" || workTreeStatus === "D") return "deleted";
  if (indexStatus === "A" || workTreeStatus === "A") return "added";
  if (indexStatus === "?" && workTreeStatus === "?") return "untracked";
  if (indexStatus === "!" && workTreeStatus === "!") return "ignored";
  if (
    indexStatus === "M" ||
    workTreeStatus === "M" ||
    indexStatus === "U" ||
    workTreeStatus === "U"
  ) {
    return "modified";
  }
  return null;
}

function filePathsMatch(left: string, right: string) {
  const a = normalizeFilePath(left);
  const b = normalizeFilePath(right);
  if (a === b) return true;
  if (a.endsWith(`/${b}`) || b.endsWith(`/${a}`)) return true;
  const aBase = a.split("/").pop();
  const bBase = b.split("/").pop();
  return aBase != null && aBase === bBase;
}

function findCodeViewItem(items: CodeViewItem[], filePath: string) {
  return items.find((item) => {
    if (item.type !== "diff") return false;
    return (
      filePathsMatch(item.fileDiff.name, filePath) ||
      (item.fileDiff.prevName != null &&
        filePathsMatch(item.fileDiff.prevName, filePath))
    );
  });
}

function codeViewItemId(filePath: string, index: number) {
  return `${index}:${filePath}`;
}

function evidenceSelectionRange(evidence: Evidence) {
  return {
    start: evidence.startLine,
    end: evidence.endLine,
    side: "additions" as const,
    endSide: "additions" as const,
  };
}

type CodeViewScrollRequest = Parameters<
  CodeViewHandle<undefined>["scrollTo"]
>[0];

function codeViewHasLayout(
  codeViewRef: React.RefObject<CodeViewHandle<undefined> | null>,
) {
  const root = codeViewRef.current?.getInstance()?.getContainerElement();
  return (root?.getBoundingClientRect().height ?? 0) > 0;
}

function requestCodeViewScroll(
  codeViewRef: React.RefObject<CodeViewHandle<undefined> | null>,
  target: CodeViewScrollRequest,
  maxAttempts = 24,
) {
  let frame = 0;
  let attempts = 0;
  let settleAttempts = 0;
  const maxSettleAttempts = 12;

  const tryScroll = () => {
    attempts += 1;
    if (codeViewRef.current != null && codeViewHasLayout(codeViewRef)) {
      codeViewRef.current.scrollTo(target);
      settleAttempts += 1;
      if (settleAttempts < maxSettleAttempts) {
        frame = window.requestAnimationFrame(tryScroll);
      }
      return;
    }
    if (attempts < maxAttempts) {
      frame = window.requestAnimationFrame(tryScroll);
    }
  };

  frame = window.requestAnimationFrame(tryScroll);
  return () => window.cancelAnimationFrame(frame);
}

const DIRTY_WORKTREE_AGENT_PROMPT =
  "commit changes; paire it; and follow all the instructions to review and apply.";

function CopyAgentPromptButton({ text }: { text: string }) {
  const [copied, setCopied] = React.useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="shrink-0 border-amber-300/80 bg-amber-100/60 h-6 px-2 text-amber-950 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-100 dark:hover:bg-amber-900/60"
      title="Copy agent prompt"
      aria-label="Copy agent prompt for coding agent"
      onClick={() => void copy()}
    >
      {copied ? (
        <>
          <Check className="size-3.5" aria-hidden />
          <span className="text-xs">Copied</span>
        </>
      ) : (
        <>
          <Bot className="size-3.5" aria-hidden />
          <span className="text-xs">Copy agent prompt</span>
        </>
      )}
    </Button>
  );
}

function DirtyWorktreeAlert() {
  return (
    <Alert className="mb-4 border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100">
      <AlertTriangle />
      <AlertTitle>
        These are <strong>not</strong> the latest changes.
      </AlertTitle>
      <AlertDescription className="text-amber-900 dark:text-amber-200">
        <div className="flex flex-wrap items-start gap-2">
          <p className="min-w-0 flex-1">
            Commit your worktree changes, then run <code>paire review</code>{" "}
            again to review the latest committed code.
          </p>
          <CopyAgentPromptButton text={DIRTY_WORKTREE_AGENT_PROMPT} />
        </div>
      </AlertDescription>
    </Alert>
  );
}

function ModeToggle() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="inline-flex overflow-hidden rounded-md border bg-background">
      <ThemeButton
        theme="light"
        active={theme === "light"}
        label="Light"
        onClick={() => setTheme("light")}
      >
        <Sun data-icon="inline-start" />
      </ThemeButton>
      <ThemeButton
        theme="dark"
        active={theme === "dark"}
        label="Dark"
        onClick={() => setTheme("dark")}
      >
        <Moon data-icon="inline-start" />
      </ThemeButton>
      <ThemeButton
        theme="system"
        active={theme === "system"}
        label="System"
        onClick={() => setTheme("system")}
      >
        <Monitor data-icon="inline-start" />
      </ThemeButton>
    </div>
  );
}

function ThemeButton({
  active,
  children,
  label,
  onClick,
  theme,
}: {
  active: boolean;
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  theme: Theme;
}) {
  return (
    <Button
      type="button"
      size="icon"
      variant={active ? "default" : "ghost"}
      className="size-7 rounded-none border-0 shadow-none"
      aria-label={`${label} theme`}
      aria-pressed={active}
      title={`${label} theme`}
      data-theme={theme}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function getAgentStatusOptions(threads: Thread[]) {
  const statuses = new Set<string>();
  for (const thread of threads) {
    for (const claim of thread.claims) {
      statuses.add(claim.agentStatus);
    }
  }
  return [...statuses].sort((a, b) =>
    statusLabel(a).localeCompare(statusLabel(b)),
  );
}

function filterThreads(
  threads: Thread[],
  agentStatus: FilterValue,
  humanStatus: FilterValue,
) {
  return threads
    .map((thread) => ({
      ...thread,
      claims: thread.claims.filter((claim) => {
        const agentMatches =
          agentStatus === "all" || claim.agentStatus === agentStatus;
        const humanMatches =
          humanStatus === "all" || claim.humanStatus === humanStatus;
        return agentMatches && humanMatches;
      }),
    }))
    .filter((thread) => thread.claims.length > 0);
}

function countClaims(threads: Thread[]) {
  return threads.reduce((total, thread) => total + thread.claims.length, 0);
}

function statusLabel(status: string) {
  return status.replaceAll("_", " ");
}

function FilterBar({
  agentStatus,
  humanStatus,
  agentStatusOptions,
  totalClaimCount,
  filteredClaimCount,
  sticky,
  onAgentStatusChange,
  onHumanStatusChange,
}: {
  agentStatus: FilterValue;
  humanStatus: FilterValue;
  agentStatusOptions: string[];
  totalClaimCount: number;
  filteredClaimCount: number;
  sticky: boolean;
  onAgentStatusChange: (status: FilterValue) => void;
  onHumanStatusChange: (status: FilterValue) => void;
}) {
  return (
    <div
      className={cn(
        "mb-4 flex flex-wrap items-center gap-x-4 gap-y-2",
        sticky &&
          "sticky top-0 z-10 border-b border-border/70 bg-muted/95 pb-3 pt-1 backdrop-blur-sm supports-backdrop-filter:bg-muted/80",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-2">
        <FilterGroup
          label="Claim"
          value={agentStatus}
          options={agentStatusOptions}
          onChange={onAgentStatusChange}
        />
        <FilterGroup
          label="Human"
          value={humanStatus}
          options={humanStatusOptions}
          onChange={onHumanStatusChange}
        />
      </div>
      <p className="ml-auto shrink-0 text-xs text-muted-foreground">
        {filteredClaimCount}/{totalClaimCount} claims
      </p>
    </div>
  );
}

function FilterGroup({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: FilterValue;
  options: string[];
  onChange: (value: FilterValue) => void;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <p className="mr-0.5 text-xs font-medium text-muted-foreground">
        {label}
      </p>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={label}>
        <FilterButton active={value === "all"} onClick={() => onChange("all")}>
          All
        </FilterButton>
        {options.map((option) => (
          <FilterButton
            key={option}
            active={value === option}
            onClick={() => onChange(option)}
          >
            {statusLabel(option)}
          </FilterButton>
        ))}
      </div>
    </div>
  );
}

function FilterButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={active ? "default" : "outline"}
      className="h-6 rounded-md px-2 text-xs"
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function ThreadGroup({
  thread,
  onEvidenceSelect,
}: {
  thread: Thread;
  onEvidenceSelect: (evidence: Evidence) => void;
}) {
  return (
    <section className="flex flex-col gap-1">
      <div className="flex flex-col gap-2 py-3 sticky top-0 z-10 bg-muted/95 backdrop-blur-sm supports-backdrop-filter:bg-muted/80">
        <div className="min-w-0">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h2 className="text-3xl font-light leading-snug">
              <AiText source={thread.title || "Behavior"} inline />
            </h2>
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary">
                {thread.claims.length}{" "}
                {thread.claims.length === 1 ? "claim" : "claims"}
              </Badge>
            </div>
          </div>
        </div>
      </div>
      {thread.summary ? (
        <div className="text-lg leading-relaxed text-muted-foreground pb-2">
          <AiText source={thread.summary} />
        </div>
      ) : null}
      <div className="grid gap-3">
        {thread.claims.map((claim, index) => (
          <ClaimCard
            key={claim.id}
            claim={claim}
            index={index}
            onEvidenceSelect={onEvidenceSelect}
          />
        ))}
      </div>
    </section>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="text-muted-foreground">{children}</CardContent>
    </Card>
  );
}

function ClaimTimeAgo({ updatedAt }: { updatedAt: number }) {
  const [, setTick] = React.useState(0);

  React.useEffect(() => {
    const interval = window.setInterval(() => {
      setTick((value) => value + 1);
    }, 60_000);
    return () => window.clearInterval(interval);
  }, []);

  return (
    <time
      className="whitespace-nowrap text-xs leading-none text-muted-foreground"
      dateTime={new Date(updatedAt).toISOString()}
    >
      {formatDistanceToNow(updatedAt, { addSuffix: true })}
    </time>
  );
}

function ClaimCard({
  claim,
  index,
  onEvidenceSelect,
}: {
  claim: Claim;
  index: number;
  onEvidenceSelect: (evidence: Evidence) => void;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between px-6">
        <CardTitle className="flex text-xl font-medium leading-snug">
          <span className="text-muted-foreground">{index + 1}.&nbsp;</span>
          <AiText source={claim.title} />
        </CardTitle>
        <CardAction className="flex flex-wrap items-center justify-end gap-2 ml-auto">
          {claim.updatedAt ? (
            <ClaimTimeAgo updatedAt={claim.updatedAt} />
          ) : null}
          <Badge variant="destructive">{statusLabel(claim.agentStatus)}</Badge>
        </CardAction>
      </CardHeader>

      <CardContent className="flex flex-col gap-8 px-6">
        {claim.description ? (
          <CardDescription className="text-base leading-relaxed">
            <AiText source={claim.description} />
          </CardDescription>
        ) : null}

        <ClaimDeltaPanels before={claim.before} after={claim.after} />

        {claim.evidences.length > 0 ? (
          <div className="flex flex-col gap-2">
            {claim.evidences.map((evidence, index) => (
              <EvidenceBlock
                key={`${evidence.filePath}:${evidence.startLine}:${evidence.endLine}:${index}`}
                evidence={evidence}
                onSelect={onEvidenceSelect}
              />
            ))}
          </div>
        ) : null}
      </CardContent>

      <CardFooter className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center px-6">
        <code className="font-mono text-sm text-muted-foreground">
          {claim.evidences.length === 0
            ? "No evidence span"
            : `${claim.evidences.length} evidence ${claim.evidences.length === 1 ? "span" : "spans"}`}
        </code>
        <ClaimActions claim={claim} />
      </CardFooter>
    </Card>
  );
}

type DeltaPanelColor = "red" | "blue" | "yellow" | "green";

function claimDeltaPanels(before?: string | null, after?: string | null) {
  const hasBefore = before != null && before !== "";
  const hasAfter = after != null && after !== "";
  if (!hasBefore && !hasAfter) return null;
  if (!hasBefore && hasAfter) {
    return [
      {
        label: "New",
        color: "blue" as const,
        direction: "right" as const,
        text: after!,
      },
    ];
  }
  if (hasBefore && !hasAfter) {
    return [
      {
        label: "Was",
        color: "red" as const,
        direction: "left" as const,
        text: before!,
      },
    ];
  }
  return [
    {
      label: "Before",
      color: "yellow" as const,
      direction: "left" as const,
      text: before!,
    },
    {
      label: "After",
      color: "green" as const,
      direction: "right" as const,
      text: after!,
    },
  ];
}

const deltaPanelColorClasses: Record<
  DeltaPanelColor,
  { border: string; label: string }
> = {
  red: {
    border: "border-red-500/30 bg-red-500/5",
    label: "text-red-600 dark:text-red-400",
  },
  blue: {
    border: "border-blue-500/30 bg-blue-500/5",
    label: "text-blue-600 dark:text-blue-400",
  },
  yellow: {
    border: "border-yellow-500/30 bg-yellow-500/5",
    label: "text-yellow-600 dark:text-yellow-400",
  },
  green: {
    border: "border-green-500/30 bg-green-500/5",
    label: "text-green-600 dark:text-green-400",
  },
};

function ClaimDeltaPanels({
  before,
  after,
}: {
  before?: string | null;
  after?: string | null;
}) {
  const panels = claimDeltaPanels(before, after);
  if (!panels) return null;
  return (
    <div
      className={cn(
        "grid gap-3",
        panels.length === 2 ? "sm:grid-cols-2" : "sm:grid-cols-1",
      )}
    >
      {panels.map((panel) => (
        <InfoPanel
          key={panel.label}
          label={panel.label}
          color={panel.color}
          direction={panel.direction}
          text={panel.text}
        />
      ))}
    </div>
  );
}

function EvidenceFilePathLabel({
  filePath,
  startLine,
  endLine,
}: Pick<Evidence, "filePath" | "startLine" | "endLine">) {
  const lastSlash = filePath.lastIndexOf("/");
  const directory = lastSlash >= 0 ? filePath.slice(0, lastSlash + 1) : "/";
  const fileName = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;

  return (
    <span className="inline-flex items-baseline truncate font-light text-xs">
      {/* <span className="inline-block max-w-30 truncate">{directory}</span> */}
      <span className="inline-block font-medium">{fileName}:</span>
      <span className="inline-block min-w-10 text-left">
        {startLine}-{endLine}
      </span>
    </span>
  );
}

function EvidenceBlock({
  evidence,
  onSelect,
}: {
  evidence: Evidence;
  onSelect: (evidence: Evidence) => void;
}) {
  return evidence.change ? (
    // <div className="flex gap-1 text-sm leading-relaxed text-foreground w-full before:content-['•'] before:mr-1 -ml-2 before:text-muted-foreground items-center">

    <Button
      variant="ghost"
      size="sm"
      className="w-full font-normal text-muted-foreground text-sm justify-start bg-muted/30"
      onClick={() => onSelect(evidence)}
    >
      <AiText source={evidence.change} inline />
      {/* <FileCode data-icon="inline-start" />
        <EvidenceFilePathLabel
          filePath={evidence.filePath}
          startLine={evidence.startLine}
          endLine={evidence.endLine}
        /> */}
      <ChevronRight className="size-4 ml-auto text-muted-foreground" />
    </Button>
  ) : // </div>
  null;
}

function InfoPanel({
  label,
  color,
  direction,
  text,
}: {
  label: string;
  color: DeltaPanelColor;
  direction: "left" | "right";
  text: string;
}) {
  const styles = deltaPanelColorClasses[color];
  return (
    <div
      className={cn("rounded-lg border p-4", styles.border)}
    >
      <div className="text-sm leading-relaxed text-muted-foreground">
        <span
          aria-hidden="true"
          className={cn(
            "mr-2 inline-flex items-center justify-center",
            styles.label,
          )}
        >
          {direction === "left" ? (
            <ArrowLeftFromLine className="relative top-0.5 size-4" />
          ) : (
            <ArrowRightFromLine className="relative top-0.5 size-4" />
          )}
        </span>
        <strong className={styles.label}>{label}:</strong>{" "}
        <AiText source={text} inline />
      </div>
    </div>
  );
}

function AiText({
  source,
  inline = false,
  className,
}: {
  source: string;
  inline?: boolean;
  className?: string;
}) {
  return (
    <Streamdown
      className={cn(proseClassName, inline && "inline *:inline", className)}
      parseIncompleteMarkdown={false}
    >
      {source}
    </Streamdown>
  );
}

function ReviewCodePanel({
  codeViewRef,
  className,
  diffError,
  gitStatus,
  items,
  open,
  selectedEvidence,
  onOpenChange,
  onSelectedEvidenceChange,
}: {
  codeViewRef: React.RefObject<CodeViewHandle<undefined> | null>;
  className?: string;
  diffError: boolean;
  gitStatus: GitStatusEntry[];
  items: CodeViewItem[];
  open: boolean;
  selectedEvidence: EvidenceSelection | null;
  onOpenChange: (open: boolean) => void;
  onSelectedEvidenceChange: (selection: EvidenceSelection | null) => void;
}) {
  const [fileTreeOpen, setFileTreeOpen] = React.useState(false);
  const { resolvedTheme } = useTheme();
  const diffTheme = resolvedTheme === "dark" ? "pierre-dark" : "pierre-light";

  React.useEffect(() => {
    if (!open || !selectedEvidence) return;

    return requestCodeViewScroll(codeViewRef, {
      type: "range",
      id: selectedEvidence.id,
      range: selectedEvidence.range,
      align: "center",
      behavior: "smooth",
    });
  }, [codeViewRef, open, selectedEvidence]);

  if (!open) {
    return (
      <aside className={cn("flex h-full items-start", className)}>
        <Button
          type="button"
          size="icon"
          variant="outline"
          className="h-10 w-10"
          aria-label="Open code panel"
          title="Open code panel"
          onClick={() => onOpenChange(true)}
        >
          <PanelRightOpen data-icon="inline-start" />
        </Button>
      </aside>
    );
  }

  return (
    <aside
      className={cn(
        "flex min-h-0 flex-col overflow-hidden rounded-lg border bg-background",
        className,
      )}
    >
      <div className="flex min-h-11 items-center justify-between gap-2 border-b px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-8"
            aria-label="Collapse code panel"
            title="Collapse code panel"
            onClick={() => onOpenChange(false)}
          >
            <PanelRightClose data-icon="inline-start" />
          </Button>
          <Files data-icon="inline-start" />
          <p className="truncate text-sm font-medium">Code</p>
          <Badge variant="outline" className="text-muted-foreground">
            {items.length} {items.length === 1 ? "file" : "files"}
          </Badge>
        </div>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-8"
          aria-label={fileTreeOpen ? "Collapse file tree" : "Expand file tree"}
          title={fileTreeOpen ? "Collapse file tree" : "Expand file tree"}
          onClick={() => setFileTreeOpen((value) => !value)}
        >
          <FolderTree data-icon="inline-start" />
        </Button>
      </div>

      <div
        className={cn(
          "grid min-h-0 flex-1",
          fileTreeOpen ? "grid-cols-[minmax(0,1fr)_240px]" : "grid-cols-1",
        )}
      >
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {diffError ? (
            <div className="p-4 text-sm text-muted-foreground">
              Unable to load diff.
            </div>
          ) : items.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">
              No committed diff is available.
            </div>
          ) : (
            <CodeView
              ref={codeViewRef}
              className="h-full min-h-0 overflow-y-auto overscroll-contain [&_code]:font-mono [&_pre]:font-mono bg-muted"
              items={items}
              selectedLines={selectedEvidence}
              onSelectedLinesChange={onSelectedEvidenceChange}
              disableWorkerPool
              options={{
                theme: diffTheme,
                diffStyle: "unified",
                overflow: "wrap",
                diffIndicators: "classic",
                disableLineNumbers: false,
                disableFileHeader: false,
                stickyHeaders: true,
                layout: {
                  paddingTop: 8,
                  paddingBottom: 16,
                  gap: 8,
                },
              }}
            />
          )}
        </div>

        {fileTreeOpen ? (
          <ReviewFileTree
            gitStatus={gitStatus}
            items={items}
            selectedId={selectedEvidence?.id ?? null}
            themeName={diffTheme}
            onSelect={(item) => {
              onSelectedEvidenceChange(null);
              requestCodeViewScroll(codeViewRef, {
                type: "item",
                id: item.id,
                align: "start",
                behavior: "smooth",
              });
            }}
          />
        ) : null}
      </div>
    </aside>
  );
}

function ReviewFileTree({
  gitStatus,
  items,
  selectedId,
  themeName,
  onSelect,
}: {
  gitStatus: GitStatusEntry[];
  items: CodeViewItem[];
  selectedId: string | null;
  themeName: "pierre-dark" | "pierre-light";
  onSelect: (item: CodeViewItem) => void;
}) {
  const itemsRef = React.useRef(items);
  const onSelectRef = React.useRef(onSelect);
  itemsRef.current = items;
  onSelectRef.current = onSelect;

  const paths = React.useMemo(
    () =>
      items.map((item) =>
        normalizeFilePath(
          item.type === "diff" ? item.fileDiff.name : item.file.name,
        ),
      ),
    [items],
  );

  const { model } = useFileTree({
    paths,
    gitStatus,
    density: "compact",
    flattenEmptyDirectories: true,
    icons: { colored: true, set: "standard" },
    initialExpansion: "open",
    stickyFolders: true,
    onSelectionChange: (selectedPaths) => {
      const path = selectedPaths[0];
      if (!path) return;
      const item = findCodeViewItem(itemsRef.current, path);
      if (item) onSelectRef.current(item);
    },
  });

  const [themeStyles, setThemeStyles] = React.useState<Record<string, string>>(
    {},
  );

  React.useEffect(() => {
    model.resetPaths(paths);
  }, [model, paths]);

  React.useEffect(() => {
    model.setGitStatus(gitStatus);
  }, [model, gitStatus]);

  React.useEffect(() => {
    let cancelled = false;
    void resolveTheme(themeName).then((theme) => {
      if (!cancelled) setThemeStyles(themeToTreeStyles(theme));
    });
    return () => {
      cancelled = true;
    };
  }, [themeName]);

  React.useEffect(() => {
    if (!selectedId) return;
    const item = items.find((entry) => entry.id === selectedId);
    if (!item || item.type !== "diff") return;
    model.scrollToPath(normalizeFilePath(item.fileDiff.name), { focus: false });
  }, [items, model, selectedId]);

  return (
    <div className="min-h-0 overflow-hidden border-l">
      <PierreFileTree
        model={model}
        className="h-full min-h-0"
        style={themeStyles}
      />
    </div>
  );
}

function ClaimActions({ claim }: { claim: Claim }) {
  const queryClient = useQueryClient();
  const acceptMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch(
        `/api/claims/${encodeURIComponent(claim.id)}/human-status`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ humanStatus: "accepted" }),
        },
      );
      if (!response.ok) throw new Error("Failed to accept claim.");
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["review"] }),
  });

  const commentMutation = useMutation({
    mutationFn: async () => {
      const note = window.prompt("Comment");
      if (!note) return;
      const response = await fetch(
        `/api/claims/${encodeURIComponent(claim.id)}/comment`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ note }),
        },
      );
      if (!response.ok) throw new Error("Failed to save comment.");
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["review"] }),
  });

  return (
    <div className="inline-flex w-full overflow-hidden rounded-lg border bg-background sm:w-auto">
      <Button
        type="button"
        variant="outline"
        className="flex-1 rounded-none border-0 shadow-none sm:flex-none"
        onClick={() => commentMutation.mutate()}
      >
        <MessageSquare data-icon="inline-start" />
        Comment
      </Button>
      <Button
        type="button"
        variant={claim.humanStatus === "accepted" ? "default" : "outline"}
        className="min-w-20 flex-1 rounded-none border-0 border-l shadow-none sm:flex-none"
        onClick={() => acceptMutation.mutate()}
      >
        {claim.humanStatus === "accepted" ? (
          <Check data-icon="inline-start" />
        ) : null}
        Ok
        <ThumbsUp data-icon="inline-end" />
      </Button>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
