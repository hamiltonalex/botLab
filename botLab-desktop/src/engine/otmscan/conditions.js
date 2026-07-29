// conditions.js — «OTM-сканер» условия У1-У14 (S1, план §5.2). PURE.
// Каждое условие возвращает строку контракта чеклиста:
//   { key, idx, group: "asset"|"instrument", mode: "gate"|"info"|"off", core,
//     state: "pass"|"fail"|"unknown"|"off", value, threshold, thresholdHi, op, unit,
//     note (русский, живой текст ячейки «Значение»), staleSec, hkey }
// Семантика tri-state (план §5.2): unknown = данных нет или протухли — в строгом режиме
// блокирует сигнал, в UI отличим от fail; off = выключено пресетом или календарём (выходные
// для У6) — из агрегата исключено. Деградация данных даёт unknown и видимую причину, никогда
// молчаливый fail или фантомный pass (закон §7).
//
// Все пороги приходят из preset — в этом файле НЕТ ни одного числа-порога (урок аудита письма
// Дмитрия). Гистерезис: hystPct (% ВЕЛИЧИНЫ порога) — условие, ставшее pass, теряет pass,
// только когда значение уходит за порог более чем на hyst в обратную сторону (план §5.4);
// направление fail к pass переключается на самом пороге, без липкости.

const fin = (x) => Number.isFinite(x);
const posNum = (x) => fin(x) && x > 0;

