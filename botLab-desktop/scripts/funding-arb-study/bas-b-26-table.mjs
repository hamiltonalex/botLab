const N=100000;
const A={HYPE:{lev:10,mm:0.05,ltv:0.65,lt:0.825,carry:0.1208},BTC:{lev:40,mm:0.0125,ltv:0.5,lt:0.75,carry:0.0728},ETH:{lev:25,mm:0.02,ltv:null,lt:null,carry:0.0753}};
const R=0.05; // ставка займа USDC при utilization<=0.8
console.log("=== КЛАССИКА (PM выключен): капитал = спот N + маржа перпа N/k");
for(const [c,a] of Object.entries(A)){
  const line=[];
  for(const k of [1,2,3,5,a.lev]){
    const cap=N+N/k; const liq=(1/k+1)/(1+a.mm)-1;
    line.push("k="+k+": кап $"+Math.round(cap/1000)+"k  дох "+(100*a.carry*N/cap).toFixed(2)+"%  ликв +"+(100*liq).toFixed(1)+"%");
  }
  console.log(" "+c.padEnd(5),line.join(" | "));
}
console.log("\n=== PM (спот залог через автозайм). m = маржа перпа = N/maxLev, займ B = N - E + m <= ltv*N");
for(const c of ["HYPE","BTC"]){
  const a=A[c]; const m=N/a.lev;
  for(const E of [N, 0.7*N, 0.6*N, 0.5*N, (1-a.ltv)*N+m]){
    const B=N-E+m; if(B>a.ltv*N+1e-6) continue;
    const liq=(E-m)/((1+a.mm-0.95*a.lt)*N)-1;
    const net=a.carry*N - R*Math.max(0,B);
    console.log(" "+c.padEnd(5),"кап $"+Math.round(E/1000)+"k  займ $"+Math.round(B/1000)+"k  керри $"+Math.round(a.carry*N)+"  %"+Math.round(R*B)+" процентов  чистое $"+Math.round(net)+"  дох на капитал "+(100*net/E).toFixed(2)+"%  ликв +"+(100*liq).toFixed(1)+"%");
  }
}
console.log("\nбезубыток по utilization для плечевой версии HYPE: u* =",(0.8+(0.1208-0.05)/4.75).toFixed(4));
console.log("безубыток по utilization для плечевой версии BTC:  u* =",(0.8+(0.0728-0.05)/4.75).toFixed(4));
