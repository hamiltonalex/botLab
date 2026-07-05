// xlsx-writer.test.js — the hand-rolled OOXML writer is the riskiest new code (binary format
// written by hand), so it gets structural round-trip coverage: CRC32 against the canonical test
// vector, ZIP local/central/EOCD layout re-parsed byte-for-byte, and the sheet XML content.

import test from "node:test";
import assert from "node:assert/strict";
import { crc32, buildXlsxBuffer, buildZipStore, colLetter } from "../src/main/xlsx-writer.js";
import { toLedgerCsv, toLedgerSheet, ledgerFileName, LEDGER_COLUMNS } from "../src/main/export.js";
import { openPosition, accrue } from "../src/engine/paper.js";
import { buildLedger } from "../src/engine/ledger.js";

const BASE = 1699999200000;

test("crc32 matches the canonical check vector", () => {
  assert.equal(crc32(Buffer.from("123456789", "ascii")), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test("colLetter covers the two-letter range", () => {
  assert.equal(colLetter(0), "A");
  assert.equal(colLetter(25), "Z");
  assert.equal(colLetter(26), "AA");
  assert.equal(colLetter(28), "AC");
});

// Minimal ZIP reader for STORE archives (test-only): walks local headers, then EOCD/central dir.
function parseStoreZip(buf) {
  const files = [];
  let off = 0;
  while (buf.readUInt32LE(off) === 0x04034b50) {
    const crc = buf.readUInt32LE(off + 14);
    const size = buf.readUInt32LE(off + 18);
    const usize = buf.readUInt32LE(off + 22);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.slice(off + 30, off + 30 + nameLen).toString("ascii");
    const data = buf.slice(off + 30 + nameLen + extraLen, off + 30 + nameLen + extraLen + size);
    files.push({ name, crc, size, usize, data, offset: off });
    off += 30 + nameLen + extraLen + size;
  }
  const eocdOff = buf.length - 22;
  assert.equal(buf.readUInt32LE(eocdOff), 0x06054b50, "EOCD signature at fixed tail (no comment)");
  const count = buf.readUInt16LE(eocdOff + 10);
  const cdSize = buf.readUInt32LE(eocdOff + 12);
  const cdStart = buf.readUInt32LE(eocdOff + 16);
  assert.equal(cdStart, off, "central directory starts right after the last local entry");
  assert.equal(cdStart + cdSize, eocdOff, "central directory is contiguous with EOCD");
  // walk central directory and cross-check against locals
  let c = cdStart;
  const central = [];
  while (buf.readUInt32LE(c) === 0x02014b50) {
    const crc = buf.readUInt32LE(c + 16);
    const nameLen = buf.readUInt16LE(c + 28);
    const relOff = buf.readUInt32LE(c + 42);
    central.push({ name: buf.slice(c + 46, c + 46 + nameLen).toString("ascii"), crc, relOff });
    c += 46 + nameLen;
  }
  assert.equal(central.length, count, "EOCD count matches central entries");
  return { files, central };
}

test("buildZipStore produces a structurally sound STORE zip with correct CRCs", () => {
  const zip = buildZipStore([
    { name: "a.txt", data: Buffer.from("hello", "utf8") },
    { name: "dir/b.txt", data: Buffer.from("world!", "utf8") },
  ]);
  const { files, central } = parseStoreZip(zip);
  assert.deepEqual(files.map((f) => f.name), ["a.txt", "dir/b.txt"]);
  assert.equal(files[0].data.toString(), "hello");
  assert.equal(files[0].crc, crc32(Buffer.from("hello")));
  assert.equal(files[0].size, files[0].usize, "STORE: sizes equal");
  assert.deepEqual(central.map((f) => f.name), ["a.txt", "dir/b.txt"]);
  assert.equal(central[0].crc, files[0].crc);
  assert.equal(central[1].relOff, files[1].offset, "central offsets point at local headers");
});

test("buildXlsxBuffer contains the mandatory OOXML parts and the cell data", () => {
  const buf = buildXlsxBuffer("Ledger", ["name", "usd"], [["фандинг GMX", 3.6], ["borrow <&> \"q\"", -0.72]]);
  const { files } = parseStoreZip(buf);
  const names = files.map((f) => f.name);
  assert.deepEqual(names, [
    "[Content_Types].xml",
    "_rels/.rels",
    "xl/workbook.xml",
    "xl/_rels/workbook.xml.rels",
    "xl/styles.xml",
    "xl/worksheets/sheet1.xml",
  ]);
  const sheet = files[5].data.toString("utf8");
  assert.ok(sheet.includes('<c r="A2" t="inlineStr"><is><t>фандинг GMX</t></is></c>'), "inline string cell");
  assert.ok(sheet.includes('<c r="B2"><v>3.6</v></c>'), "numeric cell");
  assert.ok(sheet.includes("borrow &lt;&amp;&gt; &quot;q&quot;"), "XML escaping");
  assert.ok(sheet.includes('<c r="B3"><v>-0.72</v></c>'), "negative numeric survives");
  const ct = files[0].data.toString("utf8");
  assert.ok(ct.includes("/xl/worksheets/sheet1.xml"), "content types override for the sheet");
  const wb = files[2].data.toString("utf8");
  assert.ok(wb.includes('name="Ledger"'), "sheet name");
});

test("toLedgerCsv: BOM + CRLF + full column pool + quoting; sheet rows keep numbers numeric", () => {
  const p = openPosition({
    strategy: "two", instrumentKey: "ETH", config: "A", capital: 100000, leverage: 1,
    nowMs: BASE, roundTripCost: 4.1,
    costBreakdown: { gmxOpenUsd: 1, gmxCloseUsd: 1, gmxImpactUsd: 1, gmxGasUsd: 1, hlTakerUsd: 0.1 },
  });
  accrue(p, { f_long: -1e-8, f_short: 1e-8, b_long: 0, b_short: 2e-9, hl_rate: 1e-5 }, BASE + 3600 * 1000);
  const events = buildLedger(p);
  const csv = toLedgerCsv(events);
  assert.ok(csv.startsWith("﻿"), "UTF-8 BOM for Excel");
  const lines = csv.slice(1).split("\r\n").filter(Boolean);
  assert.equal(lines.length, 1 + events.length, "header + one line per event");
  assert.equal(lines[0].split(",").length, LEDGER_COLUMNS.length, "full column pool");
  assert.ok(lines[0].startsWith("seq,operation_id,time_utc,type,"), "audit column order");
  assert.ok(lines[1].includes('"разовые издержки входа-выхода · зафиксированы при открытии"') || lines[1].includes("разовые издержки"), "description present");
  // a description containing a comma must be quoted — force one and re-serialize
  events[0].description = 'a,"b"';
  const csv2 = toLedgerCsv(events);
  assert.ok(csv2.includes('"a,""b"""'), "RFC-4180 quoting");

  const { header, rows } = toLedgerSheet(events);
  assert.equal(header.length, LEDGER_COLUMNS.length);
  const seqIdx = header.indexOf("seq");
  const incomeIdx = header.indexOf("income_usd");
  assert.equal(typeof rows[0][seqIdx], "number", "numbers stay numeric for XLSX");
  assert.equal(typeof rows[1][incomeIdx], "number");

  const fn = ledgerFileName(p, "csv", new Date("2026-07-04T15:30:00Z"));
  assert.match(fn, /^fa-ledger_ETH_p\d+_\d+_20260704-1530\.csv$/);
});
