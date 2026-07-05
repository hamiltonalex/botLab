// check-changelog.mjs — release gate (OTA plan §8.1, §9.2-3). Two invariants for the version being
// released:
//   1. CHANGELOG.md has a `## [X.Y.Z]` section, and that section carries an **Влияние** (impact) line
//      — the forcing function so every release consciously states its blast radius.
//   2. If the release's diff touches src/engine/** (the trading math), the impact line may NOT declare
//      "нет"/"none": a change to the engine must state a real impact (⚠️/💰/🖥/⚙️). This is the
//      §9.2-3 "engine diff ⇒ impact marker" gate, checked against CHANGELOG.md (which IS the release
//      body, §8.2) so it needs no GitHub API. The git-diff half is best-effort: if history/tags are
//      unavailable (shallow clone), it degrades to a notice rather than a false failure.
//
// Version source (same precedence as check-tag-version): arg → $GITHUB_REF_NAME → $GITHUB_REF → package.json.

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const rawTag = process.argv[2] || process.env.GITHUB_REF_NAME || process.env.GITHUB_REF || "";
const version = (rawTag.replace(/^refs\/tags\//, "").replace(/^v/, "").trim()) || pkg.version;

const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");

// Extract the `## [X.Y.Z] …` section: everything from that heading up to the next `## [` (or EOF).
// Done line-by-line rather than with a regex (JS has no `\Z`, and end-of-string lookarounds are brittle).
const headRe = /^## \[([^\]]+)\]/;
const sectionLines = [];
let inSection = false;
for (const line of changelog.split("\n")) {
  const h = line.match(headRe);
  if (h) {
    if (inSection) break; // next heading -> section ends
    if (h[1] === version) inSection = true; // found our version's heading
    continue;
  }
  if (inSection) sectionLines.push(line);
}
if (!inSection) {
  console.error(`check-changelog: FAIL — no "## [${version}]" section in CHANGELOG.md.\n  Add the release section before tagging v${version}.`);
  process.exit(1);
}
const section = sectionLines.join("\n");

const impactLine = section.split("\n").find((l) => /Влияние/i.test(l));
if (!impactLine) {
  console.error(`check-changelog: FAIL — the [${version}] section has no **Влияние** (impact) line.\n  State the release impact (⚠️ торговая логика · 💰 P&L · 🖥 UI · ⚙️ настройки/данные, or "Влияние: нет").`);
  process.exit(1);
}

// §9.2-3 engine gate: did this release touch the trading engine? (best-effort — never fails on git errors)
let engineChanged = false;
let engineNote = "no previous tag — engine-diff skipped (first release)";
try {
  const tags = execSync("git tag --sort=-v:refname", { cwd: root, encoding: "utf8" })
    .split("\n").map((t) => t.trim()).filter((t) => /^v\d+\.\d+\.\d+/.test(t));
  const curTag = `v${version}`;
  const idx = tags.indexOf(curTag);
  const prevTag = idx >= 0 ? tags[idx + 1] : tags.find((t) => t !== curTag);
  if (prevTag) {
    const diff = execSync(`git diff --name-only ${prevTag} HEAD -- src/engine`, { cwd: root, encoding: "utf8" }).trim();
    engineChanged = diff.length > 0;
    engineNote = `${prevTag}..HEAD engine diff: ${engineChanged ? "CHANGED" : "unchanged"}`;
  }
} catch (err) {
  engineNote = `engine-diff skipped (git unavailable: ${String(err.message || err).split("\n")[0]})`;
}

// \b is ASCII-only in JS and forms no boundary around Cyrillic, so use \p{L} lookarounds as a
// Unicode-aware word boundary — otherwise "Влияние: нет" would slip past the engine gate.
const saysNone = /(?<!\p{L})(нет|none)(?!\p{L})/iu.test(impactLine) && !/[⚠️💰🖥⚙️]/u.test(impactLine);
if (engineChanged && saysNone) {
  console.error(`check-changelog: FAIL — src/engine/** changed but [${version}] declares "Влияние: нет".\n  An engine change must state a real impact (⚠️ торговая логика / 💰 P&L at minimum). Line was:\n  ${impactLine.trim()}`);
  process.exit(1);
}

console.log(`check-changelog: OK — [${version}] section present with an impact line. ${engineNote}.`);
