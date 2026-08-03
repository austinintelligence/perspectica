import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const defaultOutput = path.join(repositoryRoot, "apps", "extension", ".output", "chrome-mv3");

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) files.push(...(await walk(absolute)));
    else files.push(absolute);
  }
  return files;
}

const outputDirectory = path.resolve(option("--output", defaultOutput));
const top = Math.max(1, Number(option("--top", "10")) || 10);
const maxMiBArgument = option("--max-total-mib", undefined);
const maxBytes = maxMiBArgument === undefined ? undefined : Number(maxMiBArgument) * 1024 * 1024;

if (maxBytes !== undefined && (!Number.isFinite(maxBytes) || maxBytes < 0)) {
  process.stderr.write("--max-total-mib must be a finite, non-negative number.\n");
  process.exit(2);
}

try {
  const files = await walk(outputDirectory);
  const sized = await Promise.all(
    files.map(async (file) => ({
      file: path.relative(outputDirectory, file).replaceAll("\\", "/"),
      bytes: (await stat(file)).size,
    })),
  );
  sized.sort((left, right) => right.bytes - left.bytes || left.file.localeCompare(right.file));
  const totalBytes = sized.reduce((total, file) => total + file.bytes, 0);
  const result = {
    output: path.relative(repositoryRoot, outputDirectory) || ".",
    files: sized.length,
    totalBytes,
    totalMiB: Number((totalBytes / 1024 / 1024).toFixed(3)),
    largest: sized.slice(0, top),
    maxTotalMiB: maxBytes === undefined ? null : Number((maxBytes / 1024 / 1024).toFixed(3)),
  };
  process.stdout.write(
    process.argv.includes("--json")
      ? `${JSON.stringify(result, null, 2)}\n`
      : [
          `Extension size: ${result.totalMiB.toFixed(3)} MiB (${result.totalBytes} bytes) across ${result.files} files.`,
          `Largest ${result.largest.length} files:`,
          ...result.largest.map(
            (file) => `  ${(file.bytes / 1024).toFixed(1).padStart(9)} KiB  ${file.file}`,
          ),
        ].join("\n") + "\n",
  );
  if (maxBytes !== undefined && totalBytes > maxBytes) {
    process.stderr.write(`Extension size exceeds --max-total-mib ${maxMiBArgument}.\n`);
    process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(
    `Extension size report could not inspect ${outputDirectory}: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
