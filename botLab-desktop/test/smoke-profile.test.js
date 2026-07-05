import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isolateSmokeProfile } from "../src/main/smoke-profile.js";

test("FA_SMOKE redirects the complete Electron userData profile and removes it on exit", () => {
  const dir = join(tmpdir(), `fa-smoke-profile-test-${process.pid}-${Date.now()}`);
  let assigned = null;
  let onExit = null;
  const app = { setPath(name, value) { assigned = { name, value }; } };

  const result = isolateSmokeProfile(app, {
    enabled: true,
    makeTempDir: () => { mkdirSync(dir); return dir; },
    registerExit: (fn) => { onExit = fn; },
  });

  assert.equal(result, dir);
  assert.deepEqual(assigned, { name: "userData", value: dir });
  writeFileSync(join(dir, "positions.json"), "isolated");
  assert.ok(existsSync(dir));
  onExit();
  assert.ok(!existsSync(dir), "temporary smoke profile is cleaned up");
});

test("normal launches keep Electron's configured userData profile", () => {
  let setCalls = 0;
  const result = isolateSmokeProfile({ setPath() { setCalls++; } }, { enabled: false });
  assert.equal(result, null);
  assert.equal(setCalls, 0);
});
