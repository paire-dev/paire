export const ExitCode = {
  Success: 0,
  Generic: 1,
  UserError: 2,
  AgentError: 3,
  GitStateError: 4,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export const exitCodeDescriptions: Record<ExitCode, string> = {
  [ExitCode.Success]: "success",
  [ExitCode.Generic]: "generic error",
  [ExitCode.UserError]: "invalid user input or usage",
  [ExitCode.AgentError]: "agent/tool invocation failed",
  [ExitCode.GitStateError]: "git repository state prevents the command",
};
