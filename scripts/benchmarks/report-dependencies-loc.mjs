import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sourceRoots = [path.join(repositoryRoot, "apps"), path.join(repositoryRoot, "packages")];
const sourceExtensions = /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/i;
const testFile = /(?:\.test|\.spec)\.[^.]+$/i;
const generatedDirectories = new Set([
  "node_modules",
  ".next",
  ".output",
  ".wxt",
  "coverage",
  "dist",
  "target",
  ".turbo",
]);

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (generatedDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(absolute)));
    else if (sourceExtensions.test(entry.name)) files.push(absolute);
  }
  return files;
}

function lineCounts(text) {
  const lines = text.split(/\r?\n/);
  return {
    lines: Math.max(0, lines.length - (lines.at(-1) === "" ? 1 : 0)),
    nonEmpty: lines.filter((line) => line.trim()).length,
  };
}

const packageFiles = [path.join(repositoryRoot, "package.json")];
for (const workspaceRoot of ["apps", "packages"]) {
  let entries = [];
  try {
    entries = await readdir(path.join(repositoryRoot, workspaceRoot), { withFileTypes: true });
  } catch {
    continue;
  }
  for (const entry of entries) {
    if (entry.isDirectory())
      packageFiles.push(path.join(repositoryRoot, workspaceRoot, entry.name, "package.json"));
  }
}

try {
  const packages = [];
  for (const packageFile of packageFiles) {
    try {
      const manifest = await readJson(packageFile);
      packages.push({
        name: manifest.name ?? path.basename(path.dirname(packageFile)),
        path: path.relative(repositoryRoot, packageFile),
        dependencies: Object.keys(manifest.dependencies ?? {}).sort(),
        devDependencies: Object.keys(manifest.devDependencies ?? {}).sort(),
        peerDependencies: Object.keys(manifest.peerDependencies ?? {}).sort(),
        optionalDependencies: Object.keys(manifest.optionalDependencies ?? {}).sort(),
      });
    } catch {
      // A workspace directory without package.json is not a package and is ignored.
    }
  }

  const files = (await Promise.all(sourceRoots.map((root) => walk(root)))).flat().sort();
  const counts = {
    files: files.length,
    lines: 0,
    nonEmpty: 0,
    tests: { files: 0, lines: 0, nonEmpty: 0 },
    source: { files: 0, lines: 0, nonEmpty: 0 },
  };
  for (const file of files) {
    const count = lineCounts(await readFile(file, "utf8"));
    const bucket = testFile.test(file) ? counts.tests : counts.source;
    bucket.files += 1;
    bucket.lines += count.lines;
    bucket.nonEmpty += count.nonEmpty;
    counts.lines += count.lines;
    counts.nonEmpty += count.nonEmpty;
  }

  const result = { packages, loc: counts };
  process.stdout.write(
    process.argv.includes("--json")
      ? `${JSON.stringify(result, null, 2)}\n`
      : [
          `Workspace packages: ${packages.length}`,
          ...packages.map(
            (pkg) =>
              `${pkg.name}: deps=${pkg.dependencies.length} dev=${pkg.devDependencies.length} peer=${pkg.peerDependencies.length} optional=${pkg.optionalDependencies.length}`,
          ),
          `Source files: ${counts.source.files}, ${counts.source.lines} lines (${counts.source.nonEmpty} non-empty)`,
          `Test files: ${counts.tests.files}, ${counts.tests.lines} lines (${counts.tests.nonEmpty} non-empty)`,
          `Total files: ${counts.files}, ${counts.lines} lines (${counts.nonEmpty} non-empty)`,
        ].join("\n") + "\n",
  );
} catch (error) {
  process.stderr.write(
    `Dependency/LOC report failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
