import {books,cap,knots,absorb,totalNtl,ctx,XS} from "./imp-hl-3-curve.mjs";
// проверка склейки: не противоречат ли разрешения друг другу до огибающей
let bad=0, tot=0, gapMax=0;
for(const row of cap){
  const bk=books[row.t].books;
  for(const side of ["asks","bids"]){
    // сравнить накопленный размер тонкого стакана с грубым на той же цене
    const fine=bk["null"], coarse=bk["4"]; if(!fine||!coarse) continue;
    let cumF=0; const fpts=fine[side].map(([p,s])=>[p,cumF+=s]);
    let cumC=0; const cpts=coarse[side].map(([p,s])=>[p,cumC+=s]);
    for(const [p,c] of fpts){
      // грубый на цене не хуже p должен покрывать не меньше
      let best=0; for(const [pc,cc] of cpts){ if(side==="asks"?pc>=p:pc<=p){best=Math.max(best,cc);break;} }
      tot++; if(best< c*0.999){ bad++; gapMax=Math.max(gapMax,(c-best)/c); }
    }
  }
}
console.log(`склейка: точек ${tot}, грубый уровень покрывает тонкий в ${(100*(1-bad/tot)).toFixed(1)}% случаев, макс дефицит ${(100*gapMax).toFixed(1)}%`);
console.log("(дефициты ожидаемы: книги сняты с разрывом ~70мс и агрегация обрезает 20 корзин; огибающая берёт максимум)");
console.log();
console.log("token  mid       spread_bps  visibleBuy$   visibleSell$  buy10k  sell10k");
for(const t of ["BTC","ETH","SOL","FARTCOIN","MOODENG","ANIME","BOME","MELANIA"]){
  const bk=books[t].books, f=bk["null"];
  const mid=(f.bids[0][0]+f.asks[0][0])/2;
  const sp=(f.asks[0][0]-f.bids[0][0])/mid*1e4;
  const ka=knots(bk,"asks"), kb=knots(bk,"bids");
  const a=absorb(ka,mid,1e4,"asks"), b=absorb(kb,mid,1e4,"bids");
  console.log(t.padEnd(9),String(mid.toPrecision(6)).padEnd(10),sp.toFixed(2).padStart(8),
    Math.round(totalNtl(ka)).toLocaleString("en").padStart(13),
    Math.round(totalNtl(kb)).toLocaleString("en").padStart(13),
    (a.bps==null?"OVER":a.bps.toFixed(1)).padStart(8),(b.bps==null?"OVER":b.bps.toFixed(1)).padStart(8));
}
