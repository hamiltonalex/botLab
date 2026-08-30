const U="https://api.hyperliquid.xyz/info";
const post=async(b)=>{const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});if(!r.ok)throw new Error(r.status+" "+(await r.text()).slice(0,200));return r.json();};
for(const t of ["allBorrowLendReserveStates","borrowLendReserveStates","perpDexs"]){
 try{const r=await post({type:t});console.log("\n### "+t+" ->",JSON.stringify(r).slice(0,4000));}catch(e){console.log("\n### "+t+" ERR",e.message);}
}
const m=await post({type:"meta"});
console.log("\nmeta keys:",Object.keys(m),"collateralToken:",m.collateralToken);
console.log("marginTables count:",m.marginTables?.length);
