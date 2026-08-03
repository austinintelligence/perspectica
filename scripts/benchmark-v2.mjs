import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(root, "apps", "extension", ".output", "chrome-mv3");
const sourceRoots = [path.join(root, "apps", "extension"), path.join(root, "packages")];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".output" || entry.name === ".git")
      continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(absolute)));
    else files.push(absolute);
  }
  return files;
}

async function bytes(files) {
  const sizes = await Promise.all(files.map(async (file) => (await stat(file)).size));
  return sizes.reduce((total, value) => total + value, 0);
}

const buildFiles = await walk(outputRoot);
const sourceFiles = (await Promise.all(sourceRoots.map(walk)))
  .flat()
  .filter((file) => /\.(?:ts|tsx)$/.test(file));
const javascript = buildFiles.filter((file) => /\.js$/.test(file));
const css = buildFiles.filter((file) => /\.css$/.test(file));
const result = {
  buildFiles: buildFiles.length,
  buildBytes: await bytes(buildFiles),
  javascriptBytes: await bytes(javascript),
  cssBytes: await bytes(css),
  sourceFiles: sourceFiles.length,
  legacyProductionPackagesPresent: sourceFiles.some((file) =>
    /packages[\\/]analysis[\\/]|packages[\\/]compass[\\/]|packages[\\/]validation[\\/]/.test(file),
  ),
};

console.log(JSON.stringify(result, null, 2));
