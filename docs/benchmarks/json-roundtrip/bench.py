import json,sys,time
raw=open(sys.argv[1],encoding="utf-8").read()
n=int(sys.argv[2])
def transform():
    return json.dumps(json.loads(raw),ensure_ascii=False,separators=(",",":")).encode("utf-8")
for _ in range(25): transform()
samples=[]
for _ in range(7):
    start=time.perf_counter()
    for i in range(n): last=transform()
    samples.append((time.perf_counter()-start)*1000/n)
assert json.loads(last)["id"]==json.loads(raw)["id"]
assert len(json.loads(last)["events"])==len(json.loads(raw)["events"])
if len(sys.argv)>3: open(sys.argv[3],"wb").write(last)
print(json.dumps({"ms_per_op":samples,"output_bytes":len(last)}))
