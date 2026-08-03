import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const command = process.argv.includes("--no-build")
  ? null
  : ["pnpm", ["--filter", "@perspectica/extension", "build"]];

if (command === null) {
  process.stdout.write(
    "Build timing skipped (--no-build); use report-extension-size.mjs for an existing output.\n",
  );
  process.exit(0);
}

const startedAt = performance.now();
const child = spawn(command[0], command[1], {
  cwd: repositoryRoot,
  stdio: "inherit",
  shell: process.platform === "win32",
});
child.on("error", (error) => {
  process.stderr.write(`Build command could not start: ${error.message}\n`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  const durationMs = Math.round(performance.now() - startedAt);
  process.stdout.write(
    `WXT production build wall time: ${durationMs} ms (process timing only; no browser performance claim).\n`,
  );
  if (signal) process.exitCode = 1;
  else if (code !== 0) process.exitCode = code ?? 1;
});
