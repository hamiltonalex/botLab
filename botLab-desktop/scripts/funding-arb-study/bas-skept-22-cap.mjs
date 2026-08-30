const U="https://api.hyperliquid.xyz/info";
const post=async(b)=>{const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});if(!r.ok)return {ERR:r.status,body:(await r.text()).slice(0,150)};return r.json();};
const w=await post({type:"webData2",user:"0x89720b1831fd8457ea9026f5ffb476ed6d35e6bd"});
console.log("webData2 keys:",Object.keys(w));
for(const k of Object.keys(w)){const v=w[k];const s=JSON.stringify(v);if(/cap|Cap|limit|Limit|ltv|borrow|Borrow|supply|Supply|portfolio|Portfolio/.test(k)||(s&&s.length<600&&/cap|ltv|borrow/i.test(s))) console.log(" ",k,"=",s.slice(0,900));}
for(const t of ["portfolioMarginCaps","borrowLendCaps","spotDeployState","tokenDetails"]){
 const r=await post(t==="tokenDetails"?{type:t,tokenId:"0x0d01dc56dcaaca66ad901c959b4011ec"}:{type:t});
 console.log("\n###",t,"->",JSON.stringify(r).slice(0,700));
}
