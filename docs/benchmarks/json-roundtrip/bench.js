const fs=require("node:fs");
const {performance}=require("node:perf_hooks");
const raw=fs.readFileSync(process.argv[2],"utf8");
const n=Number(process.argv[3]);
function transform(){return Buffer.from(JSON.stringify(JSON.parse(raw)),"utf8");}
for(let i=0;i<25;i++)transform();
let last,samples=[];
for(let b=0;b<7;b++){const start=performance.now();for(let i=0;i<n;i++)last=transform();samples.push((performance.now()-start)/n);}
if(JSON.parse(last).id!==JSON.parse(raw).id||JSON.parse(last).events.length!==JSON.parse(raw).events.length)throw Error("Roundtrip mismatch");
if(process.argv[4])fs.writeFileSync(process.argv[4],last);
console.log(JSON.stringify({ms_per_op:samples,output_bytes:last.length}));
