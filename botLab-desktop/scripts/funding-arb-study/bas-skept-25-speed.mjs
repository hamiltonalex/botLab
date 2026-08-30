import fs from "node:fs";
const C=JSON.parse(fs.readFileSync("bas-skept-c/HYPE_1d.json","utf8"));
const cl=C.map(x=>+x.c),hi=C.map(x=>+x.h);
// fastest observed ascent to +70% from any daily close
let best=1e9,bi=-1;
for(let i=0;i<cl.length;i++){for(let j=i+1;j<cl.length&&j<=i+120;j++){if(hi[j]/cl[i]-1>=0.695){if(j-i<best){best=j-i;bi=i;}break;}}}
console.log(`HYPE: fastest observed +69.5% run = ${best} days, starting ${new Date(C[bi].t).toISOString().slice(0,10)} at $${cl[bi]}`);
// distribution of days-to-breach given a breach happens within 90d
const dd=[];
for(let i=0;i<cl.length;i++){for(let j=i+1;j<cl.length&&j<=i+90;j++){if(hi[j]/cl[i]-1>=0.695){dd.push(j-i);break;}}}
dd.sort((a,b)=>a-b);
console.log(`when a +69.5% breach happens within 90d (n=${dd.length}): days-to-breach p5=${dd[Math.round(.05*(dd.length-1))]} med=${dd[Math.round(.5*(dd.length-1))]} p95=${dd[Math.round(.95*(dd.length-1))]}`);
// 2h intraday max rise over 403d window
const P=JSON.parse(fs.readFileSync("bas-skept-c/HYPE_2h.json","utf8"));
const h2=P.map(x=>+x.h),c2=P.map(x=>+x.c);
for(const W of [1,12,84]){let mx=0,at=0;for(let i=0;i+W<c2.length;i++){let m=0;for(let j=i+1;j<=i+W;j++)m=Math.max(m,h2[j]/c2[i]-1);if(m>mx){mx=m;at=i;}}
 console.log(`HYPE 2h data: max rise over ${W*2}h window = ${(100*mx).toFixed(1)}% (from ${new Date(P[at].t).toISOString().slice(0,10)})`);}
// corrected concentration: carry x notional
const carry={HYPE:.1043,BTC:.0606,ETH:.0613,SOL:.0012,ZEC:null,PUMP:null};
const ntl={HYPE:67.7e6,BTC:23.6e6,ETH:9.29e6,SOL:4.30e6};
let tot=0;const d={};for(const k of Object.keys(ntl)){d[k]=carry[k]*ntl[k];tot+=d[k];}
console.log("\nconcentration, trailing-365d carry x M1's notional rule:");
for(const k of Object.keys(d))console.log(`  ${k.padEnd(5)} carry ${(100*carry[k]).toFixed(2)}%  ntl $${(ntl[k]/1e6).toFixed(1)}M  ->  $${d[k].toFixed(0)}/yr  ${(100*d[k]/tot).toFixed(1)}%`);
console.log(`  TOTAL $${tot.toFixed(0)}/yr on $${((Object.values(ntl).reduce((a,b)=>a+b))/1e6).toFixed(1)}M`);
