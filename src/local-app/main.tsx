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

import { Button } from "./components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./components/ui/collapsible";
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
  text: string;
  agentStatus: string;
  humanStatus: HumanStatus;
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
      <main className="shell">
        <div className="empty">Loading review...</div>
      </main>
    );
  }

  if (isError || !data) {
    return (
      <main className="shell">
        <div className="empty">Unable to load review data.</div>
      </main>
    );
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Paire Review</p>
          <h1>{data.session.goal ?? data.session.projectKey}</h1>
        </div>
        <div className="repo-state">
          <span>{data.git.branch}</span>
          <span>{data.burden}</span>
        </div>
      </header>

      <section className="review-list">
        {data.threads.length === 0 ? (
          <div className="empty">No review claims have been applied yet.</div>
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

function ClaimCard({ thread, claim }: { thread: Thread; claim: Claim }) {
  const evidence = claim.evidences[0];
  const statusLabel = claim.agentStatus.replaceAll("_", " ");

  return (
    <article className="claim-card">
      <div className="claim-header">
        <span className="category-pill">{thread.title || "Behavior"}</span>
        <div className="status-group">
          <span className="severity-pill">{statusLabel}</span>
          <span className="observed">
            {claim.humanStatus === "accepted" ? "accepted" : "observed"}
          </span>
        </div>
      </div>

      <h2>{claim.text}</h2>
      {thread.summary ? <p className="summary">{thread.summary}</p> : null}

      <div className="before-after">
        <InfoPanel
          label="Before"
          direction="left"
          text={
            evidence?.before ||
            "Previous behavior was not captured for this claim."
          }
        />
        <InfoPanel
          label="After"
          direction="right"
          text={evidence?.after || claim.text}
        />
      </div>

      {evidence ? <EvidenceDiff evidence={evidence} /> : null}

      <footer className="claim-footer">
        <code>
          {evidence
            ? `${evidence.filePath}:${evidence.startLine}-${evidence.endLine}`
            : "No evidence span"}
        </code>
        <ClaimActions claim={claim} />
      </footer>
    </article>
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
    <div className="info-panel">
      <p>
        <span aria-hidden="true">{direction === "left" ? "<-" : "->"}</span>
        <strong>{label}:</strong> {text}
      </p>
    </div>
  );
}

function EvidenceDiff({ evidence }: { evidence: Evidence }) {
  if (!evidence.diff) return null;

  return (
    <Collapsible className="diff-collapsible" defaultOpen={false}>
      <CollapsibleTrigger className="diff-trigger">
        <span>Code diff</span>
        <ChevronDown size={18} aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsibleContent className="diff-panel" keepMounted>
        <PatchDiff
          patch={evidence.diff}
          disableWorkerPool
          options={{
            diffStyle: "unified",
            overflow: "wrap",
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
    <div className="segmented-actions">
      <Button
        type="button"
        variant="outline"
        className="segment comment"
        onClick={() => commentMutation.mutate()}
      >
        <MessageSquare size={20} />
        Comment
      </Button>
      <Button
        type="button"
        variant={claim.humanStatus === "accepted" ? "default" : "outline"}
        className="segment accept"
        onClick={() => acceptMutation.mutate()}
      >
        {claim.humanStatus === "accepted" ? <Check size={20} /> : null}
        Ok
        <ThumbsUp size={20} />
      </Button>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
