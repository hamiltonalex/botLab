// Воспроизведение арифметики слотов из small.mjs: третий слот берёт left, а не capital/N
for (const capital of [1000,2000,5000,10000,50000,100000,300000]) {
  let left=capital; const sizes=[];
  for (let k=0;k<8;k++){ const size=Math.min(capital/3,left); if(size<capital/100) break; sizes.push(size); left-=size; }
  const s3=sizes[2], s1=sizes[0];
  console.log(`$${capital}: слотов ${sizes.length}, size1=${s1.toPrecision(20)}, size3=${s3?.toPrecision(20)}, равны=${s1===s3}`);
}
