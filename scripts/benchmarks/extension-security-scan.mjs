import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const defaultOutput = path.join(repositoryRoot, "apps", "extension", ".output", "chrome-mv3");
const allowedPermissions = new Set(["scripting", "storage", "offscreen", "sidePanel"]);
const expectedOptionalOrigins = new Set([
  "https://auth.openai.com/*",
  "https://chatgpt.com/*",
  "<all_urls>",
]);

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

function fail(message) {
  failures.push(message);
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      fail(`symbolic links are not allowed: ${path.relative(outputDirectory, absolute)}`);
    } else if (entry.isDirectory()) {
      files.push(...(await walk(absolute)));
    } else {
      files.push(absolute);
    }
  }
  return files;
}

const outputDirectory = path.resolve(option("--output", defaultOutput));
const manifestPath = path.join(outputDirectory, "manifest.json");
const failures = [];

try {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const files = await walk(outputDirectory);

  if (manifest.manifest_version !== 3) fail("manifest_version must be 3");
  if (!manifest.background?.service_worker) fail("background service worker is missing");
  if (!manifest.side_panel?.default_path) fail("side-panel entrypoint is missing");
  if ((manifest.content_scripts ?? []).length > 0)
    fail("persistent content scripts are not allowed");
  if ((manifest.host_permissions ?? []).length > 0) fail("required host permissions must be empty");

  const permissions = new Set(manifest.permissions ?? []);
  if (
    permissions.size !== allowedPermissions.size ||
    [...allowedPermissions].some((permission) => !permissions.has(permission))
  ) {
    fail("permissions must contain exactly scripting, storage, offscreen, and sidePanel");
  }
  const unexpectedPermissions = [...permissions].filter(
    (permission) => !allowedPermissions.has(permission),
  );
  if (unexpectedPermissions.length > 0) {
    fail(`unexpected permissions: ${unexpectedPermissions.join(", ")}`);
  }

  const optionalOrigins = new Set(manifest.optional_host_permissions ?? []);
  if (
    optionalOrigins.size !== expectedOptionalOrigins.size ||
    [...expectedOptionalOrigins].some((origin) => !optionalOrigins.has(origin))
  ) {
    fail("optional host permissions differ from the approved OpenAI origins and <all_urls>");
  }

  const manifestText = JSON.stringify(manifest);
  if (/https?:\/\/(?:localhost|127(?:\.\d+){3})/i.test(manifestText)) {
    fail("manifest contains a localhost origin");
  }

  const csp = manifest.content_security_policy?.extension_pages;
  if (typeof csp === "string") {
    if (/unsafe-eval/i.test(csp)) fail("extension_pages CSP enables unsafe-eval");
    if (/(?:^|[; ])(?:script-src|default-src)[^;]*(?:https?:|wss?:)/i.test(csp)) {
      fail("extension_pages CSP allows a remote script source");
    }
  }

  for (const file of files) {
    const relative = path.relative(outputDirectory, file).replaceAll("\\", "/");
    if (!/\.(?:html?|js|mjs|css)$/i.test(relative)) continue;
    const text = await readFile(file, "utf8");
    if (/\beval\s*\(/.test(text) || /\bnew\s+Function\s*\(/.test(text)) {
      fail(`${relative} contains dynamic code evaluation`);
    }
    if (/\.html?$/i.test(relative) && /<script[^>]+src=["']https?:\/\//i.test(text)) {
      fail(`${relative} loads a remote script`);
    }
  }

  const result = {
    output: path.relative(repositoryRoot, outputDirectory) || ".",
    files: files.length,
    permissions: [...permissions],
    optionalHostPermissions: [...optionalOrigins],
    csp: csp ?? "browser-default",
    failures,
  };
  const json = process.argv.includes("--json");
  process.stdout.write(
    json
      ? `${JSON.stringify(result, null, 2)}\n`
      : [
          failures.length === 0
            ? "Extension security scan passed."
            : "Extension security scan failed.",
          `Output: ${result.output}`,
          `Files inspected: ${result.files}`,
          `Permissions: ${result.permissions.join(", ") || "none"}`,
          `Optional host permissions: ${result.optionalHostPermissions.join(", ") || "none"}`,
          `CSP: ${result.csp}`,
          ...failures.map((failure) => `Failure: ${failure}`),
        ].join("\n") + "\n",
  );
} catch (error) {
  process.stderr.write(
    `Extension security scan could not inspect ${manifestPath}: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}

if (failures.length > 0) process.exitCode = 1;
