package main
import("bytes";"encoding/json";"os";"strconv";"time";"fmt")
func transform(raw []byte) []byte {
 var value any
 if err:=json.Unmarshal(raw,&value);err!=nil{panic(err)}
 var buf bytes.Buffer
 enc:=json.NewEncoder(&buf);enc.SetEscapeHTML(false)
 if err:=enc.Encode(value);err!=nil{panic(err)}
 return buf.Bytes()
}
func main(){
 raw,err:=os.ReadFile(os.Args[1]);if err!=nil{panic(err)}
 n,err:=strconv.Atoi(os.Args[2]);if err!=nil{panic(err)}
 for i:=0;i<25;i++{transform(raw)}
 samples:=[]float64{};var last []byte
 for b:=0;b<7;b++{start:=time.Now();for i:=0;i<n;i++{last=transform(raw)};samples=append(samples,float64(time.Since(start).Nanoseconds())/1e6/float64(n))}
 var before,after map[string]any
 json.Unmarshal(raw,&before);json.Unmarshal(last,&after)
 if before["id"]!=after["id"]||len(before["events"].([]any))!=len(after["events"].([]any)){panic("Roundtrip mismatch")}
 if len(os.Args)>3{if err:=os.WriteFile(os.Args[3],last,0600);err!=nil{panic(err)}}
 result,_:=json.Marshal(map[string]any{"ms_per_op":samples,"output_bytes":len(last)})
 fmt.Println(string(result))
}
