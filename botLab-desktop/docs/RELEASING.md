# Releasing BotLab

How a version ships. BotLab updates over the air from **GitHub Releases** via `electron-updater`;
builds are produced **only in CI from a tag**, signed + notarized (macOS), attached to a **draft**,
and published **by a human** after a smoke check. Nothing here auto-publishes to users.

---

## 0. Frozen identifiers — never change after v0.2.0

These define the app's identity for the updater and code signing. Changing any one **breaks OTA for
every installed user** (they'd need a manual reinstall). Fixed for good:

| Field | Value |
|---|---|
| `productName` | `BotLab` (drives the `userData` path) |
| `appId` | `com.hamiltonalex.botlab` (macOS bundle id / update validation) |
| Apple **Team ID** | the account whose Developer ID signs releases |

The single source of the version number is `package.json` → `version`. It appears nowhere else.

---

## 1. One-time setup

### GitHub repo
- Repo is **public** (so the updater needs no token embedded in the app).
- Enable **2FA** (hardware key) on the account.
- Protect tags matching `v*` (Settings → Tags) so only trusted pushes trigger a release.

### GitHub Actions secrets (Settings → Secrets and variables → Actions)
macOS signing + notarization (Windows needs none yet — §10.3):

| Secret | What it is |
|---|---|
| `CSC_LINK` | Developer ID Application cert exported as `.p12`, then base64-encoded |
| `CSC_KEY_PASSWORD` | the `.p12` export password |
| `APPLE_API_KEY` | App Store Connect API key (`.p8`), base64 or raw per electron-builder |
| `APPLE_API_KEY_ID` | the key's ID |
| `APPLE_API_ISSUER` | the issuer ID |

Produce them once: export the **Developer ID Application** cert from Keychain → `.p12`
(`base64 -i cert.p12 | pbcopy` → `CSC_LINK`); create an **App Store Connect API key**
(App Store Connect → Users and Access → Keys) for notarization without 2FA.

### App icon
`build/icon.png` (1024²) is the source; electron-builder derives `.icns`/`.ico`. Regenerate the
placeholder with `npm run make:icon`, or drop a designed 1024² PNG at that path.

---

## 2. Release runbook

Run from `botLab-desktop/`.

```
0. Discipline gates (enforced by CI, but check locally):
     - every user-facing feature added this release has a Help entry (helpCoverage oracle)
     - if src/engine/** changed, the CHANGELOG impact line is NOT "Влияние: нет"
1. CHANGELOG.md — add the `## [X.Y.Z] — <date>` section:
     - **Влияние:** line (⚠️ торговая логика · 💰 P&L · 🖥 UI · ⚙️ настройки/данные, or "нет")
     - scopes: [App] / [Funding-Arb]; sections: Добавлено / Изменено / Исправлено / Известные проблемы
2. Local gates:
     npm run oracle && npm test
     npm run check:changelog -- vX.Y.Z
3. Tag & push — this is the only trigger:
     npm version X.Y.Z          # bumps package.json AND creates tag vX.Y.Z
     git push && git push --tags
   CI then: check tag == version → check CHANGELOG → run tests → build + sign + notarize →
            attach artifacts to a DRAFT release.
4. On the draft (GitHub → Releases):
     - paste the CHANGELOG.md section for this version into the body
     - confirm all 7 artifacts attached (see §3)
5. Smoke-install the DMG (macOS) and the .exe (Windows) from the draft. Gatekeeper must open the
   signed DMG without right-click → Open; `spctl --assess`, `stapler validate`, `codesign --verify
   --deep --strict` all green.
6. Publish the release (this is the moment users can update).
7. Self-check OTA: on a machine running the PREVIOUS version, the pill shows «Доступна vX.Y.Z» →
   Скачать → Перезапустить → the app returns on the new version, the release page opens once, and
   open positions / the ledger are intact.
8. Announce if needed.
```

**Rollback (something's wrong post-publish):** un-publish the release (set back to draft or delete) —
the updater stops offering it; users already updated stay updated. Then fix forward with a patch tag
(`vX.Y.Z+1`). Never re-tag an existing version.

---

## 3. Release artifacts (7)

| macOS | Windows |
|---|---|
| `BotLab-X.Y.Z-mac-universal.dmg` (install) | `BotLab-Setup-X.Y.Z.exe` (+ `.blockmap`) |
| `BotLab-X.Y.Z-mac-universal.zip` (+ `.blockmap`) — **Squirrel.Mac update source** | `latest.yml` (Windows manifest) |
| `latest-mac.yml` (manifest: versions, files, **sha512**) | |

The updater picks the right manifest by platform automatically (`latest-mac.yml` vs `latest.yml`).

---

## 4. Testing the updater without a release

- **Unit / oracle:** `npm test` (state machine, escaping, changelog logic) and `npm run oracle`
  (`updaterStates` drives all 8 pill states, `helpCoverage` locks Help parity).
- **Dev loop (§17.3):** `FA_UPDATER_DEV=1 npm start` sets `forceDevUpdateConfig` and reads
  `dev-app-update.yml`, exercising the real check/download path against GitHub Releases from an
  unpackaged build (installation itself still requires a packaged app).
- **E2E:** use a throwaway public **staging repo** with `0.0.x` junk releases for the full
  install → update → restart cycle before touching the production repo.

---

## 5. Migrating testers from 0.1.0

The pre-BotLab build (`Funding-Arb Paper Simulator` v0.1.0) has no updater and a different `appId`,
so it is a **separate app to the OS**. The 0.1.0 → 0.2.0 hop is a one-time **manual** move:

1. Install BotLab 0.2.0 (DMG / exe from the release).
2. Launch it — on first run it **copies** the old profile (positions, ledger, settings) into BotLab's
   `userData`; the old directory is left untouched as a rollback safety net.
3. Delete the old app once BotLab shows your positions.

Everything after 0.2.0 updates over the air. Put a short version of this in the v0.2.0 release notes.
