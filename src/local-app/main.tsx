import { formatDistanceToNow } from "date-fns";
import { PatchDiff } from "@pierre/diffs/react";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  ArrowLeftFromLine,
  ArrowRightFromLine,
  AlertTriangle,
  CheRightChevronRight,
  ChevronDown,
  ChevronUp,
  MessageSquare,
  Monitor,
  Moon,
  Sun,
  ThumbsUp,
  ChevronRight,
} from "lucide-react";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { Streamdown } from "streamdown";

import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert";
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

type HumanStatus = "unreviewed" | "accepted" | "concern" | "irrelevant";
type FilterValue = "all" | string;

type Evidence = {
  claimId: string;
  filePath: string;
  startLine: number;
  endLine: number;
  symbol?: string;
  diff?: string;
  before?: string;
  after?: string;
};

type Claim = {
  id: string;
  title: string;
  description?: string;
  agentStatus: string;
  humanStatus: HumanStatus;
  updatedAt?: number;
  evidences: Evidence[];
};

type Thread = {
  id: string;
  title: string;
  summary: string;
  status: string;
  claims: Claim[];
};

type ReviewData = {
  session: { goal: string | null; projectKey: string };
  git: { branch: string; head: string; clean: boolean; status: string };
  burden: string;
  generatedAt: number;
  threads: Thread[];
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

const pageClassName = "mx-auto w-full max-w-5xl px-3 py-5 sm:px-5 sm:py-6";
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

function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <ReviewScreen />
      </QueryClientProvider>
    </ThemeProvider>
  );
}

function ReviewScreen() {
  const [agentStatusFilter, setAgentStatusFilter] =
    React.useState<FilterValue>("all");
  const [humanStatusFilter, setHumanStatusFilter] =
    React.useState<FilterValue>("all");
  const { data, isLoading, isError } = useQuery({
    queryKey: ["review"],
    queryFn: fetchReview,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
  });

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

  return (
    <main className={pageClassName}>
      {!data.git.clean ? <DirtyWorktreeAlert /> : null}

      <header className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="mb-1 text-xs font-bold uppercase text-muted-foreground">
            Paire Review
          </p>
          <h1 className="text-2xl font-semibold leading-tight tracking-normal">
            {data.session.goal ?? data.session.projectKey}
          </h1>
        </div>
        <div className="flex flex-wrap gap-2 text-sm text-muted-foreground">
          <Badge variant="outline">{data.git.branch}</Badge>
          <Badge variant="outline">{data.burden}</Badge>
          <ModeToggle />
        </div>
      </header>

      <FilterBar
        agentStatus={agentStatusFilter}
        humanStatus={humanStatusFilter}
        agentStatusOptions={agentStatusOptions}
        totalClaimCount={totalClaimCount}
        filteredClaimCount={filteredClaimCount}
        onAgentStatusChange={setAgentStatusFilter}
        onHumanStatusChange={setHumanStatusFilter}
      />

      <section className="grid gap-3.5">
        {data.threads.length === 0 ? (
          <EmptyState>No review claims have been applied yet.</EmptyState>
        ) : filteredThreads.length === 0 ? (
          <EmptyState>No claims match the current filters.</EmptyState>
        ) : (
          filteredThreads.map((thread) => (
            <ThreadGroup key={thread.id} thread={thread} />
          ))
        )}
      </section>
    </main>
  );
}

