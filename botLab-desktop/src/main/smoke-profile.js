import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// FA_SMOKE exercises the real boot/poll/accrual path. Redirect the ENTIRE Electron profile before
// app.whenReady() so loading settings/positions and any subsequent save cannot touch the user's
// forward-test ledger. The small paper lifecycle fixture created later in main.js is not enough:
// without this guard, normal boot settlement still reads and writes the real userData directory.
export function isolateSmokeProfile(electronApp, {
  enabled = process.env.FA_SMOKE === "1",
  makeTempDir = () => mkdtempSync(join(tmpdir(), "fa-smoke-userdata-")),
  registerExit = (fn) => process.once("exit", fn),
  removeDir = (dir) => rmSync(dir, { recursive: true, force: true }),
} = {}) {
  if (!enabled) return null;
  const dir = makeTempDir();
  electronApp.setPath("userData", dir);
  registerExit(() => removeDir(dir));
  return dir;
}
