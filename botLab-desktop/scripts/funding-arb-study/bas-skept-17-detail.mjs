const U="https://api.hyperliquid.xyz/info";
const post=async(b)=>{const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});return r.json();};
for(const a of ["0x89720b18","0x5a72a5f8","0x8c830d21","0x159bfedc"]){}
const full={"0x89720b18":null};
const hedged=JSON.parse(require("node:fs").readFileSync?"{}":"{}");
