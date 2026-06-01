import { formatDistanceToNow } from "date-fns";
import { PatchDiff } from "@pierre/diffs/react";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Check, ChevronDown, MessageSquare, ThumbsUp } from "lucide-react";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { Streamdown } from "streamdown";

import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./components/ui/collapsible";
import { cn } from "./lib/utils";
import "./styles.css";

type HumanStatus = "unreviewed" | "accepted" | "concern" | "irrelevant";

type Evidence = {
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
  git: { branch: string; head: string; clean: boolean };
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

async function fetchReview() {
  const response = await fetch("/api/review", { cache: "no-store" });
  if (!response.ok) throw new Error("Failed to load review data.");
  return (await response.json()) as ReviewData;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ReviewScreen />
    </QueryClientProvider>
  );
}

function ReviewScreen() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["review"],
    queryFn: fetchReview,
    refetchInterval: 2_500,
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

  return (
    <main className={pageClassName}>
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
        </div>
      </header>

      <section className="grid gap-3.5">
        {data.threads.length === 0 ? (
          <EmptyState>No review claims have been applied yet.</EmptyState>
        ) : (
          data.threads.map((thread) =>
            thread.claims.map((claim) => (
              <ClaimCard key={claim.id} thread={thread} claim={claim} />
            )),
          )
        )}
      </section>
    </main>
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

function ClaimCard({ thread, claim }: { thread: Thread; claim: Claim }) {
  const evidence = claim.evidences[0];
  const statusLabel = claim.agentStatus.replaceAll("_", " ");

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <Badge variant="secondary" className="px-2.5 py-1 text-sm">
          <AiText source={thread.title || "Behavior"} inline />
        </Badge>
        <CardAction className="flex flex-wrap items-center gap-2">
          {claim.updatedAt ? (
            <ClaimTimeAgo updatedAt={claim.updatedAt} />
          ) : null}
          <Badge variant="destructive">{statusLabel}</Badge>
          <Badge variant="outline" className="text-muted-foreground">
            {claim.humanStatus === "accepted" ? "accepted" : "observed"}
          </Badge>
        </CardAction>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <CardTitle className="text-xl font-medium leading-snug">
          <AiText source={claim.title} />
        </CardTitle>
        {claim.description ? (
          <CardDescription className="text-base leading-relaxed">
            <AiText source={claim.description} />
          </CardDescription>
        ) : null}

        {(evidence?.before || evidence?.after) && (
          <div className="grid gap-3 sm:grid-cols-2">
            {evidence?.before && (
              <InfoPanel
                label="Before"
                direction="left"
                text={evidence?.before}
              />
            )}
            {evidence?.after && (
              <InfoPanel
                label="After"
                direction="right"
                text={evidence?.after}
              />
            )}
          </div>
        )}

        {thread.summary ? (
          <CardDescription className="text-base leading-relaxed">
            <AiText source={thread.summary} />
          </CardDescription>
        ) : null}

        {evidence ? <EvidenceDiff evidence={evidence} /> : null}
      </CardContent>

      <CardFooter className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
        <code className="font-mono text-sm text-muted-foreground">
          {evidence
            ? `${evidence.filePath}:${evidence.startLine}-${evidence.endLine}`
            : "No evidence span"}
        </code>
        <ClaimActions claim={claim} />
      </CardFooter>
    </Card>
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
        <span aria-hidden="true" className="mr-2 text-foreground">
          {direction === "left" ? "<-" : "->"}
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
    if (!open) return;

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
  }, [open, evidence.diff, selectedLines]);

  if (!evidence.diff) return null;

  return (
    <Collapsible
      className="overflow-hidden rounded-lg border bg-background"
      open={open}
      onOpenChange={setOpen}
    >
      <CollapsibleTrigger className="flex w-full cursor-pointer items-center justify-between bg-muted px-3 py-2 text-sm font-semibold text-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring [&[data-open]>svg]:rotate-180 [&[data-panel-open]>svg]:rotate-180">
        <span>Code diff</span>
        <ChevronDown
          aria-hidden="true"
          className="size-4 transition-transform"
        />
      </CollapsibleTrigger>
      <CollapsibleContent
        ref={panelRef}
        className="max-h-[520px] overflow-auto [&_code]:font-mono [&_pre]:font-mono"
        keepMounted
      >
        <PatchDiff
          patch={evidence.diff}
          disableWorkerPool
          selectedLines={selectedLines}
          options={{
            diffStyle: "unified",
            overflow: "wrap",
            diffIndicators: "classic",
            disableLineNumbers: false,
            disableFileHeader: false,
          }}
        />
      </CollapsibleContent>
    </Collapsible>
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
