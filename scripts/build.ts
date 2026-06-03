import tailwind from "bun-plugin-tailwind";

const args = Bun.argv.slice(2);
const outfile =
  args.find((arg) => arg.startsWith("--outfile="))?.slice("--outfile=".length) ??
  "dist/paire";
const explicitVersion = args
  .find((arg) => arg.startsWith("--version="))
  ?.slice("--version=".length);
const version =
  explicitVersion ??
  Bun.env.PAIRE_VERSION ??
  tagFromGithubRef(Bun.env.GITHUB_REF, Bun.env.GITHUB_REF_NAME) ??
  (await exactGitTag()) ??
  "dev";

const result = await Bun.build({
  entrypoints: ["src/cli.ts"],
  define: {
    __PAIRE_VERSION__: JSON.stringify(version),
  },
  compile: {
    outfile,
  },
  plugins: [tailwind],
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

function tagFromGithubRef(ref: string | undefined, refName: string | undefined) {
  if (ref?.startsWith("refs/tags/")) return ref.slice("refs/tags/".length);
  return refName?.startsWith("v") ? refName : undefined;
}

async function exactGitTag() {
  const result = Bun.spawnSync(["git", "describe", "--tags", "--exact-match"], {
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) return undefined;
  const tag = new TextDecoder().decode(result.stdout).trim();
  return tag.length > 0 ? tag : undefined;
}
