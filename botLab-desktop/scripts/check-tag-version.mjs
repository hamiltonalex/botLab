// check-tag-version.mjs — release gate (OTA plan §7.3, §7.5).
//
// The version lives in exactly ONE place: package.json "version". The git tag that triggers a
// release must be "v<that version>". This script makes that invariant enforceable in CI: if a tag
// is pushed whose name disagrees with package.json, the release job fails BEFORE anything is built,
// signed, or published — so a mistagged release can never reach users.
//
// Tag source, in priority order:
//   1. an explicit CLI arg          → `node scripts/check-tag-version.mjs v0.2.0` (local check)
//   2. $GITHUB_REF_NAME             → GitHub Actions sets this to the bare tag on a tag push
//   3. $GITHUB_REF (refs/tags/...)  → fallback, stripped to the bare tag

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
const expected = `v${pkg.version}`;

const rawTag = process.argv[2] || process.env.GITHUB_REF_NAME || process.env.GITHUB_REF || "";
const tag = rawTag.replace(/^refs\/tags\//, "").trim();

if (!tag) {
  console.error(
    "check-tag-version: no tag to check (pass one as an argument, or run inside a tag-triggered CI job).",
  );
  process.exit(1);
}

if (tag !== expected) {
  console.error(
    `check-tag-version: FAIL — git tag "${tag}" does not match package.json version "${expected}".\n` +
      `  Fix: set package.json "version" to ${tag.replace(/^v/, "")} (or retag as ${expected}).`,
  );
  process.exit(1);
}

console.log(`check-tag-version: OK — tag "${tag}" matches package.json version.`);
