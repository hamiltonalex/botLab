import {q,MAP,all} from "./truth-v-lib.mjs";
for(const t of ["BTC","BOME","ORDI"]){ const a=MAP.get(t).market, rows=all.get(t);
  const t0=rows[0].tsHour, t1=rows[rows.length-1].tsHour+3600; let cur=t0, got=new Map();
  while(cur<t1){ const d=await q(`{ fundingBalanceOiSnapshots(limit:1000, orderBy: snapshotTimestamp_ASC, where:{marketAddress_eq:"${a}", snapshotTimestamp_gte:${cur}, snapshotTimestamp_lt:${t1}}){ snapshotTimestamp longOpenInterestInTokens shortOpenInterestInTokens } }`);
    const s=d.fundingBalanceOiSnapshots; if(!s.length)break;
    for(const x of s) got.set(x.snapshotTimestamp,[Number(x.longOpenInterestInTokens),Number(x.shortOpenInterestInTokens)]);
    cur=s[s.length-1].snapshotTimestamp+1; if(s.length<1000)break; }
  const test=(sh)=>{ let ok=0,n=0;
    for(const r of rows){ const o=got.get(r.tsHour+sh); if(!o)continue; const [L,S]=o; if(!(L>0&&S>0))continue;
      const A=Math.abs(r.f_long)*L,B=Math.abs(r.f_short)*S; if(!(A>0&&B>0))continue; n++;
      if(Math.abs(A-B)/Math.max(A,B)<1e-4) ok++; } return `${(100*ok/n).toFixed(2)}%`; };
  const best=(()=>{ let ok=0,n=0;
    for(const r of rows){ let good=false,any=false;
      for(const sh of [-3600,0,3600]){ const o=got.get(r.tsHour+sh); if(!o)continue; const [L,S]=o; if(!(L>0&&S>0))continue;
        const A=Math.abs(r.f_long)*L,B=Math.abs(r.f_short)*S; if(!(A>0&&B>0))continue; any=true;
        if(Math.abs(A-B)/Math.max(A,B)<1e-4) good=true; }
      if(any){n++; if(good)ok++;} } return `${(100*ok/n).toFixed(2)}%`; })();
  console.log(`${t}: сдвиг -1ч ${test(-3600)}, 0 ${test(0)}, +1ч ${test(3600)}, ЛЮБОЙ из трёх ${best}`);
  // где ломается: доля точных среди часов, где ставка стояла, и где сменилась
  let a1=[0,0],a2=[0,0];
  for(let i=1;i<rows.length;i++){ const r=rows[i], o=got.get(r.tsHour); if(!o)continue; const [L,S]=o; if(!(L>0&&S>0))continue;
    const A=Math.abs(r.f_long)*L,B=Math.abs(r.f_short)*S; if(!(A>0&&B>0))continue;
    const ch=r.f_long!==rows[i-1].f_long||r.f_short!==rows[i-1].f_short;
    const g=Math.abs(A-B)/Math.max(A,B)<1e-4; (ch?a1:a2)[0]+=g?1:0; (ch?a1:a2)[1]++; }
  console.log(`   среди часов со СМЕНОЙ ставки точных ${(100*a1[0]/a1[1]).toFixed(1)}% (${a1[1]}ч); среди СТОЯВШИХ ${(100*a2[0]/a2[1]).toFixed(1)}% (${a2[1]}ч)`);
}