// Русские числа для note-текстов: fmt(30.94) даёт "30.9", fmtSign(+2.9) даёт "+2.9".
const fmt = (x, d = 1) => (fin(x) ? x.toFixed(d) : "н/д");
const fmtSign = (x, d = 1) => (fin(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "н/д");
const sideWord = (side) => (side === "call" ? "CALL" : side === "put" ? "PUT" : "н/д");

// Порядок, группы, ядро и короткие имена строк (ui-spec §9) — единый реестр для агрегата,
// телеметрии и UI. Ядро score-режима: У1 + У10 + У14 (план §5.4, А5 ратифицирован).
export const CONDITION_META = Object.freeze([
  { key: "rv7d_gt_iv", idx: "У1", group: "asset", core: true, label: "RV7d выше IV" },
  { key: "iv_discount", idx: "У2", group: "asset", core: false, label: "запас недооценки IV" },
  { key: "rv3d_gt_iv", idx: "У3", group: "asset", core: false, label: "RV3d выше IV · доп." },
  { key: "sigma_impulse", idx: "У4", group: "asset", core: false, label: "σ-импульс 24ч · сторона" },
  { key: "ema_trend", idx: "У5", group: "asset", core: false, label: "тренд EMA20 · совпадение" },
  { key: "forward_iv", idx: "У6", group: "asset", core: false, label: "forward-IV · дисконт" },
  { key: "skew", idx: "У7", group: "asset", core: false, label: "skew · подтверждение стороны" },
  { key: "book_imbalance", idx: "У8", group: "asset", core: false, label: "дисбаланс стакана" },
  { key: "strike_sigma", idx: "У9", group: "instrument", core: false, label: "страйк в σ-окне" },
  { key: "premium_cap", idx: "У10", group: "instrument", core: true, label: "премия ≤ лимита" },
  { key: "spread_cap", idx: "У11", group: "instrument", core: false, label: "спред ≤ лимита" },
  { key: "depth_min", idx: "У12", group: "instrument", core: false, label: "глубина книги" },
  { key: "theta_cap", idx: "У13", group: "instrument", core: false, label: "тета ≤ лимита" },
  { key: "cost_gate", idx: "У14", group: "instrument", core: true, label: "издержки ≤ лимита" },
]);
const META = Object.fromEntries(CONDITION_META.map((m) => [m.key, m]));

// Фабрика строки: заполняет реестровые поля и дефолты, остальное — из args.
function row(key, args) {
  const m = META[key];
  return {
    key,
    idx: m.idx,
    group: m.group,
    core: m.core,
    mode: "gate",
    state: "unknown",
    value: null,
    threshold: null,
    thresholdHi: null,
    op: null,
    unit: null,
    note: "",
    staleSec: null,
    hkey: key,
    ...args,
  };
}

const off = (key, note, extra) => row(key, { mode: "off", state: "off", note, ...extra });
const unknown = (key, note, extra) => row(key, { state: "unknown", note, ...extra });

// ── Группа «актив» (У1-У8). ctx:
//   preset; side ("call"|"put"|null — направление У4);
//   bundle — computeRvBundle() из rv.js (rv7dPct, rv3dPct, sigma1dPct, dP24hPct, impulse,
//            direction, ema, emaPeriod, lastClose);
//   ivRefPct/ivRefSource — ATM-IV кандидатной экспирации ("atm") или DVOL-фолбэк ("dvol");
//   farIvPct — IV_ref дальней экспирации (≥ fivFarMinDays); baselineIvPct — среднее DVOL 90д;
//   wings — { putIvPct, callIvPct } на страйках около ±1σ;
//   book — { bidDepthUsd, askDepthUsd } книги лучшего кандидата (для У8);
//   ages — { candlesSec, ivRefSec, farIvSec, dvolSec, wingsSec, bookSec } возраст источников;
//   stale — { candles, ivRef, farIv, dvol, wings, book } булевы «протухло» (Stage A);
//   weekend — суббота/воскресенье UTC (вычислено вызывающим из nowMs).
export function evaluateAssetConditions(ctx) {
  const { preset, side, bundle = {}, ages = {}, stale = {} } = ctx;
  const rows = [];
  const ivNote = ctx.ivRefSource === "dvol" ? " · IV по DVOL" : "";

  // Общие причины unknown для RV-против-IV семейства (У1/У2/У3).
  const rvIvUnknown = (key, rvVal, rvName) => {
    if (stale.candles) return unknown(key, `свечи протухли (${fmt(ages.candlesSec, 0)}с)`, { staleSec: ages.candlesSec });
    if (!fin(rvVal)) return unknown(key, `${rvName} не готова (мало закрытых баров)`, { staleSec: ages.candlesSec });
    if (stale.ivRef) return unknown(key, `IV_ref протух (${fmt(ages.ivRefSec, 0)}с)`, { staleSec: ages.ivRefSec });
    if (!fin(ctx.ivRefPct)) return unknown(key, "IV_ref недоступен (нет ATM-пары и DVOL)", { staleSec: ages.ivRefSec });
    return null;
  };
  const rvIvAge = Math.max(ages.candlesSec ?? 0, ages.ivRefSec ?? 0) || (ages.candlesSec ?? ages.ivRefSec ?? null);

  // У1 rv7d_gt_iv (ядро): RV7d > IV_ref. value = спред RV−IV в п.п., порог 0.
  {
    const bad = rvIvUnknown("rv7d_gt_iv", bundle.rv7dPct, "RV7d");
    rows.push(
      bad ??
        row("rv7d_gt_iv", {
          value: bundle.rv7dPct - ctx.ivRefPct,
          threshold: 0,
          op: ">",
          unit: "pts",
          state: bundle.rv7dPct > ctx.ivRefPct ? "pass" : "fail",
          note: `RV ${fmt(bundle.rv7dPct)}% · IV ${fmt(ctx.ivRefPct)}%${ivNote}`,
          staleSec: rvIvAge,
        }),
    );
  }

  // У2 iv_discount: режим rvMargin (IV ≤ RV7d − dIvPts, т.е. RV−IV ≥ dIvPts), режим
  // baselineRatio (IV ≤ k·baselineIV, т.е. IV/baseline ≤ k) или both (оба обязаны пройти).
  {
    const mode = preset.ivFilterMode;
    const wantMargin = mode === "rvMargin" || mode === "both";
    const wantRatio = mode === "baselineRatio" || mode === "both";
    const bad = rvIvUnknown("iv_discount", bundle.rv7dPct, "RV7d");
    if (bad) rows.push(bad);
    else {
      const marginVal = bundle.rv7dPct - ctx.ivRefPct;
      const marginOk = wantMargin ? marginVal >= preset.dIvPts : null;
      let ratioVal = null;
      let ratioOk = null;
      let ratioUnknown = false;
      if (wantRatio) {
        if (stale.dvol || !posNum(ctx.baselineIvPct)) ratioUnknown = true;
        else {
          ratioVal = ctx.ivRefPct / ctx.baselineIvPct;
          ratioOk = ratioVal <= preset.kBaseline;
        }
      }
      const noteParts = [];
      if (wantMargin) noteParts.push(`RV−IV ${fmtSign(marginVal)} п.п.`);
      if (wantRatio) noteParts.push(ratioUnknown ? "база DVOL н/д" : `IV ${fmt(ratioVal, 2)}× базовой`);
      // Семантика both: fail любого суб-режима решает; unknown блокирует только если без него
      // не набирается вердикт (fail важнее unknown — он окончателен на живых данных).
      let state;
      if ((marginOk === false && wantMargin) || (ratioOk === false && !ratioUnknown && wantRatio)) state = "fail";
      else if (ratioUnknown && wantRatio) state = "unknown";
      else state = "pass";
      // Гистерезис ведём по первичной числовой паре режима: rvMargin в приоритете.
      rows.push(
        row("iv_discount", {
          value: wantMargin ? marginVal : ratioVal,
          threshold: wantMargin ? preset.dIvPts : preset.kBaseline,
          op: wantMargin ? ">=" : "<=",
          unit: wantMargin ? "pts" : "ratio",
          state,
          note: noteParts.join(" · ") + (ratioUnknown && state === "unknown" ? " · DVOL недоступен" : ""),
          staleSec: rvIvAge,
        }),
      );
    }
  }

  // У3 rv3d_gt_iv: подтверждение коротким RV (сам Дмитрий предложил). Выключаемо пресетом.
  {
    if (!preset.rv3dConfirm) rows.push(off("rv3d_gt_iv", "выключено пресетом"));
    else {
      const bad = rvIvUnknown("rv3d_gt_iv", bundle.rv3dPct, "RV3d");
      rows.push(
        bad ??
          row("rv3d_gt_iv", {
            value: bundle.rv3dPct - ctx.ivRefPct,
            threshold: 0,
            op: ">",
            unit: "pts",
            state: bundle.rv3dPct > ctx.ivRefPct ? "pass" : "fail",
            note: `RV3d ${fmt(bundle.rv3dPct)}% · IV ${fmt(ctx.ivRefPct)}%${ivNote}`,
            staleSec: rvIvAge,
          }),
      );
    }
  }

  // У4 sigma_impulse: |ΔP24h|/σ1d ≥ impulseMin; задаёт сторону сигнала (рост CALL, падение PUT).
  {
    if (stale.candles) rows.push(unknown("sigma_impulse", `свечи протухли (${fmt(ages.candlesSec, 0)}с)`, { staleSec: ages.candlesSec }));
    else if (!fin(bundle.impulse))
      rows.push(unknown("sigma_impulse", "импульс не готов (мало свечей или σ1d нулевая)", { staleSec: ages.candlesSec }));
    else
      rows.push(
        row("sigma_impulse", {
          value: bundle.impulse,
          threshold: preset.impulseMin,
          op: ">=",
          unit: "sigma",
          state: bundle.impulse >= preset.impulseMin ? "pass" : "fail",
          note: `${fmtSign(bundle.dP24hPct)}% за 24ч · ${fmt(bundle.impulse, 2)}σ · ${sideWord(bundle.direction)}`,
          staleSec: ages.candlesSec,
        }),
      );
  }

  // У5 ema_trend: тренд совпадает со стороной (CALL: цена выше EMA, PUT: ниже). Булево — без
  // числового гистерезиса; дребезг гасится dwell-механикой сигнала.
  {
    if (!preset.trendOn) rows.push(off("ema_trend", "фильтр тренда выключен пресетом"));
    else if (stale.candles) rows.push(unknown("ema_trend", `свечи протухли (${fmt(ages.candlesSec, 0)}с)`, { staleSec: ages.candlesSec }));
    else if (!fin(bundle.ema)) rows.push(unknown("ema_trend", `EMA${bundle.emaPeriod ?? 20} не готова (мало баров)`, { staleSec: ages.candlesSec }));
    else if (!side) rows.push(unknown("ema_trend", "сторона не определена (импульс У4 н/д или нулевой)", { staleSec: ages.candlesSec }));
    else {
      const above = bundle.lastClose > bundle.ema;
      const match = side === "call" ? above : bundle.lastClose < bundle.ema;
      rows.push(
        row("ema_trend", {
          value: fin(bundle.lastClose) && posNum(bundle.ema) ? (bundle.lastClose / bundle.ema - 1) * 100 : null,
          op: "match",
          unit: "pct",
          state: match ? "pass" : "fail",
          note: `цена ${above ? "выше" : "ниже"} EMA${bundle.emaPeriod ?? 20} · ${match ? "совпадает" : `против стороны ${sideWord(side)}`}`,
          staleSec: ages.candlesSec,
        }),
      );
    }
  }

  // У6 forward_iv: бэквордация терм-структуры FIV = IV(near) − IV(far) ≥ fivMinPts.
  // В выходные UTC (fivWeekendOff) условие ВЫКЛЮЧЕНО календарём — state off, не fail (§5.2).
  {
    if (preset.fivWeekendOff && ctx.weekend) rows.push(off("forward_iv", "выходные · forward-IV не считается"));
    else if (stale.ivRef || stale.farIv)
      rows.push(unknown("forward_iv", `IV терм-структуры протухла (${fmt(Math.max(ages.ivRefSec ?? 0, ages.farIvSec ?? 0), 0)}с)`, { staleSec: Math.max(ages.ivRefSec ?? 0, ages.farIvSec ?? 0) }));
    else if (!fin(ctx.ivRefPct) || !fin(ctx.farIvPct))
      rows.push(unknown("forward_iv", !fin(ctx.farIvPct) ? `far-IV нет (экспирация ≥ ${preset.fivFarMinDays}д не котируется)` : "IV_ref недоступен", { staleSec: ages.farIvSec }));
    else {
      const fiv = ctx.ivRefPct - ctx.farIvPct;
      rows.push(
        row("forward_iv", {
          value: fiv,
          threshold: preset.fivMinPts,
          op: ">=",
          unit: "pts",
          state: fiv >= preset.fivMinPts ? "pass" : "fail",
          note: `fwd-IV ${fmt(ctx.farIvPct)}% · спот ${fmt(ctx.ivRefPct)}% · FIV ${fmtSign(fiv)} п.п.`,
          staleSec: Math.max(ages.ivRefSec ?? 0, ages.farIvSec ?? 0),
        }),
      );
    }
  }

  // У7 skew: прокси 25Δ RR — пут(−1σ) минус колл(+1σ) (вопрос Д4). Режим info по умолчанию:
  // вердикт считается честно, но в агрегат и счёт не входит (спорная логика, аудит).
  {
    const mode = preset.skewMode === "off" ? "off" : preset.skewMode === "gate" ? "gate" : "info";
    if (mode === "off") rows.push(off("skew", "выключено пресетом"));
    else if (stale.wings)
      rows.push(unknown("skew", `крылья протухли (${fmt(ages.wingsSec, 0)}с)`, { mode, staleSec: ages.wingsSec }));
    else if (!fin(ctx.wings?.putIvPct) || !fin(ctx.wings?.callIvPct))
      rows.push(unknown("skew", "крылья ±1σ не котируются", { mode, staleSec: ages.wingsSec }));
    else if (!side) rows.push(unknown("skew", "сторона не определена (У4 н/д)", { mode, staleSec: ages.wingsSec }));
    else {
      const skew = ctx.wings.putIvPct - ctx.wings.callIvPct;
      // CALL: улыбка перекошена к коллам (skew ≤ −порог); PUT: к путам (skew ≥ +порог).
      const passCall = skew <= -preset.skewMinPts;
      const passPut = skew >= preset.skewMinPts;
      rows.push(
        row("skew", {
          mode,
          value: skew,
          threshold: side === "call" ? -preset.skewMinPts : preset.skewMinPts,
          op: side === "call" ? "<=" : ">=",
          unit: "pts",
          state: (side === "call" ? passCall : passPut) ? "pass" : "fail",
          note: `skew ±1σ ${fmtSign(skew)} п.п. · ${skew >= 0 ? "путы дороже" : "коллы дороже"}`,
          staleSec: ages.wingsSec,
        }),
      );
    }
  }

  // У8 book_imbalance: bid/ask-глубина книги лучшего кандидата ≥ imbalanceMin. По умолчанию OFF
  // до ратификации определения (вопрос Д5); подтверждение сделками — S6.
  {
    if (preset.imbalanceMode === "off" || !preset.imbalanceMode) rows.push(off("book_imbalance", "выключено · определение не ратифицировано (Д5)"));
    else if (stale.book) rows.push(unknown("book_imbalance", `книга протухла (${fmt(ages.bookSec, 0)}с)`, { staleSec: ages.bookSec }));
    else if (!posNum(ctx.book?.bidDepthUsd) || !posNum(ctx.book?.askDepthUsd))
      rows.push(unknown("book_imbalance", "книга не запрошена или пуста", { staleSec: ages.bookSec }));
    else {
      const ratio = ctx.book.bidDepthUsd / ctx.book.askDepthUsd;
      rows.push(
        row("book_imbalance", {
          value: ratio,
          threshold: preset.imbalanceMin,
          op: ">=",
          unit: "ratio",
          state: ratio >= preset.imbalanceMin ? "pass" : "fail",
          note: `bid/ask глубина ${fmt(ratio, 2)}×`,
          staleSec: ages.bookSec,
        }),
      );
    }
  }

  return rows;
}

// ── Группа «инструмент» (У9-У14) по ОДНОМУ кандидату. inst:
//   { instrument, strike, expiryMs, optionType, sigmaDist, markUsd, bidUsd, askUsd, markIvPct,
//     thetaUsd, tickerAgeSec, tickerStale, bidDepthUsd, askDepthUsd, bookAgeSec, bookStale,
//     costs (economics.computeTradeCosts | null), positionPremUsd (для У12 xPremium) }
// ctx: { preset, spotUsd, anomaly }. hkey строк — `${key}|${instrument}`: смена лучшего
// кандидата естественно сбрасывает их гистерезис-память.
export function evaluateInstrumentConditions(inst, ctx) {
  const { preset, anomaly } = ctx;
  const rows = [];
  const hk = (key) => `${key}|${inst?.instrument ?? "none"}`;

  if (!inst) {
    // Нет кандидатов в окне (случай 6 §7): состояние, не ошибка — весь блок unknown.
    for (const m of CONDITION_META.filter((m) => m.group === "instrument")) {
      rows.push(unknown(m.key, "нет кандидатов в σ-окне и окне экспираций", { hkey: m.key }));
    }
    return rows;
  }
  const tAge = inst.tickerAgeSec ?? null;
  const tickerBad = (key) =>
    inst.tickerStale
      ? unknown(key, `тикер протух (${fmt(tAge, 0)}с)`, { staleSec: tAge, hkey: hk(key) })
      : null;

  // У9 strike_sigma: σ-дистанция в окне пресета. От S зависит — аномалия перп/индекс даёт unknown.
  {
    if (anomaly) rows.push(unknown("strike_sigma", "аномалия цены: перп и индекс разошлись более 0.5%", { hkey: hk("strike_sigma") }));
    else if (!fin(inst.sigmaDist)) rows.push(unknown("strike_sigma", "σ-дистанция не вычислена (нет IV_ref экспирации)", { hkey: hk("strike_sigma"), staleSec: tAge }));
    else
      rows.push(
        row("strike_sigma", {
          value: inst.sigmaDist,
          threshold: preset.sigmaMin,
          thresholdHi: preset.sigmaMax,
          op: "between",
          unit: "sigma",
          state: inst.sigmaDist >= preset.sigmaMin && inst.sigmaDist <= preset.sigmaMax ? "pass" : "fail",
          note: `${fmt(inst.sigmaDist, 2)}σ`,
          staleSec: tAge,
          hkey: hk("strike_sigma"),
        }),
      );
  }

  // У10 premium_cap (ядро): mark/S ≤ premMaxPct.
  {
    const bad = tickerBad("premium_cap");
    if (bad) rows.push(bad);
    else if (anomaly) rows.push(unknown("premium_cap", "аномалия цены: перп и индекс разошлись более 0.5%", { hkey: hk("premium_cap") }));
    else if (!posNum(inst.markUsd) || !posNum(ctx.spotUsd))
      rows.push(unknown("premium_cap", "нет mark-цены кандидата", { staleSec: tAge, hkey: hk("premium_cap") }));
    else {
      const premPct = (inst.markUsd / ctx.spotUsd) * 100;
      rows.push(
        row("premium_cap", {
          value: premPct,
          threshold: preset.premMaxPct,
          op: "<=",
          unit: "pctSpot",
          state: premPct <= preset.premMaxPct ? "pass" : "fail",
          note: `премия ${fmt(premPct, 2)}% спота`,
          staleSec: tAge,
          hkey: hk("premium_cap"),
        }),
      );
    }
  }

  // У11 spread_cap: (ask − bid)/mark ≤ spreadMaxPctPrem.
  {
    const bad = tickerBad("spread_cap");
    if (bad) rows.push(bad);
    else if (!fin(inst.bidUsd) || !fin(inst.askUsd) || !posNum(inst.markUsd) || inst.askUsd < inst.bidUsd)
      rows.push(unknown("spread_cap", "нет bid/ask кандидата", { staleSec: tAge, hkey: hk("spread_cap") }));
    else {
      const spreadPct = ((inst.askUsd - inst.bidUsd) / inst.markUsd) * 100;
      rows.push(
        row("spread_cap", {
          value: spreadPct,
          threshold: preset.spreadMaxPctPrem,
          op: "<=",
          unit: "pctPrem",
          state: spreadPct <= preset.spreadMaxPctPrem ? "pass" : "fail",
          note: `спред ${fmt(spreadPct, 1)}% премии`,
          staleSec: tAge,
          hkey: hk("spread_cap"),
        }),
      );
    }
  }

  // У12 depth_min: min(bid, ask) глубина в USD ≥ порога. Режим usd — абсолютный floor
  // (не откалиброван до S3b); режим xPremium (v2.0) — кратно премии позиции.
  {
    if (inst.bookStale) rows.push(unknown("depth_min", `книга протухла (${fmt(inst.bookAgeSec, 0)}с)`, { staleSec: inst.bookAgeSec, hkey: hk("depth_min") }));
    else if (!fin(inst.bidDepthUsd) || !fin(inst.askDepthUsd))
      rows.push(unknown("depth_min", "книга не запрошена", { staleSec: inst.bookAgeSec, hkey: hk("depth_min") }));
    else {
      const depth = Math.min(inst.bidDepthUsd, inst.askDepthUsd);
      const xMode = preset.depthMode === "xPremium";
      if (xMode && !posNum(inst.positionPremUsd)) {
        rows.push(unknown("depth_min", "премия позиции не вычислена (нет размера)", { staleSec: inst.bookAgeSec, hkey: hk("depth_min") }));
      } else {
        const threshold = xMode ? preset.depthXPrem * inst.positionPremUsd : preset.depthMinUsd;
        rows.push(
          row("depth_min", {
            value: depth,
            threshold,
            op: ">=",
            unit: "usd",
            state: depth >= threshold ? "pass" : "fail",
            note: xMode
              ? `$${fmt(depth / 1000, 1)}k · нужно ≥ ${fmt(preset.depthXPrem, 1)}× премии позиции ($${fmt(threshold, 0)})`
              : `$${fmt(depth / 1000, 1)}k у котировок`,
            staleSec: inst.bookAgeSec,
            hkey: hk("depth_min"),
          }),
        );
      }
    }
  }

  // У13 theta_cap: |theta|/mark ≤ thetaMaxPctDay (тета линейных опционов — USD в сутки).
  {
    const bad = tickerBad("theta_cap");
    if (bad) rows.push(bad);
    else if (!fin(inst.thetaUsd) || !posNum(inst.markUsd))
      rows.push(unknown("theta_cap", "нет theta в тикере", { staleSec: tAge, hkey: hk("theta_cap") }));
    else {
      const thetaPct = (Math.abs(inst.thetaUsd) / inst.markUsd) * 100;
      rows.push(
        row("theta_cap", {
          value: thetaPct,
          threshold: preset.thetaMaxPctDay,
          op: "<=",
          unit: "pctDay",
          state: thetaPct <= preset.thetaMaxPctDay ? "pass" : "fail",
          note: `тета ${fmt(thetaPct, 1)}%/сут`,
          staleSec: tAge,
          hkey: hk("theta_cap"),
        }),
      );
    }
  }

  // У14 cost_gate (ядро, А5): round-trip издержки ≤ costMaxPctPrem. Числа — из economics.js
  // (комиссия 0.0003 индекса с кэпом 12.5% премии, спред по execModel); только факты.
  {
    const c = inst.costs;
    if (!c) rows.push(unknown("cost_gate", "нет bid/ask или тарифов для расчёта издержек", { staleSec: tAge, hkey: hk("cost_gate") }));
    else
      rows.push(
        row("cost_gate", {
          value: c.roundTripCostPct,
          threshold: preset.costMaxPctPrem,
          op: "<=",
          unit: "pctPrem",
          state: c.roundTripCostPct <= preset.costMaxPctPrem ? "pass" : "fail",
          note: `издержки ${fmt(c.roundTripCostPct, 1)}% премии (комиссии ${fmt(c.feeEntryPct + c.feeExitPct, 1)} + спред ${fmt(c.spreadEntryPct + c.spreadExitPct, 1)})${c.feeCapped ? " · кэп 12.5%" : ""}`,
          staleSec: tAge,
          hkey: hk("cost_gate"),
        }),
      );
  }

  return rows;
}

// ── Гистерезис (план §5.4). memory: { [hkey]: state } с прошлого тика. Липкость только в
// сторону удержания pass: rawState fail при прошлом pass остаётся pass, пока значение не ушло
// за порог больше чем на hystPct% ВЕЛИЧИНЫ порога. unknown липкости не имеет (честность данных
// важнее сглаживания), fail к pass переключается на самом пороге.
export function applyHysteresis(rows, memory, hystPct) {
  const nextMemory = {};
  const out = rows.map((r) => {
    let eff = r;
    if (r.state === "fail" && memory?.[r.hkey] === "pass" && fin(r.value) && fin(r.threshold) && fin(hystPct) && hystPct > 0) {
      let within = false;
      if (r.op === "between" && fin(r.thresholdHi)) {
        const hLo = (hystPct / 100) * Math.abs(r.threshold);
        const hHi = (hystPct / 100) * Math.abs(r.thresholdHi);
        within = r.value >= r.threshold - hLo && r.value <= r.thresholdHi + hHi;
      } else if (r.op === ">" || r.op === ">=") {
        within = r.value >= r.threshold - (hystPct / 100) * Math.abs(r.threshold);
      } else if (r.op === "<=") {
        within = r.value <= r.threshold + (hystPct / 100) * Math.abs(r.threshold);
      }
      if (within) eff = { ...r, state: "pass", note: `${r.note} · гистерезис` };
    }
    if (eff.state === "pass" || eff.state === "fail") nextMemory[eff.hkey] = eff.state;
    return eff;
  });
  return { rows: out, memory: nextMemory };
}
