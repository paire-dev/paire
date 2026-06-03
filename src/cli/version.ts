declare const __PAIRE_VERSION__: string | undefined;

export const PAIRE_VERSION =
  typeof __PAIRE_VERSION__ === "string" && __PAIRE_VERSION__.length > 0
    ? __PAIRE_VERSION__
    : "dev";
