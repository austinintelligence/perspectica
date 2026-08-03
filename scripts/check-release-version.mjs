import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const repositoryRoot = process.cwd();
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? "";

function fail(message) {
  process.stderr.write(`Release version check failed: ${message}\n`);
  process.exitCode = 1;
}

async function packageVersion(relativePath) {
  const contents = await readFile(path.join(repositoryRoot, relativePath), "utf8");
  const parsed = JSON.parse(contents);
  if (typeof parsed.version !== "string" || !/^\d+\.\d+\.\d+$/.test(parsed.version)) {
    fail(`${relativePath} must contain a semantic X.Y.Z version`);
    return null;
  }
  return parsed.version;
}

const [rootVersion, extensionVersion] = await Promise.all([
  packageVersion("package.json"),
  packageVersion("apps/extension/package.json"),
]);

if (rootVersion && extensionVersion && rootVersion !== extensionVersion) {
  fail(`package versions differ (${rootVersion} vs ${extensionVersion})`);
}

if (tag) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
    fail(`release tag ${JSON.stringify(tag)} must use vX.Y.Z`);
  } else if (extensionVersion && tag.slice(1) !== extensionVersion) {
    fail(`release tag ${tag} does not match extension version ${extensionVersion}`);
  }
}

if (!process.exitCode) {
  process.stdout.write(
    `Release version check passed: ${extensionVersion}${tag ? ` (${tag})` : ""}\n`,
  );
}
