export function normalizeFilePath(filePath: string) {
  return filePath.replace(/^\.\/+/, "").replace(/\\/g, "/");
}

export function filePathsMatch(left: string, right: string) {
  const a = normalizeFilePath(left);
  const b = normalizeFilePath(right);
  if (a === b) return true;
  return a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

export function resolveFilePathMatch<T>(
  candidates: readonly T[],
  targetPath: string,
  getCandidatePaths: (candidate: T) => readonly (string | null | undefined)[],
) {
  const target = normalizeFilePath(targetPath);
  const exactMatches = candidates.filter((candidate) =>
    getCandidatePaths(candidate).some(
      (path) => path != null && normalizeFilePath(path) === target,
    ),
  );
  if (exactMatches.length > 0) return exactMatches[0];

  const suffixMatches = candidates.filter((candidate) =>
    getCandidatePaths(candidate).some((path) => {
      if (path == null) return false;
      const normalized = normalizeFilePath(path);
      return normalized.endsWith(`/${target}`) || target.endsWith(`/${normalized}`);
    }),
  );

  return suffixMatches.length === 1 ? suffixMatches[0] : undefined;
}
