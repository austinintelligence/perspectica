import { access, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const outputDirectory = path.join(root, "apps", "extension", ".output", "chrome-mv3");
const manifestPath = path.join(outputDirectory, "manifest.json");

const forbiddenFilePatterns = [
  /(^|\/)\.env(?:\.|$)/i,
  /\.(?:sqlite|sqlite-shm|sqlite-wal)$/i,
  /(^|\/)data\//i,
  /(^|\/)datasets\/political-spectrum\/(?!README\.md$|summary\.json$)/i,
];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      fail(`symbolic links are not allowed in the release package: ${absolute}`);
      continue;
    }
    if (entry.isDirectory()) files.push(...(await walk(absolute)));
    else files.push(absolute);
  }
  return files;
}

function fail(message) {
  process.stderr.write(`Extension package check failed: ${message}\n`);
  process.exitCode = 1;
}

try {
  await access(manifestPath);
} catch {
  fail(`missing production manifest at ${manifestPath}; run pnpm build first`);
  process.exit();
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const files = await walk(outputDirectory);
const relativeFiles = files.map((file) =>
  path.relative(outputDirectory, file).replaceAll("\\", "/"),
);

for (const file of relativeFiles) {
  if (forbiddenFilePatterns.some((pattern) => pattern.test(file))) {
    fail(`forbidden local or secret-bearing artifact: ${file}`);
  }
}

if (manifest.manifest_version !== 3) fail("manifest_version must be 3");
if (!manifest.background?.service_worker) fail("MV3 background service worker is missing");
if (!manifest.side_panel?.default_path) fail("side-panel entrypoint is missing");
if ((manifest.content_scripts ?? []).length > 0) {
  fail("persistent content scripts are not allowed; article extraction must remain on demand");
}

const manifestText = JSON.stringify(manifest);
if (/https?:\/\/(?:localhost|127(?:\.\d+){3})/i.test(manifestText)) {
  fail("production manifest contains a localhost origin");
}

const requiredOrigins = new Set(manifest.host_permissions ?? []);
const optionalOrigins = new Set(manifest.optional_host_permissions ?? []);
if (requiredOrigins.size > 0) {
  fail("article access must not be a required host permission");
}
const expectedOptionalOrigins = new Set([
  "https://auth.openai.com/*",
  "https://chatgpt.com/*",
  "<all_urls>",
]);
if (
  optionalOrigins.size !== expectedOptionalOrigins.size ||
  [...expectedOptionalOrigins].some((origin) => !optionalOrigins.has(origin))
) {
  fail("optional host permissions must contain only the two OpenAI origins and <all_urls>");
}

let totalBytes = 0;
for (const file of files) totalBytes += (await stat(file)).size;

if (!process.exitCode) {
  process.stdout.write(
    [
      "Extension package check passed.",
      `Files: ${files.length}`,
      `Unpacked size: ${(totalBytes / 1024 / 1024).toFixed(2)} MiB`,
      `Permissions: ${(manifest.permissions ?? []).join(", ") || "none"}`,
      `Required host permissions: ${[...requiredOrigins].join(", ") || "none"}`,
      `Optional host permissions: ${[...optionalOrigins].join(", ") || "none"}`,
    ].join("\n") + "\n",
  );
}
