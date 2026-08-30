const URL='https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql';
const gql=async q=>{const r=await fetch(URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:q})});return r.json();};
for(const t of ['MarketInfo','OnChainSetting','FundingBalanceOiSnapshot','FundingRateSnapshot','BorrowingRateSnapshot','PositionFeesEntity']){
  const j=await gql(`{ __type(name:"${t}"){ name fields{ name type{name kind ofType{name}} } } }`);
  const f=j.data?.__type;
  console.log('###',t, f? f.fields.map(x=>x.name).join(' ') : 'НЕТ');
}
const j=await gql(`{ __schema{ queryType{ fields{ name } } } }`);
console.log('### queries:', j.data.__schema.queryType.fields.map(x=>x.name).filter(n=>/funding|borrow|market|snapshot|onChain/i.test(n)).join(' '));
