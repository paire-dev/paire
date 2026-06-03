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
import { SiGithub } from "@icons-pack/react-simple-icons";
import { formatDistanceToNow } from "date-fns";
import {
  AlertTriangle,
  ArrowLeftFromLine,
  ArrowRightFromLine,
  Bot,
  Check,
  ChevronRight,
  Columns2,
  FileCode,
  Files,
  FolderTree,
  ListOrdered,
  MessageSquare,
  Monitor,
  Moon,
  PanelRightClose,
  PanelRightOpen,
  Rows2,
  Sun,
  ThumbsUp,
  WrapText,
} from "lucide-react";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { Streamdown } from "streamdown";

import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { ButtonGroup } from "./components/ui/button-group";
import { Toggle } from "./components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "./components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./components/ui/tooltip";
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
  ThemeProvider,
  useTheme,
  type Theme,
} from "./components/theme-provider";
import { cn } from "./lib/utils";
import "./styles.css";

/** Injected into @pierre/diffs shadow DOM via `unsafeCSS`. */
const DIFF_SELECTED_LINE_UNSAFE_CSS = `
  [data-selected-line][data-column-number] {
    box-shadow: inset 2px 0 0 var(--primary);
  }
  [data-selected-line]:is([data-line], [data-no-newline]) {
  }
  [data-selected-line][data-gutter-buffer] {

  }
`;

type HumanStatus = "unreviewed" | "accepted";
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

const pageClassName = "mx-auto w-full px-3 sm:px-5";
const desktopPageClassName = cn(
  pageClassName,
  "flex h-dvh max-h-dvh flex-col overflow-hidden",
);
const proseClassName =
  "min-w-0 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_p]:m-0 [&_ul]:m-0 [&_ol]:m-0 [&_ul]:pl-5 [&_ol]:pl-5 [&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.9em]";
const REVIEW_TOKEN_STORAGE_KEY = "paire-review-token";
const LOADING_STATE_DELAY_MS = 250;
const reviewToken = resolveReviewToken();

function resolveReviewToken() {
  if (typeof window === "undefined") return "";
  const urlToken = reviewTokenFromUrl();
  if (urlToken) {
    storeReviewToken(urlToken);
    removeReviewTokenFromHash();
    return urlToken;
  }
  return storedReviewToken();
}

function reviewTokenFromUrl() {
  return (
    new URLSearchParams(
      window.location.hash.startsWith("#")
        ? window.location.hash.slice(1)
        : window.location.search,
    ).get("token") ?? ""
  );
}

function removeReviewTokenFromHash() {
  if (!window.location.hash.startsWith("#")) return;
  const hashParams = new URLSearchParams(window.location.hash.slice(1));
  if (!hashParams.has("token")) return;
  hashParams.delete("token");
  const nextUrl = new URL(window.location.href);
  const nextHash = hashParams.toString();
  nextUrl.hash = nextHash ? `#${nextHash}` : "";
  window.history.replaceState(null, "", nextUrl);
}

function storeReviewToken(token: string) {
  try {
    window.localStorage.setItem(REVIEW_TOKEN_STORAGE_KEY, token);
  } catch {
    // Storage can be disabled; the in-memory token still works for this page.
  }
}

