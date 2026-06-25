import { parsePatchFiles, resolveTheme } from "@pierre/diffs";
import { Dialog } from "@base-ui/react/dialog";
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
  CheckCheck,
  ChevronRight,
  Columns2,
  OctagonX,
  FileCode,
  FolderTree,
  Highlighter,
  Info,
  ListChevronsDownUp,
  ListChevronsUpDown,
  ListOrdered,
  Monitor,
  Moon,
  PaintBucket,
  PanelRightClose,
  PanelRightOpen,
  Rows2,
  Sun,
  Square,
  TriangleAlert,
  WrapText,
  X,
} from "lucide-react";
import * as React from "react";
import { createRoot } from "react-dom/client";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { Streamdown } from "streamdown";

import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { ButtonGroup } from "./components/ui/button-group";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./components/ui/collapsible";
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
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "./components/ui/resizable";
import { normalizeFilePath, resolveFilePathMatch } from "./file-paths";
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
type ClaimImportance = "critical" | "important" | "minor" | "noise";
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
  importance: ClaimImportance;
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

type WorktreeDiffData = {
  diff: string;
  files: Array<{ path: string; additions: number; deletions: number }>;
  skipped: string[];
  worktreeHash?: string;
};

type WorktreeReviewData = {
  worktreeHash: string;
  state: "none" | "pending_agent" | "applied";
  stale: boolean;
  appliedHash: string | null;
  draftPath: string | null;
  burden: string;
  generatedAt: number;
  threads: Thread[];
};

type ClaimApi = {
  post: (claimId: string, humanStatus: HumanStatus) => Promise<HumanStatus>;
  queryKey: readonly unknown[];
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

async function fetchWorktreeDiff() {
  const response = await fetch("/api/worktree/diff", {
    cache: "no-store",
    headers: reviewApiHeaders(),
  });
  if (!response.ok) {
    throw new ReviewApiError("Failed to load worktree diff.", response.status);
  }
  const payload = (await response.json()) as Partial<WorktreeDiffData>;
  return {
    diff: payload.diff ?? "",
    files: payload.files ?? [],
    skipped: payload.skipped ?? [],
  };
}

async function fetchWorktreeReview() {
  const response = await fetch("/api/worktree/review", {
    cache: "no-store",
    headers: reviewApiHeaders(),
  });
  if (!response.ok) {
    throw new ReviewApiError("Failed to load worktree review.", response.status);
  }
  return (await response.json()) as WorktreeReviewData;
}

async function postClaimHumanStatus(claimId: string, humanStatus: HumanStatus) {
  const response = await fetch(
    `/api/claims/${encodeURIComponent(claimId)}/human-status`,
    {
      method: "POST",
      headers: reviewApiHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ humanStatus }),
    },
  );
  if (!response.ok) throw new Error("Failed to update claim status.");
  return humanStatus;
}

async function postWorktreeClaimHumanStatus(
  claimId: string,
  humanStatus: HumanStatus,
) {
  const response = await fetch(
    `/api/worktree/claims/${encodeURIComponent(claimId)}/human-status`,
    {
      method: "POST",
      headers: reviewApiHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ humanStatus }),
    },
  );
  if (!response.ok) throw new Error("Failed to update claim status.");
  return humanStatus;
}

const committedClaimApi: ClaimApi = {
  post: postClaimHumanStatus,
  queryKey: ["review"],
};
const worktreeClaimApi: ClaimApi = {
  post: postWorktreeClaimHumanStatus,
  queryKey: ["worktree-review"],
};
const ClaimApiContext = React.createContext<ClaimApi>(committedClaimApi);
function useClaimApi() {
  return React.useContext(ClaimApiContext);
}

function getActiveClaimId(target: EventTarget | null) {
  const fromTarget =
    target instanceof Element
      ? target.closest<HTMLElement>("[data-claim-id]")?.dataset.claimId
      : undefined;
  const fromFocus =
    document.activeElement?.closest<HTMLElement>("[data-claim-id]")?.dataset
      .claimId;
  return fromTarget ?? fromFocus;
}

function isTypingTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.matches("input, textarea, select"))
  );
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
  const isDesktopLayout = useMediaQuery("(min-width: 1024px)");
  const [humanStatusFilter, setHumanStatusFilter] =
    React.useState<FilterValue>("all");
  const [openThreads, setOpenThreads] = React.useState<Record<string, boolean>>(
    {},
  );
  const [openClaims, setOpenClaims] = React.useState<Record<string, boolean>>(
    {},
  );
  const [codePanelOpen, setCodePanelOpen] = React.useState(false);
  const [selectedEvidence, setSelectedEvidence] =
    React.useState<EvidenceSelection | null>(null);
  const [selectedClaimId, setSelectedClaimId] = React.useState<string | null>(null);
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
    enabled: data?.git.clean === true,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    retry: shouldRetryReviewQuery,
  });
  const {
    data: worktreeDiff = { diff: "", files: [], skipped: [] },
    isError: isWorktreeDiffError,
  } = useQuery({
    queryKey: ["worktree-diff"],
    queryFn: fetchWorktreeDiff,
    enabled: data?.git.clean === false,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    retry: shouldRetryReviewQuery,
  });
  const {
    data: worktreeReview = {
      worktreeHash: "",
      state: "none" as const,
      stale: false,
      appliedHash: null,
      draftPath: null,
      burden: "0 claims",
      generatedAt: 0,
      threads: [] as Thread[],
    },
  } = useQuery({
    queryKey: ["worktree-review"],
    queryFn: fetchWorktreeReview,
    enabled: data?.git.clean === false,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    retry: shouldRetryReviewQuery,
  });

  const isDirty = data?.git.clean === false;
  const worktreeHasClaims = isDirty && worktreeReview.threads.length > 0;
  const showClaimsLayout = !isDirty || worktreeHasClaims;
  const claimApi = isDirty ? worktreeClaimApi : committedClaimApi;
  const reviewThreads = isDirty ? worktreeReview.threads : (data?.threads ?? []);
  const reviewBurden = isDirty ? worktreeReview.burden : (data?.burden ?? "");

  const activeDiff = isDirty ? worktreeDiff.diff : rawDiff;
  const activeDiffError = isDirty ? isWorktreeDiffError : isDiffError;
  const codeItems = React.useMemo(
    () => parseCodeViewItems(activeDiff),
    [activeDiff],
  );
  const gitStatusEntries = React.useMemo(
    () => buildFileTreeGitStatus(codeItems, data?.git.status ?? ""),
    [codeItems, data?.git.status],
  );

  const allClaims = React.useMemo(
    () => reviewThreads.flatMap((t) => t.claims),
    [reviewThreads],
  );

  const filteredCodeItems = React.useMemo(() => {
    if (!selectedClaimId) return codeItems;
    const claim = allClaims.find((c) => c.id === selectedClaimId);
    if (!claim || claim.evidences.length === 0) return codeItems;
    const paths = new Set(claim.evidences.map((e) => normalizeFilePath(e.filePath)));
    return codeItems.filter(
      (item) =>
        item.type === "diff" &&
        (paths.has(normalizeFilePath(item.fileDiff.name)) ||
          (item.fileDiff.prevName != null &&
            paths.has(normalizeFilePath(item.fileDiff.prevName)))),
    );
  }, [codeItems, selectedClaimId, allClaims]);

  const selectedClaim = React.useMemo(
    () => allClaims.find((c) => c.id === selectedClaimId) ?? null,
    [allClaims, selectedClaimId],
  );

  const selectedThread = React.useMemo(
    () =>
      reviewThreads.find((t) => t.claims.some((c) => c.id === selectedClaimId)) ?? null,
    [reviewThreads, selectedClaimId],
  );

  const evidenceIsSelected = React.useCallback(
    (evidence: Evidence) =>
      isEvidenceSelected(evidence, selectedEvidence, codeItems),
    [codeItems, selectedEvidence],
  );
  const showLoadingState = useDelayedValue(isLoading, LOADING_STATE_DELAY_MS);
  const filteredThreads = React.useMemo(
    () => filterThreads(reviewThreads, humanStatusFilter),
    [reviewThreads, humanStatusFilter],
  );
  const allReviewItemsOpen =
    filteredThreads.length > 0 &&
    filteredThreads.every(
      (thread) =>
        openThreads[thread.id] === true &&
        thread.claims.every((claim) => openClaims[claim.id] === true),
    );
  const setThreadOpen = React.useCallback((threadId: string, open: boolean) => {
    setOpenThreads((current) => ({ ...current, [threadId]: open }));
  }, []);
  const setClaimOpen = React.useCallback((claimId: string, open: boolean) => {
    setOpenClaims((current) => ({ ...current, [claimId]: open }));
    if (open) {
      setSelectedClaimId(claimId);
    } else {
      setSelectedClaimId((current) => (current === claimId ? null : current));
    }
  }, []);
  const setAllReviewItemsOpen = React.useCallback(
    (open: boolean) => {
      setOpenThreads((current) => {
        const next = { ...current };
        for (const thread of filteredThreads) next[thread.id] = open;
        return next;
      });
      setOpenClaims((current) => {
        const next = { ...current };
        for (const thread of filteredThreads) {
          for (const claim of thread.claims) next[claim.id] = open;
        }
        return next;
      });
    },
    [filteredThreads],
  );

  React.useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== "b" ||
        !event.metaKey ||
        event.altKey ||
        event.ctrlKey
      ) {
        return;
      }
      event.preventDefault();
      setCodePanelOpen((open) => !open);
    };

    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, []);

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

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (event.metaKey || event.altKey || event.ctrlKey) return;
      if (!selectedClaimId) return;
      if (isTypingTarget(event.target)) return;

      const claim = allClaims.find((c) => c.id === selectedClaimId);
      if (!claim || claim.evidences.length === 0) return;

      event.preventDefault();
      const evidences = claim.evidences;
      const currentIndex = evidences.findIndex((e) =>
        isEvidenceSelected(e, selectedEvidence, codeItems),
      );
      const delta = event.key === "ArrowRight" ? 1 : -1;
      const fallbackIndex = delta === 1 ? -1 : 0;
      const baseIndex = currentIndex >= 0 ? currentIndex : fallbackIndex;
      const nextIndex = (baseIndex + delta + evidences.length) % evidences.length;
      const nextEvidence = evidences[nextIndex];
      if (nextEvidence) scrollToEvidence(nextEvidence);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedClaimId, allClaims, selectedEvidence, codeItems, scrollToEvidence]);

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

  if (isDirty && !worktreeHasClaims) {
    return (
      <main className={pageClassName}>
        <header className="mb-5 flex flex-wrap items-center justify-between gap-3 p-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <ProjectIdentity projectKey={data.session.projectKey} />
              <Badge variant="outline">{data.git.branch}</Badge>
            </div>
          </div>
          <div className="flex flex-wrap justify-start gap-2 text-sm text-muted-foreground sm:justify-end">
            <Badge variant="outline">Working tree</Badge>
            <ModeToggle />
          </div>
        </header>
        <WorktreePreview
          codeItems={codeItems}
          codeViewRef={codeViewRef}
          diffError={activeDiffError}
          draftPath={worktreeReview.draftPath}
          gitStatus={gitStatusEntries}
          worktreeDiff={worktreeDiff}
        />
      </main>
    );
  }

  const reviewContent = (
    <ReviewClaims
      allThreads={reviewThreads}
      filteredThreads={filteredThreads}
      openClaims={openClaims}
      openThreads={openThreads}
      isEvidenceSelected={evidenceIsSelected}
      onEvidenceSelect={scrollToEvidence}
      onClaimOpenChange={setClaimOpen}
      onThreadOpenChange={setThreadOpen}
    />
  );
  const reviewPanel = (
    <ReviewScrollPanel contained={isDesktopLayout}>
      {reviewContent}
    </ReviewScrollPanel>
  );

  return (
    <ClaimApiContext.Provider value={claimApi}>
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
            {isDirty ? <Badge variant="outline">Working tree</Badge> : null}
          </div>
        </div>
        <HumanFilterNav
          value={humanStatusFilter}
          allReviewItemsOpen={allReviewItemsOpen}
          onChange={setHumanStatusFilter}
          onToggleAll={() => setAllReviewItemsOpen(!allReviewItemsOpen)}
        />
        <div className="flex flex-wrap justify-start gap-2 text-sm text-muted-foreground sm:justify-end">
          <Badge variant="outline">{reviewBurden}</Badge>
          {!isDesktopLayout ? (
            <MobileCodePanelButton
              open={codePanelOpen}
              onOpenChange={setCodePanelOpen}
            />
          ) : null}
          <ModeToggle />
        </div>
      </header>

      {isDirty && worktreeReview.stale ? (
        <Alert className="mb-4 shrink-0 border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100">
          <AlertTriangle />
          <AlertTitle>Not the latest changes</AlertTitle>
          <AlertDescription className="text-amber-900 dark:text-amber-200">
            <div className="flex flex-wrap items-start gap-2">
              <p className="min-w-0 flex-1">
                These worktree claims were applied to an earlier version of your
                working tree. The diff has changed since. Regenerate the draft
                and amend the claims to match the current changes.
              </p>
              <CopyAgentPromptButton
                label="Copy amend prompt"
                text={staleWorktreePrompt(worktreeReview.draftPath)}
              />
            </div>
          </AlertDescription>
        </Alert>
      ) : null}

      {isDesktopLayout ? (
        <ResizableReviewLayout
          codePanel={
            <ReviewCodePanel
              codeViewRef={codeViewRef}
              className="h-full min-h-0"
              diffError={activeDiffError}
              gitStatus={gitStatusEntries}
              items={filteredCodeItems}
              totalItems={codeItems.length}
              onClearFilter={() => { setSelectedClaimId(null); setSelectedEvidence(null); }}
              selectedClaim={selectedClaim}
              selectedThread={selectedThread}
              open={codePanelOpen}
              selectedEvidence={selectedEvidence}
              onOpenChange={setCodePanelOpen}
              onSelectedEvidenceChange={setSelectedEvidence}
            />
          }
          codePanelOpen={codePanelOpen}
          reviewPanel={reviewPanel}
          onCodePanelOpenChange={setCodePanelOpen}
        />
      ) : (
        <>
          {reviewPanel}
          <ReviewCodeSheet
            codeViewRef={codeViewRef}
            diffError={activeDiffError}
            gitStatus={gitStatusEntries}
            items={filteredCodeItems}
            totalItems={codeItems.length}
            onClearFilter={() => { setSelectedClaimId(null); setSelectedEvidence(null); }}
            selectedClaim={selectedClaim}
            selectedThread={selectedThread}
            open={codePanelOpen}
            selectedEvidence={selectedEvidence}
            onOpenChange={setCodePanelOpen}
            onSelectedEvidenceChange={setSelectedEvidence}
          />
        </>
      )}
    </main>
    </ClaimApiContext.Provider>
  );
}

