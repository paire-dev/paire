export type ReviewClaim = {
  id: string;
  threadId: string;
  title: string;
  agentStatus: "new" | "unchanged" | "evidence_moved" | "amended" | "invalidated" | "superseded";
  importance: string;
  evidences: Array<{
    filePath: string;
    startLine: number;
    endLine: number;
    change: string;
    symbol?: string;
  }>;
  before: string | null;
  after: string | null;
  description?: string;
};

export type GoldReview = {
  threads: Array<{
    id: string;
    title: string;
    summary?: string;
    claims: ReviewClaim[];
  }>;
};

export type FixtureSpec = {
  id: string;
  setup: (repoDir: string) => Promise<void> | void;
  change: (repoDir: string) => Promise<void> | void;
  change2?: (repoDir: string) => Promise<void> | void;
  gold: {
    expectedCoveredFiles: string[];
    expectedUnchanged?: string[];
    maxClaims?: number;
    goldReview: GoldReview;
  };
};

export type AgentRunInput = {
  repoDir: string;
  env: Record<string, string | undefined>;
  prompt: string;
  draftPath: string;
  goldReview: GoldReview;
  mode: string;
};

export type AgentRunResult = {
  transcript: string;
  exitCode: number;
  wallMs: number;
};

export type EvalCaseResult = {
  fixture: string;
  agent: string;
  applyAttempts: number;
  firstAttemptApplySuccess: boolean;
  applyEventuallySucceeded: boolean;
  wallClockMs: number;
  schemaErrorCount: number;
  errorHistogram: Record<string, number>;
  fileCoverage: number;
  acknowledgeRate: number;
  claimCount: number;
};
