import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type PaireConfig = {
  version: 1;
  hooks: string[];
  baseBranch?: string;
  brief: {
    includeDiff: boolean;
    includeHistory: boolean;
  };
};

export const defaultConfig: PaireConfig = {
  version: 1,
  hooks: [],
  brief: {
    includeDiff: true,
    includeHistory: true,
  },
};

export function repoConfigPath(cwd: string): string {
  return join(cwd, ".paire", "config.yml");
}

export function homeConfigPath(): string | undefined {
  const home = process.env.HOME || process.env.USERPROFILE;
  return home ? join(home, ".paire", "config.yml") : undefined;
}

export function stringifyConfig(config: PaireConfig): string {
  return [
    `version: ${config.version}`,
    "hooks:",
    ...config.hooks.map((hook) => `  - ${hook}`),
    ...(config.baseBranch ? [`baseBranch: ${config.baseBranch}`] : []),
    "brief:",
    `  includeDiff: ${config.brief.includeDiff}`,
    `  includeHistory: ${config.brief.includeHistory}`,
    "",
  ].join("\n");
}

export function readConfig(cwd: string): PaireConfig {
  const path = repoConfigPath(cwd);
  if (!existsSync(path)) return defaultConfig;

  const raw = readFileSync(path, "utf8");
  const baseBranchMatch = raw.match(/^\s*baseBranch:\s*(\S+)\s*$/m);
  return {
    version: 1,
    hooks: Array.from(raw.matchAll(/^\s*-\s*(.+)$/gm), (match) => match[1]?.trim()).filter(Boolean) as string[],
    baseBranch: baseBranchMatch?.[1],
    brief: {
      includeDiff: !/^\s*includeDiff:\s*false\s*$/m.test(raw),
      includeHistory: !/^\s*includeHistory:\s*false\s*$/m.test(raw),
    },
  };
}

export function writeRepoConfig(cwd: string, config: PaireConfig): string {
  const path = repoConfigPath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyConfig(config));
  return path;
}