function ResizableReviewLayout({
  codePanel,
  codePanelOpen,
  reviewPanel,
  onCodePanelOpenChange,
}: {
  codePanel: React.ReactNode;
  codePanelOpen: boolean;
  reviewPanel: React.ReactNode;
  onCodePanelOpenChange: (open: boolean) => void;
}) {
  const codePanelRef = React.useRef<PanelImperativeHandle | null>(null);

  React.useEffect(() => {
    if (codePanelOpen) {
      codePanelRef.current?.expand();
    } else {
      codePanelRef.current?.collapse();
    }
  }, [codePanelOpen]);

  return (
    <ResizablePanelGroup
      className="min-h-0 flex-1 gap-3"
      orientation="horizontal"
      resizeTargetMinimumSize={{ coarse: 40, fine: 24 }}
    >
      <ResizablePanel
        id="review-claims"
        className="min-h-0 min-w-0"
        defaultSize="58%"
        minSize="360px"
      >
        {reviewPanel}
      </ResizablePanel>
      <ResizableHandle
        withHandle={codePanelOpen}
        className={cn(!codePanelOpen && "opacity-0")}
      />
      <ResizablePanel
        id="review-code"
        className="min-h-0 min-w-0"
        collapsedSize="44px"
        collapsible
        defaultSize="42%"
        minSize="360px"
        panelRef={codePanelRef}
        onResize={(size) => {
          const nextOpen = size.inPixels > 80;
          if (nextOpen !== codePanelOpen) onCodePanelOpenChange(nextOpen);
        }}
      >
        {codePanel}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

function MobileCodePanelButton({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        delay={0}
        render={
          <Button
            type="button"
            size="icon"
            variant={open ? "default" : "outline"}
            className="size-7"
            aria-label={open ? "Close code panel" : "Open code panel"}
            aria-pressed={open}
            title={open ? "Close code panel" : "Open code panel"}
            onClick={() => onOpenChange(!open)}
          >
            <FileCode data-icon="inline-start" />
          </Button>
        }
      />
      <TooltipContent>
        {open ? "Close code panel" : "Open code panel"}
      </TooltipContent>
    </Tooltip>
  );
}

function ReviewCodeSheet({
  codeViewRef,
  diffError,
  gitStatus,
  items,
  totalItems,
  onClearFilter,
  selectedClaim,
  selectedThread,
  open,
  selectedEvidence,
  onOpenChange,
  onSelectedEvidenceChange,
}: {
  codeViewRef: React.RefObject<CodeViewHandle<undefined> | null>;
  diffError: boolean;
  gitStatus: GitStatusEntry[];
  items: CodeViewItem[];
  totalItems?: number;
  onClearFilter?: () => void;
  selectedClaim?: Claim | null;
  selectedThread?: Thread | null;
  open: boolean;
  selectedEvidence: EvidenceSelection | null;
  onOpenChange: (open: boolean) => void;
  onSelectedEvidenceChange: (selection: EvidenceSelection | null) => void;
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => onOpenChange(nextOpen)}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-background/70 backdrop-blur-xs" />
        <Dialog.Popup
          className="fixed inset-y-0 right-0 z-50 flex w-[min(100vw,48rem)] max-w-full flex-col border-l bg-background shadow-xl"
          initialFocus={false}
        >
          <Dialog.Title className="sr-only">Code panel</Dialog.Title>
          <ReviewCodePanel
            codeViewRef={codeViewRef}
            className="h-full min-h-0 rounded-none border-0"
            diffError={diffError}
            gitStatus={gitStatus}
            items={items}
            totalItems={totalItems}
            onClearFilter={onClearFilter}
            selectedClaim={selectedClaim}
            selectedThread={selectedThread}
            open={open}
            selectedEvidence={selectedEvidence}
            onOpenChange={onOpenChange}
            onSelectedEvidenceChange={onSelectedEvidenceChange}
          />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ProjectIdentity({ projectKey }: { projectKey: string }) {
  const project = parseProjectKey(projectKey);

  return (
    <div className="flex min-w-0 items-center gap-2">
      <ProjectAvatar project={project} />
      <span
        className="min-w-0 truncate text-base font-semibold leading-tight"
        title={project.hash}
      >
        {project.repo}
      </span>
      {/* {project.hash ? (
        <span className="shrink-0 font-mono text-[11px] leading-none text-muted-foreground">
          {project.hash}
        </span>
      ) : null} */}
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
  allReviewItemsOpen,
  value,
  onChange,
  onToggleAll,
}: {
  allReviewItemsOpen: boolean;
  value: FilterValue;
  onChange: (value: FilterValue) => void;
  onToggleAll: () => void;
}) {
  const toggleLabel = allReviewItemsOpen ? "Collapse all" : "Expand all";
  const ToggleIcon = allReviewItemsOpen
    ? ListChevronsDownUp
    : ListChevronsUpDown;

  return (
    <div className="flex justify-start gap-2 sm:justify-center">
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
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon"
              variant="outline"
              className="size-7"
              aria-label={toggleLabel}
              aria-pressed={allReviewItemsOpen}
              onClick={onToggleAll}
            >
              <ToggleIcon aria-hidden />
            </Button>
          }
        />
        <TooltipContent>{toggleLabel}</TooltipContent>
      </Tooltip>
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
      className="h-8 rounded-none border-0 px-3 text-xs shadow-none"
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function ReviewScrollPanel({
  children,
  contained = false,
}: {
  children: React.ReactNode;
  contained?: boolean;
}) {
  const content = <div className="mx-auto w-full max-w-3xl">{children}</div>;

  if (!contained) return content;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain pb-8">
        {content}
      </div>
    </div>
  );
}

function ReviewClaims({
  allThreads,
  filteredThreads,
  openClaims,
  openThreads,
  isEvidenceSelected,
  onEvidenceSelect,
  onClaimOpenChange,
  onThreadOpenChange,
}: {
  allThreads: Thread[];
  filteredThreads: Thread[];
  openClaims: Record<string, boolean>;
  openThreads: Record<string, boolean>;
  isEvidenceSelected: (evidence: Evidence) => boolean;
  onEvidenceSelect: (evidence: Evidence) => void;
  onClaimOpenChange: (claimId: string, open: boolean) => void;
  onThreadOpenChange: (threadId: string, open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const claimApi = useClaimApi();
  const claimButtonRefs = React.useRef(new Map<string, HTMLButtonElement>());
  const filteredClaims = React.useMemo(
    () =>
      filteredThreads.flatMap((thread) =>
        thread.claims.map((claim) => ({ claim, threadId: thread.id })),
      ),
    [filteredThreads],
  );
  const setClaimButtonRef = React.useCallback(
    (claimId: string, button: HTMLButtonElement | null) => {
      if (button) {
        claimButtonRefs.current.set(claimId, button);
      } else {
        claimButtonRefs.current.delete(claimId);
      }
    },
    [],
  );

  const focusClaimAt = React.useCallback(
    (index: number) => {
      const target = filteredClaims[index];
      if (!target) return;

      onThreadOpenChange(target.threadId, true);
      if (target.claim.humanStatus !== "accepted") {
        onClaimOpenChange(target.claim.id, true);
      }

      window.requestAnimationFrame(() => {
        const button = claimButtonRefs.current.get(target.claim.id);
        button?.focus();
        window.requestAnimationFrame(() => {
          button
            ?.closest("[data-claim-id]")
            ?.scrollIntoView({ behavior: "smooth", block: "center" });
        });
      });
    },
    [filteredClaims, onClaimOpenChange, onThreadOpenChange],
  );

  const focusNextUnapprovedAfter = React.useCallback(
    (approvedClaimId: string) => {
      const currentIndex = filteredClaims.findIndex(
        ({ claim }) => claim.id === approvedClaimId,
      );
      if (currentIndex < 0) return;

      const isNextCandidate = (index: number) => {
        const entry = filteredClaims[index];
        if (!entry || entry.claim.id === approvedClaimId) return false;
        return entry.claim.humanStatus !== "accepted";
      };

      for (
        let index = currentIndex + 1;
        index < filteredClaims.length;
        index++
      ) {
        if (isNextCandidate(index)) {
          focusClaimAt(index);
          return;
        }
      }
      for (let index = 0; index < currentIndex; index++) {
        if (isNextCandidate(index)) {
          focusClaimAt(index);
          return;
        }
      }
    },
    [filteredClaims, focusClaimAt],
  );

  const toggleApprovalMutation = useMutation({
    mutationFn: ({
      claimId,
      humanStatus,
    }: {
      claimId: string;
      humanStatus: HumanStatus;
    }) => claimApi.post(claimId, humanStatus),
    onSuccess: (humanStatus, { claimId }) => {
      if (humanStatus === "accepted") {
        onClaimOpenChange(claimId, false);
        focusNextUnapprovedAfter(claimId);
      }
      return queryClient.invalidateQueries({ queryKey: claimApi.queryKey });
    },
  });

  const toggleFocusedClaimApproval = React.useCallback(
    (
      event: Pick<KeyboardEvent, "key" | "target"> & {
        preventDefault: () => void;
      },
    ) => {
      if (event.key.toLowerCase() !== "a") return;
      if (isTypingTarget(event.target)) return;

      const activeClaimId = getActiveClaimId(event.target);
      if (!activeClaimId) return;

      const target = filteredClaims.find(
        ({ claim }) => claim.id === activeClaimId,
      );
      if (!target) return;

      event.preventDefault();
      toggleApprovalMutation.mutate({
        claimId: activeClaimId,
        humanStatus:
          target.claim.humanStatus === "accepted" ? "unreviewed" : "accepted",
      });
    },
    [filteredClaims, toggleApprovalMutation],
  );

  const navigateWithShortcut = React.useCallback(
    (
      event: Pick<KeyboardEvent, "key" | "target"> & {
        preventDefault: () => void;
      },
    ) => {
      if (event.key.toLowerCase() !== "j" && event.key.toLowerCase() !== "k") {
        return;
      }
      if (filteredClaims.length === 0) return;
      if (isTypingTarget(event.target)) return;

      event.preventDefault();
      const activeClaimId = getActiveClaimId(event.target);
      const activeIndex = filteredClaims.findIndex(
        ({ claim }) => claim.id === activeClaimId,
      );
      const fallbackIndex = event.key.toLowerCase() === "j" ? -1 : 0;
      const nextIndex =
        event.key.toLowerCase() === "j"
          ? Math.min(
              filteredClaims.length - 1,
              (activeIndex >= 0 ? activeIndex : fallbackIndex) + 1,
            )
          : Math.max(0, (activeIndex >= 0 ? activeIndex : fallbackIndex) - 1);

      focusClaimAt(nextIndex);
    },
    [filteredClaims, focusClaimAt],
  );

  React.useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) {
        return;
      }
      navigateWithShortcut(event);
      toggleFocusedClaimApproval(event);
    };

    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [navigateWithShortcut, toggleFocusedClaimApproval]);

  return (
    <section className="grid gap-3.5">
      {allThreads.length === 0 ? (
        <EmptyState>No review claims have been applied yet.</EmptyState>
      ) : filteredThreads.length === 0 ? (
        <EmptyState>No claims match the current filters.</EmptyState>
      ) : (
        <>
          <p className="px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Groups of changes
          </p>
          {filteredThreads.map((thread) => (
            <ThreadGroup
              key={thread.id}
              thread={thread}
              open={openThreads[thread.id] !== false}
              openClaims={openClaims}
              isEvidenceSelected={isEvidenceSelected}
              onEvidenceSelect={onEvidenceSelect}
              onClaimApproved={focusNextUnapprovedAfter}
              onClaimOpenChange={onClaimOpenChange}
              onClaimTriggerRef={setClaimButtonRef}
              onThreadOpenChange={onThreadOpenChange}
            />
          ))}
        </>
      )}
    </section>
  );
}

function parseCodeViewItems(rawDiff: string): CodeViewItem[] {
  if (!rawDiff.trim()) return [];
  return parsePatchFiles(rawDiff, "paire-review", false)
    .flatMap((patch) => patch.files)
    .map((fileDiff, index) => ({
      id: codeViewItemId(index),
      type: "diff",
      fileDiff,
    }));
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

function findCodeViewItem(items: CodeViewItem[], filePath: string) {
  return resolveFilePathMatch(
    items.filter((item) => item.type === "diff"),
    filePath,
    (item) => [item.fileDiff.name, item.fileDiff.prevName],
  );
}

function codeViewItemId(index: number) {
  return `diff-${index}`;
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

function WorktreePreview({
  codeItems,
  codeViewRef,
  diffError,
  draftPath,
  gitStatus,
  worktreeDiff,
}: {
  codeItems: CodeViewItem[];
  codeViewRef: React.RefObject<CodeViewHandle<undefined> | null>;
  diffError: boolean;
  draftPath: string | null;
  gitStatus: GitStatusEntry[];
  worktreeDiff: WorktreeDiffData;
}) {
  const [selectedEvidence, setSelectedEvidence] =
    React.useState<EvidenceSelection | null>(null);
  const additions = worktreeDiff.files.reduce(
    (sum, file) => sum + file.additions,
    0,
  );
  const deletions = worktreeDiff.files.reduce(
    (sum, file) => sum + file.deletions,
    0,
  );

  return (
    <ReviewScrollPanel>
      <section className="space-y-4">
        <Alert className="border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100">
          <AlertTriangle />
          <AlertTitle className="flex flex-wrap items-center gap-2">
            <span>Uncommitted changes</span>
            <Badge variant="outline" className="border-amber-300/80">
              {worktreeDiff.files.length} files
            </Badge>
            <span className="font-mono text-sm">
              +{additions} -{deletions}
            </span>
          </AlertTitle>
          <AlertDescription className="text-amber-900 dark:text-amber-200">
            <div className="flex flex-wrap items-start gap-2">
              <p className="min-w-0 flex-1">
                Previewing your working tree. Paire reviews these uncommitted
                changes separately from committed claims. No worktree claims
                have been applied for this diff yet.
              </p>
              <CopyAgentPromptButton
                label="Copy review prompt"
                text={DIRTY_WORKTREE_AGENT_PROMPT}
              />
            </div>
          </AlertDescription>
        </Alert>

        {draftPath ? (
          <Alert>
            <Bot />
            <AlertTitle>Worktree review in progress</AlertTitle>
            <AlertDescription>
              <div className="flex flex-wrap items-start gap-2">
                <p className="min-w-0 flex-1">
                  Paire generated a worktree review draft. Your coding agent may
                  still be filling it in and applying it. If it has stopped, copy
                  the apply command below and finish the review.
                </p>
                <CopyAgentPromptButton
                  tone="neutral"
                  label="Copy apply command"
                  text={worktreeApplyPrompt(draftPath)}
                />
              </div>
            </AlertDescription>
          </Alert>
        ) : null}

        <Alert>
          <Info />
          <AlertTitle>These are uncommitted changes</AlertTitle>
          <AlertDescription>
            This preview shows your working tree. Paire reviews these changes
            separately from committed claims; commit them when you are ready.
          </AlertDescription>
        </Alert>

        {!worktreeDiff.diff.trim() && !diffError ? (
          <EmptyState
            title="No textual changes"
            description="The worktree is dirty, but Paire did not find textual changes to preview. Mode-only, submodule, binary, or oversized file changes may still be present."
          />
        ) : null}

        {worktreeDiff.skipped.length > 0 ? (
          <Alert>
            <TriangleAlert />
            <AlertTitle>Some files were not previewed</AlertTitle>
            <AlertDescription>
              <ul className="mt-2 list-disc space-y-1 pl-5 font-mono text-xs">
                {worktreeDiff.skipped.map((path) => (
                  <li key={path}>{path}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}

        <ReviewCodePanel
          codeViewRef={codeViewRef}
          canCollapse={false}
          className="h-[min(72vh,56rem)] min-h-[28rem]"
          diffError={diffError}
          gitStatus={gitStatus}
          items={codeItems}
          open
          selectedEvidence={selectedEvidence}
          onOpenChange={() => undefined}
          onSelectedEvidenceChange={setSelectedEvidence}
        />
      </section>
    </ReviewScrollPanel>
  );
}

const DIRTY_WORKTREE_AGENT_PROMPT =
  "paire it; and follow all the instructions to review and apply the worktree review draft.";

function worktreeApplyPrompt(draftPath: string) {
  return [
    `Fill the worktree review draft at ${draftPath} in place (group claims into threads, cover every changed file with evidence), then run:`,
    `paire worktree --apply ${draftPath}`,
    "Fix any PAIRE_APPLY_REJECTED issues it lists and re-run until it exits 0.",
  ].join("\n");
}

function staleWorktreePrompt(draftPath: string | null) {
  return [
    "The working tree changed since the worktree review was applied. Regenerate the draft and amend the claims:",
    "Run: paire it",
    `Then edit the prefilled draft${draftPath ? ` at ${draftPath}` : ""} in place — it carries the prior claims as "unchanged"; update the ones the new diff changed, keep accurate ones as "unchanged", and cover every changed file.`,
    `Finally run: paire worktree --apply ${draftPath ?? "<draft path>"}`,
    "Fix any PAIRE_APPLY_REJECTED issues and re-run until it exits 0.",
  ].join("\n");
}

function CopyAgentPromptButton({
  label = "Copy agent prompt",
  text,
  tone = "amber",
}: {
  label?: string;
  text: string;
  tone?: "amber" | "neutral";
}) {
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
      className={cn(
        "shrink-0 h-6 px-2",
        tone === "amber" &&
          "border-amber-300/80 bg-amber-100/60 text-amber-950 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-100 dark:hover:bg-amber-900/60",
      )}
      title={label}
      aria-label={`${label} for coding agent`}
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
          <span className="text-xs">{label}</span>
        </>
      )}
    </Button>
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

function claimImportanceColor(importance: ClaimImportance) {
  switch (importance) {
    case "critical":
      return "shadow-[inset_2px_0_0_var(--color-violet-500)]";
    case "important":
      return "shadow-[inset_2px_0_0_var(--color-amber-500)]";
    case "noise":
      return "shadow-[inset_2px_0_0_var(--color-muted)]";
    case "minor":
      return "shadow-[inset_2px_0_0_currentColor]";
  }
}

function ThreadGroup({
  thread,
  open,
  openClaims,
  isEvidenceSelected,
  onEvidenceSelect,
  onClaimApproved,
  onClaimOpenChange,
  onClaimTriggerRef,
  onThreadOpenChange,
}: {
  thread: Thread;
  open: boolean;
  openClaims: Record<string, boolean>;
  isEvidenceSelected: (evidence: Evidence) => boolean;
  onEvidenceSelect: (evidence: Evidence) => void;
  onClaimApproved: (claimId: string) => void;
  onClaimOpenChange: (claimId: string, open: boolean) => void;
  onClaimTriggerRef: (
    claimId: string,
    button: HTMLButtonElement | null,
  ) => void;
  onThreadOpenChange: (threadId: string, open: boolean) => void;
}) {
  const allClaimsAccepted =
    thread.claims.length > 0 &&
    thread.claims.every((claim) => claim.humanStatus === "accepted");

  return (
    <Collapsible
      open={open}
      onOpenChange={(nextOpen) => onThreadOpenChange(thread.id, nextOpen)}
      className="flex flex-col gap-1"
    >
      <section className="contents">
        <div className={cn("flex flex-col gap-1 py-2 sticky top-0 z-10 bg-linear-to-b from-muted to-transparent backdrop-blur-xs supports-backdrop-filter:bg-muted/80 border-l-2 pl-1.5 transition-colors", open ? "border-primary/50" : "border-transparent")}>
          <div className="min-w-0">
            <div className="flex items-start justify-between gap-3">
              <h2 className="min-w-0 text-base font-semibold leading-snug w-full">
                <CollapsibleTrigger className="group -ml-2 flex min-w-0 items-center gap-1 rounded-md px-1 text-left focus-visible:ring-[3px] focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-muted w-full">
                  <ChevronRight
                    className={cn(
                      "size-4 shrink-0 text-muted-foreground transition-transform",
                      open && "rotate-90",
                    )}
                    aria-hidden
                  />
                  <span className="flex min-w-0 items-center gap-2">
                    <AiText source={thread.title || "Behavior"} inline />
                    {allClaimsAccepted ? (
                      <CheckCheck
                        className="size-6 shrink-0 text-primary-darker"
                        aria-label="All claims approved"
                      />
                    ) : null}
                  </span>
                </CollapsibleTrigger>
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
        <CollapsibleContent className="flex flex-col gap-1 border-l border-border/50 sm:pl-7 pl-4">
          {thread.summary ? (
            <div className="text-lg leading-relaxed pb-2 max-w-prose">
              <AiText source={thread.summary} />
            </div>
          ) : null}
          <div className="grid gap-1.5">
            {thread.claims.map((claim) => (
              <ClaimCard
                key={claim.id}
                claim={claim}
                open={openClaims[claim.id] === true}
                isEvidenceSelected={isEvidenceSelected}
                onEvidenceSelect={onEvidenceSelect}
                onOpenChange={(nextOpen) =>
                  onClaimOpenChange(claim.id, nextOpen)
                }
                onStatusChange={(humanStatus) => {
                  if (humanStatus === "accepted") {
                    onClaimOpenChange(claim.id, false);
                    onClaimApproved(claim.id);
                  }
                }}
                onTriggerRef={(button) => onClaimTriggerRef(claim.id, button)}
              />
            ))}
          </div>
        </CollapsibleContent>
      </section>
    </Collapsible>
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
  open,
  isEvidenceSelected,
  onEvidenceSelect,
  onOpenChange,
  onStatusChange,
  onTriggerRef,
}: {
  claim: Claim;
  open: boolean;
  isEvidenceSelected: (evidence: Evidence) => boolean;
  onEvidenceSelect: (evidence: Evidence) => void;
  onOpenChange: (open: boolean) => void;
  onStatusChange: (humanStatus: HumanStatus) => void;
  onTriggerRef: (button: HTMLButtonElement | null) => void;
}) {
  const showsImportanceIcon =
    claim.humanStatus !== "accepted" &&
    (claim.importance === "critical" || claim.importance === "important");

  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      data-claim-id={claim.id}
    >
      <Card
        className={cn(
          "relative gap-0 overflow-hidden py-0 shadow-none border-border/60 transition-[background-color,box-shadow] focus-within:outline-2 focus-within:-outline-offset-1",
          // claimImportanceColor(claim.importance),
          claim.humanStatus === "accepted" &&
            "bg-background/50 text-muted-foreground",
        )}
        title={claim.importance}
      >
        <CardHeader className="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-start sm:justify-between px-3 sm:px-4">
          <CardTitle className="flex min-w-0 flex-1 text-sm font-medium leading-snug w-full">
            <CollapsibleTrigger
              ref={onTriggerRef}
              className="group -ml-3 flex min-w-0 items-start gap-1 rounded-md px-1 text-left w-full"
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                onOpenChange(!open);
              }}
            >
              <span className="relative flex size-5 shrink-0 items-center justify-center">
                <ChevronRight
                  className={cn(
                    "size-5 text-muted-foreground transition-[transform,opacity]",
                    open && "rotate-90",
                    showsImportanceIcon &&
                      "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100",
                  )}
                  aria-hidden
                />
                {showsImportanceIcon && claim.importance === "critical" ? (
                  <OctagonX
                    className="absolute size-5 text-violet-500 transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0"
                    aria-hidden
                  />
                ) : null}
                {showsImportanceIcon && claim.importance === "important" ? (
                  <TriangleAlert
                    className="absolute size-5 text-orange-500 transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0"
                    aria-hidden
                  />
                ) : null}
              </span>
              <span className={cn("min-w-0")}>
                <AiText source={claim.title} />
              </span>
            </CollapsibleTrigger>
          </CardTitle>
          <CardAction className="flex flex-wrap items-center justify-end gap-1.5 ml-auto shrink opacity-70">
            {claim.updatedAt ? (
              <ClaimTimeAgo updatedAt={claim.updatedAt} />
            ) : null}
            {claim.agentStatus === "unchanged" ? null : claim.agentStatus === "new" ? (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <span className="size-1.5 rounded-full bg-amber-400 shrink-0" aria-hidden />
                new
              </span>
            ) : (
              <Badge variant="secondary" className="text-xs">
                {statusLabel(claim.agentStatus)}
              </Badge>
            )}
            {!open && claim.humanStatus === "accepted" && (
              <span
                className={cn(
                  "inline-flex h-7 items-center gap-1 rounded-md text-sm font-medium shrink-0",
                )}
                aria-label="Approved"
              >
                <Check
                  className="size-6 shrink-0 text-primary-darker"
                  aria-hidden
                />
              </span>
            )}
          </CardAction>
        </CardHeader>

        <CollapsibleContent>
          <CardContent className="flex flex-col gap-8 px-4 pb-4 sm:px-6">
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
          <CardFooter className="flex flex-col items-start justify-between gap-3 pb-4 sm:flex-row sm:items-center sm:pb-6 px-4 sm:px-6">
            <ClaimActions
              claim={claim}
              className="ml-auto"
              onStatusChange={onStatusChange}
            />
          </CardFooter>
        </CollapsibleContent>
      </Card>
    </Collapsible>
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
              selected ? "bg-primary/20 ring-1 ring-primary/40" : "bg-muted/30 text-muted-foreground",
            )}
            onClick={() => onSelect(evidence)}
            id={getEvidenceId(evidence)}
          />
        }
      >
        <AiText
          className="w-full flex justify-start"
          source={evidence.change}
          inline
        />
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
    <div className="size-full">
      <div className="text-sm leading-relaxed">
        <span
          aria-hidden="true"
          className="mr-2 inline-flex items-center justify-center"
        >
          {direction === "left" ? (
            <ArrowLeftFromLine
              className={cn(labelClass, "relative top-0.5 size-3")}
            />
          ) : (
            <ArrowRightFromLine
              className={cn(labelClass, "relative top-0.5 size-3")}
            />
          )}
        </span>
        <strong className={cn("text-xs", labelClass)}>{label}:</strong>{" "}
      </div>
      <div className="rounded-lg border border-border p-4 h-full">
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
type LineDiffType = "word-alt" | "none";

function DiffViewControls({
  backgroundEnabled,
  diffStyle,
  lineDiffType,
  lineNumbersEnabled,
  overflow,
  onBackgroundEnabledChange,
  onDiffStyleChange,
  onLineDiffTypeChange,
  onLineNumbersEnabledChange,
  onOverflowChange,
}: {
  backgroundEnabled: boolean;
  diffStyle: DiffLayoutStyle;
  lineDiffType: LineDiffType;
  lineNumbersEnabled: boolean;
  overflow: DiffOverflow;
  onBackgroundEnabledChange: (enabled: boolean) => void;
  onDiffStyleChange: (style: DiffLayoutStyle) => void;
  onLineDiffTypeChange: (lineDiffType: LineDiffType) => void;
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
                  overflow === "wrap" ? "Disable line wrap" : "Enable line wrap"
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
                  lineNumbersEnabled ? "Hide line numbers" : "Show line numbers"
                }
              >
                <ListOrdered data-icon="inline-start" />
              </Toggle>
            }
          />
          <TooltipContent>Line numbers</TooltipContent>
        </Tooltip>
      </ButtonGroup>
      <ButtonGroup>
        <Tooltip>
          <TooltipTrigger
            delay={0}
            render={
              <Toggle
                variant="outline"
                size="sm"
                pressed={backgroundEnabled}
                onPressedChange={onBackgroundEnabledChange}
                aria-label={
                  backgroundEnabled
                    ? "Hide diff backgrounds"
                    : "Show diff backgrounds"
                }
              >
                <PaintBucket data-icon="inline-start" />
              </Toggle>
            }
          />
          <TooltipContent>Diff backgrounds</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            delay={0}
            render={
              <Toggle
                variant="outline"
                size="sm"
                pressed={lineDiffType === "word-alt"}
                onPressedChange={(pressed) =>
                  onLineDiffTypeChange(pressed ? "word-alt" : "none")
                }
                aria-label={
                  lineDiffType === "word-alt"
                    ? "Hide word-level highlights"
                    : "Show word-level highlights"
                }
              >
                <Highlighter data-icon="inline-start" />
              </Toggle>
            }
          />
          <TooltipContent>Word highlights</TooltipContent>
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
  canCollapse = true,
  codeViewRef,
  className,
  diffError,
  gitStatus,
  items,
  totalItems = items.length,
  onClearFilter,
  selectedClaim = null,
  selectedThread = null,
  open,
  selectedEvidence,
  onOpenChange,
  onSelectedEvidenceChange,
}: {
  canCollapse?: boolean;
  codeViewRef: React.RefObject<CodeViewHandle<undefined> | null>;
  className?: string;
  diffError: boolean;
  gitStatus: GitStatusEntry[];
  items: CodeViewItem[];
  totalItems?: number;
  onClearFilter?: () => void;
  selectedClaim?: Claim | null;
  selectedThread?: Thread | null;
  open: boolean;
  selectedEvidence: EvidenceSelection | null;
  onOpenChange: (open: boolean) => void;
  onSelectedEvidenceChange: (selection: EvidenceSelection | null) => void;
}) {
  const [fileTreeOpen, setFileTreeOpen] = React.useState(false);
  const [diffOverflow, setDiffOverflow] = React.useState<DiffOverflow>("wrap");
  const [lineNumbersEnabled, setLineNumbersEnabled] = React.useState(true);
  const [backgroundEnabled, setBackgroundEnabled] = React.useState(true);
  const [diffStyle, setDiffStyle] = React.useState<DiffLayoutStyle>("unified");
  const [lineDiffType, setLineDiffType] =
    React.useState<LineDiffType>("word-alt");
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
          {canCollapse ? (
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
          ) : null}
          <Badge variant="outline" className="text-muted-foreground">
            {items.length < totalItems
              ? `${items.length} of ${totalItems} files`
              : `${items.length} ${items.length === 1 ? "file" : "files"}`}
          </Badge>
          {items.length < totalItems && onClearFilter ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7"
              aria-label="Show all files"
              title="Show all files"
              onClick={onClearFilter}
            >
              <X />
            </Button>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <DiffViewControls
            backgroundEnabled={backgroundEnabled}
            diffStyle={diffStyle}
            lineDiffType={lineDiffType}
            lineNumbersEnabled={lineNumbersEnabled}
            overflow={diffOverflow}
            onBackgroundEnabledChange={setBackgroundEnabled}
            onDiffStyleChange={setDiffStyle}
            onLineDiffTypeChange={setLineDiffType}
            onLineNumbersEnabledChange={setLineNumbersEnabled}
            onOverflowChange={setDiffOverflow}
          />
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-8"
            aria-label={
              fileTreeOpen ? "Collapse file tree" : "Expand file tree"
            }
            title={fileTreeOpen ? "Collapse file tree" : "Expand file tree"}
            onClick={() => setFileTreeOpen((value) => !value)}
          >
            <FolderTree data-icon="inline-start" />
          </Button>
        </div>
      </div>

      <ClaimBreadcrumb
        thread={selectedThread}
        claim={selectedClaim}
        selectedEvidence={selectedEvidence}
        items={items}
      />

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
                lineDiffType,
                overflow: diffOverflow,
                diffIndicators: "classic",
                hunkSeparators: "simple",
                disableBackground: !backgroundEnabled,
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
      <Tooltip>
        <TooltipTrigger render={<span className="truncate font-medium" />}>
          {thread.title}
        </TooltipTrigger>
        <TooltipContent>{thread.title}</TooltipContent>
      </Tooltip>
      <ChevronRight className="size-3 shrink-0" aria-hidden />
      <Tooltip>
        <TooltipTrigger render={<span className="truncate font-medium text-foreground" />}>
          {claim.title}
        </TooltipTrigger>
        <TooltipContent>{claim.title}</TooltipContent>
      </Tooltip>
      {activePath && (
        <>
          <ChevronRight className="size-3 shrink-0" aria-hidden />
          <Tooltip>
            <TooltipTrigger render={<span className="truncate font-mono" />}>
              {activePath}
            </TooltipTrigger>
            <TooltipContent>{activePath}</TooltipContent>
          </Tooltip>
        </>
      )}
      {selectedEvidence && activePath && (
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
  onStatusChange,
}: {
  claim: Claim;
  className?: string;
  onStatusChange?: (humanStatus: HumanStatus) => void;
}) {
  const queryClient = useQueryClient();
  const claimApi = useClaimApi();
  const statusMutation = useMutation({
    mutationFn: (humanStatus: HumanStatus) =>
      claimApi.post(claim.id, humanStatus),
    onSuccess: (humanStatus) => {
      onStatusChange?.(humanStatus);
      return queryClient.invalidateQueries({ queryKey: claimApi.queryKey });
    },
  });

  return (
    <div className={cn("inline-flex w-full sm:w-auto", className)}>
      <Button
        type="button"
        variant={claim.humanStatus === "accepted" ? "default" : "outline"}
        // className="min-w-20 flex-1 rounded-none sm:flex-none"
        onClick={() =>
          statusMutation.mutate(
            claim.humanStatus === "accepted" ? "unreviewed" : "accepted",
          )
        }
      >
        {claim.humanStatus === "accepted" ? (
          <>
            Accepted
            <Check data-icon="inline-start" />
          </>
        ) : (
          <>
            Accept
            <Square data-icon="inline-end" />
          </>
        )}
      </Button>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
