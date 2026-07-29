// scn-boot.js - «OTM-сканер» гигиена восстановленного состояния на буте (А6, находка A4/F2). PURE.
// Слой main ПОВЕРХ движка (прецедент scn-stats.js): сам PURE-движок не тронут - его контракт
// заморожен идущей обкаткой S3b.
//
// Проблема: dwell и гистерезис - счётчики НЕПРЕРЫВНОСТИ («N подряд тиков»; «последний известный
// pass/fail»), а рестарт непрерывность рвёт. Персист восстанавливал их как ни в чём не бывало:
// FORMING с dwellCount=2 недельной давности дозревал бы одним свежим тиком, а протухшая pass-память
// гистерезиса смягчала бы первый свежий fail до pass. Mid-session разрывы при этом честны
// (unknown-тик сбрасывает dwell в scan-engine и вычищает память гистерезиса - в nextMemory пишутся
// только pass/fail), дыра существовала ТОЛЬКО через рестарт.
//
// Правило: континуальные счётчики сбрасываются, абсолютные метки времени остаются.
//   - phase forming -> idle (dwellCount/dwellKey в ноль): сигнал зреет только на непрерывных тиках;
//   - hyst -> {}: память гистерезиса не переживает разрыв (ровно как не переживает unknown-тик);
//   - ACTIVE/signal НЕ трогаем: его ревалидирует первый тик (TTL / instrument-gone / expiry-rolled,
//     §7 случай 14 - механика есть и покрыта otmscan-lifecycle.test.js);
//   - failCount НЕ трогаем: он только УСКОРЯЕТ инвалидацию ACTIVE (консервативное направление);
//   - cooldowns НЕ трогаем: untilTs абсолютен и корректен через разрыв любой длины.

// sanitizeRestoredScanState(persisted) -> { state, notes[] }. Вход не мутируется; state - всегда
// новый объект (пустые notes = сбрасывать было нечего). Вызывается ТОЛЬКО для восстановленного
// с диска состояния - свежесозданное createScanState() и так idle/пустое.
export function sanitizeRestoredScanState(st) {
  if (!st || typeof st !== "object") return { state: st, notes: [] };
  const notes = [];
  const out = { ...st };
  if (out.phase === "forming" || (out.dwellCount ?? 0) !== 0 || out.dwellKey != null) {
    notes.push(
      `dwell сброшен (был ${out.phase}/${out.dwellCount ?? 0}${out.dwellKey ? ` @ ${out.dwellKey}` : ""}): непрерывность тиков прервана рестартом`,
    );
    if (out.phase === "forming") out.phase = "idle";
    out.dwellCount = 0;
    out.dwellKey = null;
  }
  if (out.hyst && typeof out.hyst === "object" && Object.keys(out.hyst).length) {
    notes.push(`память гистерезиса очищена (${Object.keys(out.hyst).length} ключей): разрыв рестарта`);
    out.hyst = {};
  }
  return { state: out, notes };
}
