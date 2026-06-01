import tailwind from "bun-plugin-tailwind";

const outfile =
  Bun.argv
    .slice(2)
    .find((arg) => arg.startsWith("--outfile="))
    ?.slice("--outfile=".length) ?? "dist/paire";

const result = await Bun.build({
  entrypoints: ["src/cli.ts"],
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
