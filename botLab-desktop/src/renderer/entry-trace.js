/* Classic script for Electron and the file:// selector oracle. The engine owns selection,
   ordering, economics and progress. The live path formats snapshots as they arrive, without
   reveal timers. The replay below is user-triggered: it plays back the size checks the engine
   recorded for the same calculation, with pauses added for viewing, and recomputes nothing. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
  const finite = Number.isFinite;
  const setText = (id, value) => { const el=$(id); if(el && el.textContent!==value) el.textContent=value; };
  const renderedHtml = new WeakMap();
  const setHtml = (el, value) => { if(el && renderedHtml.get(el)!==value){ el.innerHTML=value; renderedHtml.set(el,value); } };
  let currentId = null;
  const expanded = new Set();
  let lastArgs = null;

  function newer(a, b) {
    if(!a) return b || null;
    if(!b) return a;
    if(a.id===b.id) return (a.revision || 0) > (b.revision || 0) ? a : b;
    return (a.startedAt || 0) > (b.startedAt || 0) ? a : b;
  }

  function mergeAuto(previous, incoming) {
    if(!incoming) return null;
    if(!previous) return incoming;
    const next = { ...incoming };
    // A request begun before a progress event must not roll that same cycle backwards.
    for(const key of ['entryTrace','latestTrace']){
      if(previous[key] && incoming[key] && previous[key].id===incoming[key].id)
        next[key] = newer(previous[key], incoming[key]);
    }
    // Null is authoritative (re-arm/reset or a legacy position with no entry evidence).
    // Do not replace a pinned entry with a more recent review from another decision.
    return next;
  }

  function receive(auto, trace) {
    if(!auto || !trace || !trace.id || !Array.isArray(trace.candidates)) return auto;
    const known=[auto.entryTrace,auto.latestTrace].filter(x=>x && x.id===trace.id);
    if(known.some(x=>(x.revision || 0)>(trace.revision || 0))) return auto;
    if(!known.length && finite(auto.armedAt) && trace.startedAt<auto.armedAt) return auto;
    const closing=trace.phase==='closed' && (auto.entryTrace?.id===trace.id || auto.positionId===trace.positionId);
    const latest=closing ? trace : newer(auto.latestTrace, trace);
    const pinned=!!auto.positionId || auto.entryTrace?.phase==='opened';
    let entry = auto.entryTrace;
    if(entry && entry.id===trace.id) entry = newer(entry, trace);
    else if(trace.phase==='opened' && latest.id===trace.id) entry=trace;
    else if(!pinned) entry=latest;
    return { ...auto, entryTrace:entry || null, latestTrace:latest };
  }

  function sparkline(points) {
    const valid = points.filter(p => p && finite(p.sizeUsd) && finite(p.net));
    if(valid.length<2) return '';
    const xMin=Math.min(...valid.map(p=>p.sizeUsd)), xMax=Math.max(...valid.map(p=>p.sizeUsd));
    const yMin=Math.min(...valid.map(p=>p.net)), yMax=Math.max(...valid.map(p=>p.net));
    const path=valid.map((p,i) => (i?'L':'M')+(2+(p.sizeUsd-xMin)/(xMax-xMin || 1)*78).toFixed(2)+','+(19-(p.net-yMin)/(yMax-yMin || 1)*17).toFixed(2)).join(' ');
    return '<svg viewBox="0 0 82 21" aria-hidden="true"><path d="'+path+'" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>';
  }

  /* ── ПОВТОР РАСЧЁТА. Живой перебор семи схем длится доли секунды, и таблица появляется целиком.
     Повтор проигрывает ЗАПИСАННЫЕ движком проверки размеров того же расчёта (`samples` кандидатов
     в порядке `order`, оба поля пишет главный процесс из событий движка) с паузами для показа.
     Ничего не считает и не выдумывает: каждый кадр это состояние, которое живой расчёт прошёл.
     Живое обновление показываемой трассы (новая ревизия, новый расчёт) повтор прерывает: живое
     главнее. При prefers-reduced-motion на рынок показывается один кадр, последняя проверка. ── */
  const REPLAY = { marketMs:1300, minStepMs:14, maxStepMs:70, afterMarketMs:420, beforeRankMs:700, emptyMarketMs:450, reducedMs:600 };
  const replay = { traceId:null, revision:null, order:[], m:0, i:0, timer:null };
  const reducedMotion = () => { try{ return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }catch(e){ return false; } };
  const samplesOf = c => (c && Array.isArray(c.samples)) ? c.samples : [];
  const replayOrder = trace => (trace && Array.isArray(trace.candidates) ? trace.candidates : [])
    .filter(c=>finite(c.order)).sort((a,b)=>a.order-b.order).map(c=>c.id);
  const canReplay = trace => !!trace && trace.phase!=='evaluating' && Array.isArray(trace.candidates)
    && trace.candidates.some(c=>finite(c.order) && samplesOf(c).length>0);
  const replayActive = trace => !!replay.traceId && !!trace && trace.id===replay.traceId
    && (trace.revision || 0)===replay.revision && trace.phase!=='evaluating';

  function replaySnapshot(trace) {
    const pos = new Map(replay.order.map((id,k)=>[id,k]));
    const reduced = reducedMotion();
    const candidates = trace.candidates.map(c => {
      const k = pos.get(c.id);
      if(k===undefined) return c;                 // не стартовал и живьём: пропуск направления, ворота
      if(k<replay.m) return { ...c, rank:null }; // посчитан: итог без ранга, ранги приходят в конце
      const blank = { ...c, rank:null, refusal:null, refusalFrom:null, points:[], evaluatedSizes:0,
        sizeUsd:null, netUsd:null, grossUsd:null, costUsd:null, ratio:null, binding:null, testing:null };
      if(k>replay.m || replay.i<0) return { ...blank, status:'pending' };
      const samples = samplesOf(c);
      const idx = reduced ? samples.length-1 : Math.min(replay.i, samples.length-1);
      const s = idx>=0 ? samples[idx] : null;
      return { ...blank, status:'calculating', evaluatedSizes:s ? idx+1 : 0,
        testing:s ? { sizeUsd:s[0], grossUsd:s[1], costUsd:s[2], netUsd:s[3] } : null };
    });
    return { ...trace, candidates, completed:candidates.filter(c=>!['pending','calculating'].includes(c.status)).length,
      activeCandidateId:replay.order[replay.m] || null, selectedCandidateId:null, bestCandidateId:null };
  }
  function stepMs(trace, m) {
    const c = trace.candidates.find(x=>x.id===replay.order[m]);
    const n = samplesOf(c).length;
    if(!n) return REPLAY.emptyMarketMs;
    if(reducedMotion()) return REPLAY.reducedMs;
    return Math.max(REPLAY.minStepMs, Math.min(REPLAY.maxStepMs, REPLAY.marketMs/n));
  }
  function schedule(ms) { replay.timer = setTimeout(replayTick, ms); }
  function replayTick() {
    replay.timer = null;
    const trace = lastArgs && lastArgs.auto ? lastArgs.auto.entryTrace : null;
    if(!replayActive(trace) || replay.m>=replay.order.length){ stopReplay(true); return; }
    const c = trace.candidates.find(x=>x.id===replay.order[replay.m]);
    const n = samplesOf(c).length;
    let ms;
    if(replay.i<0){ replay.i = 0; ms = stepMs(trace, replay.m); }
    else if(!reducedMotion() && replay.i+1<n){ replay.i += 1; ms = stepMs(trace, replay.m); }
    else { replay.m += 1; replay.i = -1; ms = replay.m>=replay.order.length ? REPLAY.beforeRankMs : REPLAY.afterMarketMs; }
    if(lastArgs) render(lastArgs);
    schedule(ms);
  }
  function startReplay(trace) {
    stopReplay(false);
    const order = replayOrder(trace);
    if(!order.length) return;
    replay.traceId = trace.id; replay.revision = trace.revision || 0; replay.order = order; replay.m = 0; replay.i = 0;
    if(lastArgs) render(lastArgs);
    schedule(stepMs(trace, 0));
  }
  function stopReplay(rerender) {
    if(replay.timer){ clearTimeout(replay.timer); replay.timer = null; }
    const was = !!replay.traceId;
    replay.traceId = null; replay.revision = null; replay.order = []; replay.m = 0; replay.i = 0;
    if(rerender && was && lastArgs) render(lastArgs);
  }
  function toggleReplay() {
    if(replay.traceId){ stopReplay(true); return; }
    const trace = lastArgs && lastArgs.auto ? lastArgs.auto.entryTrace : null;
    if(canReplay(trace)) startReplay(trace);
  }

  function render(args) {
    lastArgs = args;
    const {auto:a, positions=[], t, usd:formatUsd, date, code, side, bind} = args;
    const card=$('faEntryCard'); if(!card) return;
    const usd = value => finite(value) ? formatUsd(value) : '-';
    const trace=a && a.entryTrace;
    if(replay.traceId && !replayActive(trace)) stopReplay(false);
    const replaying=!!replay.traceId;
    const v=replaying ? replaySnapshot(trace) : trace;
    const candidates=v && Array.isArray(v.candidates) ? v.candidates : [];
    const gate=a && a.last && a.last.gate;
    const phase=replaying ? 'replay' : trace ? trace.phase : a && a.on ? 'warming' : 'empty';
    const running=phase==='evaluating' || replaying;
    const selected=candidates.find(c=>c.id===v?.selectedCandidateId);
    const rankComplete=!!trace && !running && phase!=='warming';
    const total=v && finite(v.total) ? v.total : 0;
    const completed=v && finite(v.completed) ? v.completed : 0;
    const active=candidates.find(c=>c.id===v?.activeCandidateId);
    card.dataset.phase=phase;
    card.dataset.traceId=trace?.id || '';
    if(currentId!==trace?.id){ expanded.clear(); currentId=trace?.id; }

    const chain = c => c.chain==='avalanche' || c.chain==='avax' || c.chain===43114 ? 'Avalanche'
      : c.chain==='arbitrum' || c.chain==='arb' || c.chain===42161 ? 'Arbitrum' : String(c.chain || '');
    const route = c => 'GMX'+(chain(c)?' · '+chain(c):'')+(c.strategy==='two'?' ↔ Hyperliquid':'');
    const direction = c => c.strategy==='one' ? t('fa.entry.oneDirection',{asset:String(c.token || '').split('-')[0]})
      : t('fa.entry.twoDirection',{gmx:side(c.config==='A'?'short':'long'),hl:side(c.config==='A'?'long':'short')});
    const label = c => String(c.token || '')+(c.config?' · '+c.config:'');
    const statusKeys={ empty:'fa.entry.status.empty', warming:'fa.entry.status.warming', evaluating:'fa.entry.status.evaluating', replay:'fa.entry.status.replay',
      ranked:'fa.entry.status.ranked', opened:'fa.entry.status.opened', closed:'fa.entry.status.closed', blocked:'fa.entry.status.blocked' };
    setText('faEntryStatus',t(statusKeys[phase] || statusKeys.empty));
    setText('faEntrySubtitle',trace ? t('fa.entry.scope',{n:total,h:finite(trace.horizonH)?trace.horizonH:'-',cap:usd(trace.capitalUsd)}) : t('fa.entry.subtitle'));
    const stage = active ? label(active) : replaying && completed>=total ? t('fa.entry.replayRanking') : t('fa.entry.preparing');
    setText('faEntryProgressText',v
      ? running ? t(replaying?'fa.entry.progressReplay':'fa.entry.progressActive',{n:completed,total,market:stage})
        : t('fa.entry.progressDone',{n:completed,total})
      : a && a.on && gate ? t('fa.entry.gateProgress',{n:gate.usable,total:gate.markets}) : t('fa.entry.progressEmpty'));
    setText('faEntryAsOf',trace ? t(replaying?'fa.entry.asOfReplay':'fa.entry.asOf',{at:date(trace.startedAt)}) : '');
    const progress=$('faEntryProgress');
    progress.setAttribute('aria-valuemin','0');
    progress.setAttribute('aria-valuemax',String(total || 1));
    progress.setAttribute('aria-valuenow',String(Math.max(0,Math.min(total,completed))));
    progress.setAttribute('aria-valuetext',$('faEntryProgressText').textContent);
    $('faEntryProgressFill').style.width=(total ? Math.max(0,Math.min(100,completed/total*100)):0)+'%';

    const activeStep = phase==='empty' ? -1 : phase==='closed' ? 4 : phase==='opened' ? 3 : phase==='ranked' ? 2 : running ? 1 : phase==='blocked' && completed>0 ? 2 : 0;
    document.querySelectorAll('#faEntrySteps li').forEach((el,i)=>{
      const st=i<activeStep?'done':i===activeStep?'active':'pending';
      el.dataset.state=st;
      if(st==='active') el.setAttribute('aria-current','step'); else el.removeAttribute('aria-current');
      setHtml(el.querySelector('.fa-entry-step-no'),st==='done'?'✓':String(i+1).padStart(2,'0'));
    });

    const empty=$('faEntryEmpty'); empty.hidden=!!candidates.length;
    $('faEntryTableScroll').hidden=!candidates.length;
    setText('faEntryEmptyTitle',t(a && a.positionId?'fa.entry.emptyLegacyTitle':a && a.on?'fa.entry.emptyWarmingTitle':'fa.entry.emptyTitle'));
    setText('faEntryEmptyText',t(a && a.positionId?'fa.entry.emptyLegacy':a && a.on?'fa.entry.emptyWarming':'fa.entry.empty'));
    const winner=$('faEntryWinner'); winner.hidden=!selected;
    if(selected){
      winner.dataset.state=phase;
      setText('faEntryWinnerTitle',label(selected));
      setText('faEntryWinnerRoute',route(selected)+' · '+direction(selected));
      setText('faEntryWinnerNet',usd(selected.netUsd));
      setText('faEntryWinnerSize',usd(selected.sizeUsd));
      setText('faEntryWinnerNetLabel',t('fa.entry.winnerNet',{h:trace.horizonH ?? '-'}));
      setText('faEntryWinnerEyebrow',t(phase==='closed'?'fa.entry.winnerClosed':'fa.entry.winner'));
      const pos=positions.find(p=>p.id===trace.positionId);
      const isOpen=phase==='opened' || pos?.status==='open';
      setText('faEntryWinnerStatus',phase==='closed' ? t('fa.entry.tradeClosed',{at:date(trace.closedAt)})
        : isOpen ? t('fa.entry.tradeOpened',{at:date(trace.openedAt)}) : t('fa.entry.tradeChosen'));
      const realized=$('faEntryWinnerRealized');
      realized.hidden=phase!=='closed' || !finite(trace.realizedUsd);
      if(!realized.hidden){
        realized.textContent=t('fa.entry.tradeRealized',{usd:usd(trace.realizedUsd)});
        realized.dataset.sign=trace.realizedUsd<0?'negative':'positive';
      } else realized.textContent='';
    } else {
      ['faEntryWinnerTitle','faEntryWinnerRoute','faEntryWinnerNet','faEntryWinnerSize','faEntryWinnerNetLabel',
        'faEntryWinnerEyebrow','faEntryWinnerStatus','faEntryWinnerRealized'].forEach(id=>setText(id,''));
    }

    const rows=candidates.map((candidate,index)=>({candidate,index}));
    if(rankComplete) rows.sort((x,y)=>{
      const xr=finite(x.candidate.rank)?x.candidate.rank:Infinity, yr=finite(y.candidate.rank)?y.candidate.rank:Infinity;
      return xr-yr || x.index-y.index;
    });
    const body=$('faEntryBody');
    const retained = new Set();
    let cursor=body.firstElementChild;
    const place=el=>{ if(el===cursor) cursor=cursor.nextElementSibling; else body.insertBefore(el,cursor); };
    for(const {candidate:c,index} of rows){
      retained.add(String(c.id));
      let row=Array.from(body.children).find(el=>el.dataset.candidateId===String(c.id));
      if(!row){ row=document.createElement('tr'); row.dataset.candidateId=String(c.id); }
      const isSelected=c.id===v.selectedCandidateId;
      row.dataset.status=c.status || 'pending';
      row.dataset.rank=finite(c.rank)?String(c.rank):'';
      row.className=isSelected?'fa-entry-selected':'';
      const points=Array.isArray(c.points)?c.points:[];
      const sizes=finite(c.evaluatedSizes)?c.evaluatedSizes:points.length;
      const waiting=c.status==='pending', calculating=c.status==='calculating', skipped=c.status==='direction_skipped';
      const outcome=isSelected ? t(phase==='closed'?'fa.entry.outcomeClosed':phase==='opened'?'fa.entry.outcomeOpened':'fa.entry.outcomeSelected')
        : waiting ? t('fa.entry.pending') : calculating ? t('fa.entry.calculating') : skipped ? t('fa.entry.directionSkipped')
        : c.refusal ? code(c.refusal) : finite(c.rank) ? t('fa.entry.eligible') : t('fa.entry.calculated');
      const note=calculating && c.testing ? t('fa.entry.testingSize',{usd:usd(c.testing.sizeUsd),n:sizes})
        : skipped ? t(c.directionSource==='snapshot_fallback'?'fa.entry.directionFallback':'fa.entry.directionBasis') : c.refusalFrom==='slice' ? t('fa.entry.notEvaluated')
        : finite(c.rank) && c.rank>1 ? t('fa.entry.lowerRank') : isSelected ? t('fa.entry.highestNet') : '';
      const tone=isSelected?'selected':calculating?'active':c.refusal?'rejected':'';
      const detailId='faEntryDetail-'+index;
      const curve=points.length ? '<button type="button" class="fa-entry-curve-button" data-details="'+esc(c.id)+'" aria-expanded="false" aria-controls="'+detailId+'" aria-label="'+esc(t('fa.entry.curveAria',{market:label(c),n:sizes}))+'">'+sparkline(points)+'<span>'+esc(t('fa.entry.sizes',{n:sizes}))+' <span aria-hidden="true">⌄</span></span></button>'
        : '<span class="fa-entry-number">'+(calculating?esc(t('fa.entry.sizes',{n:sizes})):'-')+'</span>';
      const amounts=calculating && c.testing ? c.testing : c;
      const rank=finite(c.rank)?String(c.rank):calculating?'·':'-';
      setHtml(row,'<td><span class="fa-entry-rank">'+rank+'</span></td>'
        +'<td class="fa-entry-market"><span class="fa-entry-market-title">'+esc(c.token)+' <span class="fa-entry-config">'+esc(c.config || t('fa.entry.one'))+'</span></span>'
        +'<span class="fa-entry-route">'+esc(route(c))+'</span><span class="fa-entry-direction">'+esc(direction(c))+'</span></td>'
        +'<td class="fa-entry-number">'+esc(usd(amounts.sizeUsd))+'</td>'
        +'<td class="fa-entry-number">'+esc(usd(amounts.grossUsd))+'</td>'
        +'<td class="fa-entry-number">'+esc(usd(amounts.costUsd))+'</td>'
        +'<td class="fa-entry-number fa-entry-net" data-sign="'+(finite(amounts.netUsd)?amounts.netUsd>0?'positive':amounts.netUsd<0?'negative':'zero':'unknown')+'">'+esc(usd(amounts.netUsd))+'</td>'
        +'<td>'+curve+'</td><td><span class="fa-entry-outcome" data-tone="'+tone+'">'+esc(outcome)+'</span>'
        +(note?'<span class="fa-entry-outcome-note">'+esc(note)+'</span>':'')+'</td>');
      place(row);
      const curveButton=row.querySelector('[data-details]');
      if(curveButton) curveButton.setAttribute('aria-expanded',String(expanded.has(c.id)));
      let detail=$(detailId);
      if(!detail || detail.parentNode!==body){ detail=document.createElement('tr'); detail.id=detailId; detail.className='fa-entry-detail'; }
      // Строка деталей без узлов (рынок ещё считается, повтор) прячется и очищается: прежнее
      // содержимое от другого состояния той же строки показывать нельзя.
      detail.dataset.detailFor=String(c.id); detail.hidden=!(expanded.has(c.id) && points.length);
      if(points.length){
        setHtml(detail,'<td colspan="8"><div class="fa-entry-detail-content"><div class="fa-entry-detail-head"><span>'+esc(t('fa.entry.curveCaption',{market:label(c),n:sizes,points:points.length}))+'</span><span>'+esc(t('fa.entry.binding',{why:bind(c.binding)}))+'</span></div>'
          +'<div class="fa-entry-points" role="list" aria-label="'+esc(t('fa.entry.pointsAria'))+'">'+points.map(p=>'<span class="fa-entry-point" role="listitem" data-best="'+(finite(p.sizeUsd) && p.sizeUsd===c.sizeUsd)+'"><span>'+esc(usd(p.sizeUsd))+'</span><b>'+esc(usd(p.net))+'</b></span>').join('')+'</div></div></td>');
      } else setHtml(detail,'');
      place(detail);
    }
    Array.from(body.children).forEach(el=>{ if(!retained.has(el.dataset.candidateId || el.dataset.detailFor)) el.remove(); });
    if(!body.dataset.bound){
      body.dataset.bound='true';
      body.addEventListener('click',event=>{
        const button=event.target.closest('[data-details]'); if(!button) return;
        const id=button.dataset.details, detail=$(button.getAttribute('aria-controls'));
        if(expanded.has(id)) expanded.delete(id); else expanded.add(id);
        button.setAttribute('aria-expanded',String(expanded.has(id)));
        if(detail) detail.hidden=!expanded.has(id);
      });
    }
    setText('faEntryFoot',t(replaying?'fa.entry.replayNote':selected?'fa.entry.pinnedNote':running?'fa.entry.liveNote':'fa.entry.methodNote'));
    setText('faEntryDecision',!replaying && trace?.decision?.why ? code(trace.decision.why) : '');
    const btn=$('faEntryReplay');
    if(btn){
      btn.hidden=!(replaying || canReplay(trace));
      setText('faEntryReplay',t(replaying?'fa.entry.replayStop':'fa.entry.replay'));
      const aria=t(replaying?'fa.entry.replayStopAria':'fa.entry.replayAria');
      if(btn.getAttribute('aria-label')!==aria){ btn.setAttribute('aria-label',aria); btn.title=aria; }
      btn.setAttribute('aria-pressed',String(replaying));
      if(!btn.dataset.bound){ btn.dataset.bound='true'; btn.addEventListener('click',toggleReplay); }
    }
    const review=$('faEntryReview'), latest=a && a.latestTrace;
    review.hidden=!(latest && (!trace || latest.id!==trace.id));
    if(!review.hidden){
      const txt=latest.phase==='evaluating' ? t(trace?'fa.entry.reviewActive':'fa.entry.reviewActiveLegacy',{n:latest.completed,total:latest.total})
        : t('fa.entry.reviewDone',{at:date(latest.completedAt || latest.startedAt),why:latest.decision?.why?code(latest.decision.why):t('fa.entry.status.ranked')});
      setText('faEntryReviewText',txt);
    } else setText('faEntryReviewText','');
  }

  window.FaEntryTrace = { render, mergeAuto, receive, toggleReplay, isReplaying: () => !!replay.traceId };
})();