function storedReviewToken() {
  try {
    return window.localStorage.getItem(REVIEW_TOKEN_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function reviewApiHeaders(headers: Record<string, string> = {}) {
  return {
    ...headers,
    "x-paire-review-token": reviewToken,
  };
}

class ReviewApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

function shouldRetryReviewQuery(failureCount: number, error: unknown) {
  if (error instanceof ReviewApiError && error.status === 401) return false;
  return failureCount < 2;
}

// Returns a HTML DOM node id-friendly string for an Evidence.
const getEvidenceId = (evidence: Evidence) => {
  // Sanitize filePath for id: replace slashes and backslashes, remove weird chars
  // id: claim-<claimId>_<fileName>-<start>-<end>
  const claimPart = `claim-${evidence.claimId}`;
  const filePart = evidence.filePath
    .replace(/[^\w\-\.]+/g, "-") // keep [a-zA-Z0-9_-\.], replace others with -
    .replace(/^-+/, "") // don't start with hyphen
    .replace(/-+$/, ""); // don't end with hyphen

  const linesPart = `${evidence.startLine}-${evidence.endLine}`;
  // Always start with a letter for HTML id
  return `evid-${claimPart}_${filePart}_${linesPart}`.replace(
    /[^a-zA-Z0-9_\-:.]/g,
    "",
  );
};

async function fetchReview() {
  const response = await fetch("/api/review", {
    cache: "no-store",
    headers: reviewApiHeaders(),
  });
  if (!response.ok) {
    throw new ReviewApiError("Failed to load review data.", response.status);
  }
  return (await response.json()) as ReviewData;
}

async function fetchReviewDiff() {
  const response = await fetch("/api/review/diff", {
    cache: "no-store",
    headers: reviewApiHeaders(),
  });
  if (!response.ok) {
    throw new ReviewApiError("Failed to load review diff.", response.status);
  }
  const payload = (await response.json()) as { diff?: string };
  return payload.diff ?? "";
}

function App() {
  return (
    <ThemeProvider>
      <TooltipProvider>
        <QueryClientProvider client={queryClient}>
          <ReviewScreen />
        </QueryClientProvider>
      </TooltipProvider>
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

function useDelayedValue(value: boolean, delayMs: number) {
  const [delayedValue, setDelayedValue] = React.useState(false);

  React.useEffect(() => {
    if (!value) {
      setDelayedValue(false);
      return;
    }
    const timeout = window.setTimeout(() => setDelayedValue(true), delayMs);
    return () => window.clearTimeout(timeout);
  }, [delayMs, value]);

  return delayedValue;
}

function ReviewScreen() {
  const isDesktopLayout = useMediaQuery("(min-width: 768px)");
  const [humanStatusFilter, setHumanStatusFilter] =
    React.useState<FilterValue>("all");
  const [codePanelOpen, setCodePanelOpen] = React.useState(false);
  const [selectedEvidence, setSelectedEvidence] =
    React.useState<EvidenceSelection | null>(null);
  const codeViewRef = React.useRef<CodeViewHandle<undefined>>(null);
  const {
    data,
    error: reviewError,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ["review"],
    queryFn: fetchReview,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    retry: shouldRetryReviewQuery,
  });
  const { data: rawDiff = "", isError: isDiffError } = useQuery({
    queryKey: ["review-diff"],
    queryFn: fetchReviewDiff,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    retry: shouldRetryReviewQuery,
  });

  const codeItems = React.useMemo(() => parseCodeViewItems(rawDiff), [rawDiff]);
  const gitStatusEntries = React.useMemo(
    () => buildFileTreeGitStatus(codeItems, data?.git.status ?? ""),
    [codeItems, data?.git.status],
  );

  const evidenceIsSelected = React.useCallback(
    (evidence: Evidence) =>
      isEvidenceSelected(evidence, selectedEvidence, codeItems),
    [codeItems, selectedEvidence],
  );
  const showLoadingState = useDelayedValue(isLoading, LOADING_STATE_DELAY_MS);

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

      window.history.pushState(null, "", `#${getEvidenceId(evidence)}`);
    },
    [codeItems],
  );

  if (isLoading) {
    if (!showLoadingState) return null;
    return (
      <main className={pageClassName}>
        <EmptyState
          title="Opening review"
          description="Preparing the latest review state."
        />
      </main>
    );
  }

  if (isError || !data) {
    const authError =
      reviewError instanceof ReviewApiError && reviewError.status === 401;
    return (
      <main className={pageClassName}>
        <EmptyState
          title={authError ? "Review link expired" : "Review unavailable"}
          description={
            authError
              ? "Open the Review UI URL printed by Paire again. The local server needs the token from that link."
              : "Paire could not load this review. Check that the local review server is still running, then reopen the Review UI URL."
          }
        />
      </main>
    );
  }

  const filteredThreads = filterThreads(data.threads, humanStatusFilter);
  const reviewContent = (
    <ReviewClaims
      allThreads={data.threads}
      filteredThreads={filteredThreads}
      isEvidenceSelected={evidenceIsSelected}
      onEvidenceSelect={scrollToEvidence}
    />
  );
  const reviewPanel = (
    <ReviewScrollPanel sidebarCollapsible={!codePanelOpen}>
      {!data.git.clean ? <DirtyWorktreeAlert /> : null}
      {reviewContent}
    </ReviewScrollPanel>
  );

  return (
    <main className={isDesktopLayout ? desktopPageClassName : pageClassName}>
      <header
        className={cn(
          "mb-5 grid shrink-0 gap-4 p-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-center",
          isDesktopLayout && "mb-4",
        )}
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <ProjectIdentity projectKey={data.session.projectKey} />
            <Badge variant="outline">{data.git.branch}</Badge>
          </div>
        </div>
        <HumanFilterNav
          value={humanStatusFilter}
          onChange={setHumanStatusFilter}
        />
        <div className="flex flex-wrap justify-start gap-2 text-sm text-muted-foreground sm:justify-end">
          <Badge variant="outline">{data.burden}</Badge>
          <ModeToggle />
        </div>
      </header>

      {isDesktopLayout ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div
            className={cn(
              "grid min-h-0 flex-1 gap-4",
              codePanelOpen
                ? "grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
                : "grid-cols-[minmax(0,1fr)_auto]",
            )}
          >
            {reviewPanel}
            <ReviewCodePanel
              codeViewRef={codeViewRef}
              className="h-full min-h-0"
              diffError={isDiffError}
              gitStatus={gitStatusEntries}
              items={codeItems}
              open={codePanelOpen}
              selectedEvidence={selectedEvidence}
              onOpenChange={setCodePanelOpen}
              onSelectedEvidenceChange={setSelectedEvidence}
            />
          </div>
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

function ProjectIdentity({ projectKey }: { projectKey: string }) {
  const project = parseProjectKey(projectKey);

  return (
    <div className="flex min-w-0 items-center gap-2">
      <ProjectAvatar project={project} />
      <span className="min-w-0 truncate text-base font-semibold leading-tight">
        {project.repo}
      </span>
      {project.hash ? (
        <span className="shrink-0 font-mono text-[11px] leading-none text-muted-foreground">
          {project.hash}
        </span>
      ) : null}
    </div>
  );
}

function parseProjectKey(projectKey: string) {
  const parts = projectKey.split("/").filter(Boolean);
  if (parts[0] === "github" && parts.length >= 4) {
    return {
      provider: "github",
      owner: parts[1] ?? "",
      repo: parts[2] ?? projectKey,
      hash: parts[3] ?? "",
    };
  }
  if (parts[0] === "local" && parts.length >= 3) {
    return {
      provider: "local",
      owner: "",
      repo: parts[1] ?? projectKey,
      hash: parts[2] ?? "",
    };
  }
  return { provider: "unknown", owner: "", repo: projectKey, hash: "" };
}

type ProjectKeyInfo = ReturnType<typeof parseProjectKey>;

function ProjectAvatar({ project }: { project: ProjectKeyInfo }) {
  const [failed, setFailed] = React.useState(false);

  if (project.provider !== "github") return null;

  if (!project.owner || failed) {
    return <SiGithub className="size-5 shrink-0 text-foreground" aria-hidden />;
  }

  return (
    <img
      className="size-6 shrink-0 rounded-md border border-border bg-background"
      src={`https://github.com/${encodeURIComponent(project.owner)}.png?size=64`}
      alt={`${project.owner} avatar`}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

function HumanFilterNav({
  value,
  onChange,
}: {
  value: FilterValue;
  onChange: (value: FilterValue) => void;
}) {
  return (
    <div className="flex justify-start sm:justify-center">
      <div
        className="inline-flex overflow-hidden rounded-md border bg-background"
        role="group"
        aria-label="Human status"
      >
        <HumanFilterButton
          active={value === "all"}
          onClick={() => onChange("all")}
        >
          All
        </HumanFilterButton>
        <HumanFilterButton
          active={value === "unreviewed"}
          onClick={() => onChange("unreviewed")}
        >
          Unreviewed
        </HumanFilterButton>
        <HumanFilterButton
          active={value === "accepted"}
          onClick={() => onChange("accepted")}
        >
          Accepted
        </HumanFilterButton>
      </div>
    </div>
  );
}

function HumanFilterButton({
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
      variant={active ? "default" : "ghost"}
      className="h-7 rounded-none border-0 px-2.5 text-xs shadow-none"
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function ReviewScrollPanel({
  children,
  sidebarCollapsible,
}: {
  children: React.ReactNode;
  sidebarCollapsible: boolean;
}) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain pb-8">
        <div
          className={cn(
            "w-full max-w-3xl",
            sidebarCollapsible ? "mx-auto" : "mx-auto",
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

function ReviewClaims({
  allThreads,
  filteredThreads,
  isEvidenceSelected,
  onEvidenceSelect,
}: {
  allThreads: Thread[];
  filteredThreads: Thread[];
  isEvidenceSelected: (evidence: Evidence) => boolean;
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
            isEvidenceSelected={isEvidenceSelected}
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

function isEvidenceSelected(
  evidence: Evidence,
  selectedEvidence: EvidenceSelection | null,
  codeItems: CodeViewItem[],
) {
  if (!selectedEvidence) return false;
  const item = findCodeViewItem(codeItems, evidence.filePath);
  if (!item || item.id !== selectedEvidence.id) return false;
  return (
    selectedEvidence.range.start === evidence.startLine &&
    selectedEvidence.range.end === evidence.endLine
  );
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

function filterThreads(threads: Thread[], humanStatus: FilterValue) {
  return threads
    .map((thread) => ({
      ...thread,
      claims: thread.claims.filter((claim) => {
        return humanStatus === "all" || claim.humanStatus === humanStatus;
      }),
    }))
    .filter((thread) => thread.claims.length > 0);
}

function statusLabel(status: string) {
  return status.replaceAll("_", " ");
}

function ThreadGroup({
  thread,
  isEvidenceSelected,
  onEvidenceSelect,
}: {
  thread: Thread;
  isEvidenceSelected: (evidence: Evidence) => boolean;
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
        <div className="text-lg leading-relaxed text-muted-foreground pb-2 max-w-prose">
          <AiText source={thread.summary} />
        </div>
      ) : null}
      <div className="grid gap-3">
        {thread.claims.map((claim, index) => (
          <ClaimCard
            key={claim.id}
            claim={claim}
            index={index}
            isEvidenceSelected={isEvidenceSelected}
            onEvidenceSelect={onEvidenceSelect}
          />
        ))}
      </div>
    </section>
  );
}

function EmptyState({
  children,
  title,
  description,
}: {
  children?: React.ReactNode;
  title?: string;
  description?: string;
}) {
  return (
    <Card>
      <CardContent className="space-y-1 text-muted-foreground">
        {title ? (
          <p className="text-sm font-medium text-foreground">{title}</p>
        ) : null}
        {description ? <p>{description}</p> : children}
      </CardContent>
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
  isEvidenceSelected,
  onEvidenceSelect,
}: {
  claim: Claim;
  index: number;
  isEvidenceSelected: (evidence: Evidence) => boolean;
  onEvidenceSelect: (evidence: Evidence) => void;
}) {
  return (
    <Card
      className={cn(
        claim.humanStatus === "accepted"
          ? "ring-1 ring-inset ring-primary/80"
          : "",
      )}
    >
      <div className="flex">
        <span className="relative left-4 text-xl font-medium leading-snug text-muted-foreground">
          {index + 1}.&nbsp;
        </span>
        <div className="flex flex-col gap-6 w-full">
          <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between px-6">
            <CardTitle className="flex text-xl font-medium leading-snug">
              <AiText source={claim.title} />
            </CardTitle>
            <CardAction className="flex flex-wrap items-center justify-end gap-2 ml-auto">
              {claim.updatedAt ? (
                <ClaimTimeAgo updatedAt={claim.updatedAt} />
              ) : null}
              <Badge
                variant={
                  claim.agentStatus !== "unchanged" ? "default" : "secondary"
                }
              >
                {statusLabel(claim.agentStatus)}
              </Badge>
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
                    selected={isEvidenceSelected(evidence)}
                    onSelect={onEvidenceSelect}
                  />
                ))}
              </div>
            ) : null}
          </CardContent>
        </div>
      </div>

      <CardFooter className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center px-6">
        <ClaimActions claim={claim} className="ml-auto" />
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

const deltaPanelLabelClasses: Record<DeltaPanelColor, string> = {
  red: "text-red-800 dark:text-red-600",
  blue: "text-blue-800 dark:text-blue-600",
  yellow: "text-yellow-800 dark:text-yellow-600",
  green: "text-green-800 dark:text-green-600",
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

function EvidenceBlock({
  evidence,
  selected,
  onSelect,
}: {
  evidence: Evidence;
  selected: boolean;
  onSelect: (evidence: Evidence) => void;
}) {
  return evidence.change ? (
    <Tooltip>
      <TooltipTrigger
        delay={700}
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-pressed={selected}
            className={cn(
              "w-full justify-start text-sm font-normal hover:bg-primary/10 h-auto py-2 text-left",
              selected ? "bg-primary/30" : "bg-muted/30 text-muted-foreground",
            )}
            onClick={() => onSelect(evidence)}
            id={getEvidenceId(evidence)}
          />
        }
      >
        <AiText className="w-full flex justify-start" source={evidence.change} inline />
        <ChevronRight className="size-4 ml-auto text-muted-foreground" />
      </TooltipTrigger>
      <TooltipContent side="top" align="end">
        {evidence.filePath}:{evidence.startLine}-{evidence.endLine}
      </TooltipContent>
    </Tooltip>
  ) : null;
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
  const labelClass = deltaPanelLabelClasses[color];
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="text-sm leading-relaxed text-muted-foreground">
        <span
          aria-hidden="true"
          className="mr-2 inline-flex items-center justify-center text-foreground"
        >
          {direction === "left" ? (
            <ArrowLeftFromLine className="relative top-0.5 size-4" />
          ) : (
            <ArrowRightFromLine className="relative top-0.5 size-4" />
          )}
        </span>
        <strong className={labelClass}>{label}:</strong>{" "}
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

type DiffOverflow = "wrap" | "scroll";
type DiffLayoutStyle = "split" | "unified";

function DiffViewControls({
  diffStyle,
  lineNumbersEnabled,
  overflow,
  onDiffStyleChange,
  onLineNumbersEnabledChange,
  onOverflowChange,
}: {
  diffStyle: DiffLayoutStyle;
  lineNumbersEnabled: boolean;
  overflow: DiffOverflow;
  onDiffStyleChange: (style: DiffLayoutStyle) => void;
  onLineNumbersEnabledChange: (enabled: boolean) => void;
  onOverflowChange: (overflow: DiffOverflow) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2">
      <ButtonGroup>
        <Tooltip>
          <TooltipTrigger
            delay={0}
            render={
              <Toggle
                variant="outline"
                size="sm"
                pressed={overflow === "wrap"}
                onPressedChange={(pressed) =>
                  onOverflowChange(pressed ? "wrap" : "scroll")
                }
                aria-label={
                  overflow === "wrap"
                    ? "Disable line wrap"
                    : "Enable line wrap"
                }
              >
                <WrapText data-icon="inline-start" />
              </Toggle>
            }
          />
          <TooltipContent>Wrap lines</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            delay={0}
            render={
              <Toggle
                variant="outline"
                size="sm"
                pressed={lineNumbersEnabled}
                onPressedChange={onLineNumbersEnabledChange}
                aria-label={
                  lineNumbersEnabled
                    ? "Hide line numbers"
                    : "Show line numbers"
                }
              >
                <ListOrdered data-icon="inline-start" />
              </Toggle>
            }
          />
          <TooltipContent>Line numbers</TooltipContent>
        </Tooltip>
      </ButtonGroup>
      <ToggleGroup
        variant="outline"
        size="sm"
        spacing={0}
        value={[diffStyle]}
        onValueChange={(values) => {
          const value = values[0];
          if (value === "split" || value === "unified") {
            onDiffStyleChange(value);
          }
        }}
      >
        <ToggleGroupItem value="split" aria-label="Split view" title="Split">
          <Columns2 data-icon="inline-start" />
        </ToggleGroupItem>
        <ToggleGroupItem
          value="unified"
          aria-label="Stacked view"
          title="Stacked"
        >
          <Rows2 data-icon="inline-start" />
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
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
  const [diffOverflow, setDiffOverflow] = React.useState<DiffOverflow>("wrap");
  const [lineNumbersEnabled, setLineNumbersEnabled] = React.useState(true);
  const [diffStyle, setDiffStyle] = React.useState<DiffLayoutStyle>("unified");
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
          variant="ghost"
          className="h-10 w-10 hover:bg-secondary/10"
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
          <Badge variant="outline" className="text-muted-foreground">
            {items.length} {items.length === 1 ? "file" : "files"}
          </Badge>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <DiffViewControls
            diffStyle={diffStyle}
            lineNumbersEnabled={lineNumbersEnabled}
            overflow={diffOverflow}
            onDiffStyleChange={setDiffStyle}
            onLineNumbersEnabledChange={setLineNumbersEnabled}
            onOverflowChange={setDiffOverflow}
          />
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
                diffStyle,
                overflow: diffOverflow,
                diffIndicators: "classic",
                disableLineNumbers: !lineNumbersEnabled,
                disableFileHeader: false,
                stickyHeaders: true,
                unsafeCSS: DIFF_SELECTED_LINE_UNSAFE_CSS,
                itemMetrics: {
                  lineHeight: 24,
                },
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

function ClaimActions({
  claim,
  className,
}: {
  claim: Claim;
  className?: string;
}) {
  const queryClient = useQueryClient();
  const statusMutation = useMutation({
    mutationFn: async (humanStatus: HumanStatus) => {
      const response = await fetch(
        `/api/claims/${encodeURIComponent(claim.id)}/human-status`,
        {
          method: "POST",
          headers: reviewApiHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ humanStatus }),
        },
      );
      if (!response.ok) throw new Error("Failed to update claim status.");
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
          headers: reviewApiHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ note }),
        },
      );
      if (!response.ok) throw new Error("Failed to save comment.");
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["review"] }),
  });

  return (
    <div
      className={cn(
        "inline-flex w-full overflow-hidden rounded-lg border bg-background sm:w-auto",
        className,
      )}
    >
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
        onClick={() =>
          statusMutation.mutate(
            claim.humanStatus === "accepted" ? "unreviewed" : "accepted",
          )
        }
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