function DirtyWorktreeAlert() {
  return (
    <Alert className="mb-4 border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100">
      <AlertTriangle />
      <AlertTitle>These are <strong>not</strong> the latest changes.</AlertTitle>
      <AlertDescription className="text-amber-900 dark:text-amber-200">
        <p>Commit your worktree changes, then run <code>paire review</code> again
        to review the latest committed code.</p>
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
  onAgentStatusChange,
  onHumanStatusChange,
}: {
  agentStatus: FilterValue;
  humanStatus: FilterValue;
  agentStatusOptions: string[];
  totalClaimCount: number;
  filteredClaimCount: number;
  onAgentStatusChange: (status: FilterValue) => void;
  onHumanStatusChange: (status: FilterValue) => void;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="flex items-center gap-2">
        <p className="text-xs font-medium uppercase text-muted-foreground">
          Filters
        </p>
        <Badge variant="outline" className="text-muted-foreground">
          {filteredClaimCount} of {totalClaimCount} claims
        </Badge>
      </div>
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

function ThreadGroup({ thread }: { thread: Thread }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 pt-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-xl font-semibold leading-snug">
              <AiText source={thread.title || "Behavior"} inline />
            </h2>
            {thread.summary ? (
              <div className="mt-1 text-md leading-relaxed text-muted-foreground">
                <AiText source={thread.summary} />
              </div>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant="secondary">
              {thread.claims.length}{" "}
              {thread.claims.length === 1 ? "claim" : "claims"}
            </Badge>
            {thread.status ? (
              <Badge variant="outline" className="text-muted-foreground">
                {statusLabel(thread.status)}
              </Badge>
            ) : null}
          </div>
        </div>
      </div>
      <div className="grid gap-3">
        {thread.claims.map((claim, index) => (
          <ClaimCard key={claim.id} claim={claim} index={index} />
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
      className="whitespace-nowrap text-sm leading-none text-muted-foreground"
      dateTime={new Date(updatedAt).toISOString()}
    >
      {formatDistanceToNow(updatedAt, { addSuffix: true })}
    </time>
  );
}

function ClaimCard({ claim, index }: { claim: Claim, index: number }) {
  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <CardTitle className="flex text-xl font-medium leading-snug">
          <span className="text-muted-foreground">{index + 1}.&nbsp;</span>
          <AiText source={claim.title} />
        </CardTitle>
        <CardAction className="flex flex-wrap items-center gap-2">
          {claim.updatedAt ? (
            <ClaimTimeAgo updatedAt={claim.updatedAt} />
          ) : null}
          <Badge variant="destructive">{statusLabel(claim.agentStatus)}</Badge>
        </CardAction>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {claim.description ? (
          <CardDescription className="text-base leading-relaxed">
            <AiText source={claim.description} />
          </CardDescription>
        ) : null}

        {claim.evidences.length > 0 ? (
          <div className="flex flex-col gap-4">
            {claim.evidences.map((evidence, index) => (
              <EvidenceBlock
                key={`${evidence.filePath}:${evidence.startLine}:${evidence.endLine}:${index}`}
                evidence={evidence}
              />
            ))}
          </div>
        ) : null}
      </CardContent>

      <CardFooter className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
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

function EvidenceBlock({ evidence }: { evidence: Evidence }) {
  return (
    <div className="flex flex-col gap-3 border-t pt-4 first:border-t-0 first:pt-0">

      {(evidence.before || evidence.after) && (
        <div className="grid gap-3 sm:grid-cols-2">
          {evidence.before && (
            <InfoPanel label="Before" direction="left" text={evidence.before} />
          )}
          {evidence.after && (
            <InfoPanel label="After" direction="right" text={evidence.after} />
          )}
        </div>
      )}

      <code className="font-mono text-sm text-muted-foreground">
        {evidence.filePath}:{evidence.startLine}-{evidence.endLine}
      </code>

      <EvidenceDiff evidence={evidence} />
    </div>
  );
}

function InfoPanel({
  label,
  direction,
  text,
}: {
  label: string;
  direction: "left" | "right";
  text: string;
}) {
  return (
    <div className="min-h-22 rounded-lg bg-muted p-4">
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
        <strong>{label}:</strong> <AiText source={text} inline />
      </div>
    </div>
  );
}

function AiText({
  source,
  inline = false,
}: {
  source: string;
  inline?: boolean;
}) {
  return (
    <Streamdown
      className={cn(proseClassName, inline && "inline [&>*]:inline")}
      parseIncompleteMarkdown={false}
    >
      {source}
    </Streamdown>
  );
}

function EvidenceDiff({ evidence }: { evidence: Evidence }) {
  const [open, setOpen] = React.useState(false);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const { resolvedTheme } = useTheme();
  const diffTheme = resolvedTheme === "dark" ? "pierre-dark" : "pierre-light";
  const {
    data: loadedDiff,
    isError: diffError,
    isFetching: diffFetching,
    refetch: refetchDiff,
  } = useQuery({
    queryKey: ["evidence-diff", evidence.claimId, evidence.filePath],
    queryFn: ({ signal }) => fetchEvidenceDiff(evidence, signal),
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
  const diff = evidence.diff ?? loadedDiff ?? "";

  const selectedLines = React.useMemo(
    () => ({
      start: evidence.startLine,
      end: evidence.endLine,
      side: "additions" as const,
      endSide: "additions" as const,
    }),
    [evidence.endLine, evidence.startLine],
  );

  React.useEffect(() => {
    if (!open || !diff) return;

    let frame = 0;
    let attempts = 0;
    const scrollToSelectedLine = () => {
      attempts += 1;
      const panel = panelRef.current;
      const diffRoot = panel?.querySelector("diffs-container");
      const target = diffRoot?.shadowRoot?.querySelector<HTMLElement>(
        '[data-selected-line="first"], [data-selected-line="single"], [data-selected-line]',
      );

      if (!panel || !target) {
        if (attempts < 12)
          frame = window.requestAnimationFrame(scrollToSelectedLine);
        return;
      }

      const panelRect = panel.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      panel.scrollTo({
        top:
          panel.scrollTop +
          targetRect.top -
          panelRect.top -
          panel.clientHeight * 0.35,
        behavior: "smooth",
      });
    };

    frame = window.requestAnimationFrame(scrollToSelectedLine);
    return () => window.cancelAnimationFrame(frame);
  }, [open, diff, selectedLines]);

  const patch = diff || collapsedEvidencePatch(evidence);
  const collapsed = !open || !diff;
  const toggleLabel = diffError ? (
    "Retry"
  ) : (open && !diff) || (!diff && diffFetching) ? (
    "Loading..."
  ) : open ? (
    <ChevronDown data-icon="inline-start" />
  ) : (
    <ChevronRight data-icon="inline-start" />
  );

  const toggleDiff = React.useCallback(() => {
    if (diffError) {
      setOpen(true);
      void refetchDiff();
      return;
    }
    if (open && diff) {
      setOpen(false);
      return;
    }
    setOpen(true);
  }, [diff, diffError, open, refetchDiff]);

  return (
    <div
      ref={panelRef}
      className="max-h-[520px] overflow-auto [&_code]:font-mono [&_pre]:font-mono"
    >
      <PatchDiff
        key={`${diffTheme}:${diff ? "loaded" : "placeholder"}`}
        patch={patch}
        disableWorkerPool
        selectedLines={diff ? selectedLines : null}
        renderHeaderPrefix={() => (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs -ml-2"
            disabled={open && !diff && !diffError}
            onClick={toggleDiff}
          >
            {toggleLabel}
          </Button>
        )}
        // renderHeaderMetadata={(x) => (
        //   <code className="font-mono text-sm text-muted-foreground whitespace-pre-wrap">
        //     {JSON.stringify(x, null, 2)}
        //   </code>
        // )}
        options={{
          theme: diffTheme,
          diffStyle: "unified",
          overflow: "wrap",
          diffIndicators: "classic",
          disableLineNumbers: false,
          disableFileHeader: false,
          collapsed,
          stickyHeader: true,
        }}
      />
    </div>
  );
}

function collapsedEvidencePatch(evidence: Evidence) {
  const path = evidence.filePath;
  const line = Math.max(1, evidence.startLine);
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${line},0 +${line},0 @@`,
    "",
  ].join("\n");
}

async function fetchEvidenceDiff(evidence: Evidence, signal?: AbortSignal) {
  const response = await fetch(
    `/api/claims/${encodeURIComponent(evidence.claimId)}/evidence-diff?filePath=${encodeURIComponent(evidence.filePath)}`,
    { cache: "no-store", signal },
  );
  if (!response.ok) throw new Error("Failed to load evidence diff.");
  const payload = (await response.json()) as { diff?: string };
  return payload.diff ?? "";
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
