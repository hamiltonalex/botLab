// А3. Правда ли стратегия систематически встаёт на СОКРАЩАЮЩУЮ перекос ОИ сторону.
// Перекос читается из самого кэша: f_long<0 значит лонги платят, то есть ОИ перегружен ЛОНГОМ.
import { all, H1, YEAR } from "./skept-cap-lib.mjs";
import { run } from "./skept4-model-5-grid.mjs";
import { makeCost } from "./skept4-model-5-lib.mjs";
const W=90,H=30, trainH=W*H1, holdH=H*H1;
const PER=[]; for(let i=trainH;i+24<=YEAR;i+=holdH){const te=Math.min(YEAR,i+holdH); if(te-i<24)break; PER.push([i,te]);}
const dump=[]; run({capital:1000000,cf:makeCost("total"),dump});
let inRed=0,inWid=0,inFlat=0, outRed=0,outWid=0, wRed=0,wWid=0, holdRed=0,holdWid=0,holdN=0;
const rows=[];
for(const p of dump){
  const [i,te]=PER[p.per]; const r=all.get(p.t);
  const fIn=r[i].f_long, fOut=r[te-1].f_long;
  // сторона GMX на входе: A = увеличение ШОРТА, B = увеличение ЛОНГА
  const redIn = p.cfg==="A" ? fIn<0 : fIn>0;      // шорт сокращает перекос, если ОИ перегружен лонгом
  const redOut= p.cfg==="A" ? fOut>0 : fOut<0;    // закрытие идёт в обратную сторону
  if(fIn===0)inFlat++; else if(redIn){inRed++; wRed+=p.size;} else {inWid++; wWid+=p.size;}
  if(fOut!==0){ if(redOut)outRed++; else outWid++; }
  // доля часов удержания, когда наша сторона была недогруженной
  let h=0,n=0; for(let k=i;k<te;k++){const f=r[k].f_long; if(f===0)continue; n++; if(p.cfg==="A"?f<0:f>0)h++;}
  holdRed+=h; holdN+=n;
  rows.push({t:p.t,cfg:p.cfg,size:p.size,redIn,redOut});
}
const pct=(a,b)=>(100*a/(a+b)).toFixed(1)+"%";
console.log("позиций:",dump.length);
console.log(`ВХОД:  сокращает перекос ${inRed}, углубляет ${inWid}, перекоса нет ${inFlat}  -> сокращает ${pct(inRed,inWid)} позиций, ${pct(wRed,wWid)} ноционала`);
console.log(`ВЫХОД: сокращает ${outRed}, углубляет ${outWid} -> сокращает ${pct(outRed,outWid)}`);
console.log(`КРУГ (вход+выход) сокращающих ног: ${pct(inRed+outRed,inWid+outWid)}`);
console.log(`доля ЧАСОВ удержания на недогруженной стороне: ${(100*holdRed/holdN).toFixed(1)}%`);
const byName={};
for(const r of rows){(byName[r.t]??={r:0,w:0}); r.redIn?byName[r.t].r++:byName[r.t].w++;}
console.log("\nпо именам (вход): " + Object.entries(byName).sort((a,b)=>(b[1].r+b[1].w)-(a[1].r+a[1].w)).slice(0,15)
  .map(([t,v])=>`${t} ${v.r}/${v.r+v.w}`).join(", "));
