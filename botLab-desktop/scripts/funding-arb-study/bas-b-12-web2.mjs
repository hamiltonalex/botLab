import fs from "node:fs";
const U="https://api.hyperliquid.xyz/info";
async function q(b){const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});return r.json()}
const A="0x7b7f72a28fe109fa703eeed7984f2a8a68fedee2";
const w=await q({type:"webData2",user:A});
console.log("webData2 keys:",Object.keys(w));
for(const k of Object.keys(w)){const v=w[k];const s=JSON.stringify(v);console.log(" ",k,"->",Array.isArray(v)?"array["+v.length+"]":typeof v, s.length>160?s.slice(0,160)+"...":s);}
fs.writeFileSync("bas-b-web2.json",JSON.stringify(w,null,1));
console.log("--- grep for pm/ltv/borrow:");
const s=JSON.stringify(w);
for(const kw of ["ortfolio","ltv","Ltv","borrow","Borrow","pm","margin"]) console.log(kw, (s.match(new RegExp(kw,"g"))||[]).length);
