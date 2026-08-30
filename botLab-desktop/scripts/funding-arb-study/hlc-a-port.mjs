// Равновзвешенный шорт HL без выбора монет (наивная корзина): что даёт и как проседает.
import fs from "node:fs";
import { median, SP } from "./skept-cap-lib.mjs";
const S = JSON.parse(fs.readFileSync(`${SP}/hlc-a-y1-series.json`,"utf8"));
const M = JSON.parse(fs.readFileSync(`${SP}/hlc-a-y1.json`,"utf8"));
const pc=x=>(x>=0?"+":"")+(100*x).toFixed(2)+"%";
function port(tokens, label) {
  const sers = tokens.map(t=>S[t]).filter(Boolean);
  const L = Math.min(...sers.map(s=>s.length)); // общий хвост (все ряды кончаются 20.06.26)
  const cut = sers.map(s=>s.slice(s.length-L));
  const w = 1/cut.length; let cum=0,peak=0,dd=0; const path=[];
  for (let i=0;i<L;i++){ let v=0; for(const s of cut) v+=w*s[i]; cum+=v; if(cum>peak)peak=cum; if(cum-peak<dd)dd=cum-peak; path.push(cum);}
  const yrs=L/8760;
  // худшее 30д/90д окно
  const wq=W=>{if(L<W)return NaN;let worst=Infinity;for(let i=0;i+W<=L;i+=24){const v=path[i+W-1]-path[i];if(v<worst)worst=v;}return worst;};
  console.log(`${label}: монет ${cut.length}, часов ${L} (${yrs.toFixed(2)} г.), итог $${cum.toFixed(0)} на $10k = APR ${pc(cum/10000/yrs)}, просадка $${dd.toFixed(0)} (${pc(dd/10000)}), худшее 30д $${wq(720).toFixed(0)}, 90д $${wq(2160).toFixed(0)}`);
}
port(["BTC","ETH","SOL","LINK","AAVE","UNI","DOGE","LTC","NEAR","ARB"], "10 мажоров, равные веса");
port(["BTC","ETH"], "BTC+ETH");
port(M.filter(r=>r.hours===8761).map(r=>r.token), "все с полной историей, равные веса");
