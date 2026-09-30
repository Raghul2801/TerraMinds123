// TerraMinds backend: SQLite DB + LangGraph pipeline (traced) + guarded LLM gateway + deadline reminders
import express from "express";import cors from "cors";import fs from "fs";import path from "path";import crypto from "crypto";
import {fileURLToPath} from "url";import Database from "better-sqlite3";
import {StateGraph,Annotation,START,END} from "@langchain/langgraph";
const __d=path.dirname(fileURLToPath(import.meta.url));
const OLLAMA=process.env.OLLAMA||"http://localhost:11434",MODEL=process.env.MODEL||"qwen2.5:3b";
const db=new Database(process.env.DB_FILE||path.join(__d,"terraminds.db"));
db.exec(`CREATE TABLE IF NOT EXISTS users(email TEXT PRIMARY KEY,name TEXT,roll TEXT,course TEXT,pw TEXT,created TEXT);
CREATE TABLE IF NOT EXISTS submissions(id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT,type TEXT,title TEXT,vals TEXT,status TEXT,due TEXT,ts TEXT,UNIQUE(email,title));
CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT,msg TEXT,ts TEXT,UNIQUE(email,msg));
CREATE TABLE IF NOT EXISTS reports(id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT,file TEXT,ts TEXT);
CREATE TABLE IF NOT EXISTS traces(id INTEGER PRIMARY KEY AUTOINCREMENT,run TEXT,node TEXT,status TEXT,ms INTEGER,detail TEXT,ts TEXT);
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY,v TEXT);`);
const app=express();app.use(cors());app.use(express.json({limit:"10mb"}));
const now=()=>new Date().toISOString(),TODAY=()=>new Date(process.env.DEMO_TODAY||"2026-09-29");
/* ---------- LLM safety guardrails ---------- */
const BAD=/ignore (all|previous)|system prompt|https?:\/\/|<script|password|otp|cvv/i;
const mask=s=>String(s).replace(/[\w.+-]+@[\w-]+\.[\w.]+/g,"[email]").replace(/\b\d{10}\b/g,"[phone]").slice(0,2000);
const hits={};const limited=ip=>{const n=Date.now(),a=(hits[ip]=(hits[ip]||[]).filter(t=>n-t<60000));a.push(n);return a.length>30};
app.get("/api/health",async(q,s)=>{try{const d=await(await fetch(OLLAMA+"/api/tags")).json();s.json({llm:d.models.some(m=>m.name.startsWith(MODEL.split(":")[0])),model:MODEL})}catch(e){s.json({llm:false,model:MODEL})}});
app.post("/api/llm",async(q,s)=>{
 if(limited(q.ip))return s.status(429).json({error:"rate limited"});
 const {sys,user,json=true}=q.body||{};if(!sys||!user)return s.status(400).json({error:"bad request"});
 const safe=mask(user);if(BAD.test(safe))return s.status(422).json({error:"prompt-injection blocked"});
 try{const d=await(await fetch(OLLAMA+"/api/chat",{method:"POST",body:JSON.stringify({model:MODEL,stream:false,format:json?"json":undefined,options:{temperature:.2,num_predict:300},messages:[{role:"system",content:sys},{role:"user",content:safe}]})})).json();
  let out=String(d.message.content).slice(0,1200);if(BAD.test(out))return s.status(422).json({error:"unsafe output blocked"});
  if(json)out=JSON.parse(out);s.json({out,tokens:(d.prompt_eval_count||0)+(d.eval_count||0)})}catch(e){s.status(502).json({error:"llm unavailable"})}});
/* ---------- DB endpoints ---------- */
app.get("/api/state",(q,s)=>{const r=db.prepare("SELECT v FROM kv WHERE k='state'").get();s.json(r?JSON.parse(r.v):{})});
app.put("/api/state",(q,s)=>{db.prepare("INSERT OR REPLACE INTO kv VALUES('state',?)").run(JSON.stringify(q.body));s.json({ok:1})});
app.post("/api/users",(q,s)=>{const {name,email,roll,course,pw}=q.body||{};if(!email||!name)return s.status(400).json({error:"bad request"});
 db.prepare("INSERT OR IGNORE INTO users VALUES(?,?,?,?,?,?)").run(email,name,roll,course,crypto.createHash("sha256").update(String(pw)).digest("hex"),now());s.json({ok:1})});
app.get("/api/notifications/:email",(q,s)=>s.json(db.prepare("SELECT msg,ts FROM notifications WHERE email=? ORDER BY id DESC LIMIT 30").all(q.params.email)));
app.get("/api/traces",(q,s)=>s.json(db.prepare("SELECT * FROM traces ORDER BY id DESC LIMIT 60").all()));
app.get("/api/admin/db",(q,s)=>{const c=t=>db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
 s.json({counts:{users:c("users"),submissions:c("submissions"),notifications:c("notifications"),reports:c("reports"),traces:c("traces")},
 users:db.prepare("SELECT name,email,roll,course,created FROM users ORDER BY created DESC LIMIT 8").all(),
 submissions:db.prepare("SELECT email,type,title,status,ts FROM submissions ORDER BY id DESC LIMIT 10").all()})});
app.post("/api/reports",async(q,s)=>{const {file,data,to}=q.body||{};if(!file||!data)return s.status(400).json({error:"bad request"});
 const dir=path.join(__d,"reports");fs.mkdirSync(dir,{recursive:true});const f=path.join(dir,path.basename(file));
 fs.writeFileSync(f,Buffer.from(data.split(",").pop(),"base64"));s.json({saved:true,mailed:await mail(to,"TerraMinds agent report","Please review and validate the attached report.",f)})});
async function mail(to,subject,text,file){if(!process.env.SMTP_HOST||!to||!to.length)return false;
 try{const nm=await import("nodemailer");await nm.default.createTransport({host:process.env.SMTP_HOST,port:587,auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}})
  .sendMail({from:process.env.SMTP_USER,to:[].concat(to).join(","),subject,text,attachments:file?[{path:file}]:[]});return true}catch(e){return false}}
/* ---------- Static exam schedule + deadline reminders ---------- */
const DEAD=[["fee","Semester fee","2026-10-01"],["exam","Data Structures exam fee","2026-10-01"],["exam","Database Systems exam fee","2026-10-01"],["exam","Operating Systems exam fee","2026-10-02"],["exam","Computer Networks exam fee","2026-10-03"]];
async function remindJob(only){let n=0;
 for(const u of db.prepare("SELECT email FROM users").all().filter(u=>!only||u.email===only)){
  for(const [type,title,due] of DEAD){
   const days=Math.ceil((new Date(due)-TODAY())/864e5);if(days<0||days>3)continue;
   const paid=db.prepare("SELECT 1 FROM submissions WHERE email=? AND type=? AND status='done' LIMIT 1").get(u.email,type);if(paid)continue;
   const msg=`⏰ ${title} is due in ${days} day(s) (${due}) — please complete the payment.`;
   if(db.prepare("INSERT OR IGNORE INTO notifications(email,msg,ts) VALUES(?,?,?)").run(u.email,msg,now()).changes){n++;await mail(u.email,"TerraMinds deadline reminder",msg)}}}
 return n}
/* ---------- LangGraph pipeline (each node traced to DB; LangSmith traces automatically when LANGSMITH_TRACING=true) ---------- */
const St=Annotation.Root({email:Annotation(),tasks:Annotation(),file:Annotation(),valid:Annotation(),run:Annotation()});
const node=(name,fn)=>async st=>{const t0=Date.now();let status="ok",detail="",upd={};
 try{const r=await fn(st);upd=r.upd||{};detail=r.detail||""}catch(e){status="error";detail=e.message}
 db.prepare("INSERT INTO traces(run,node,status,ms,detail,ts) VALUES(?,?,?,?,?,?)").run(st.run,name,status,Date.now()-t0,String(detail).slice(0,200),now());return upd};
const graph=new StateGraph(St)
 .addNode("validate",node("validate_guardrails",async st=>{const valid=(st.tasks||[]).filter(t=>["done","reminded"].includes(t.status)&&!BAD.test(JSON.stringify(t.values||{})));return {upd:{valid},detail:`${valid.length}/${(st.tasks||[]).length} passed`}}))
 .addNode("persist",node("persist_submissions",async st=>{const ins=db.prepare("INSERT OR REPLACE INTO submissions(email,type,title,vals,status,due,ts) VALUES(?,?,?,?,?,?,?)");
  st.valid.forEach(t=>ins.run(st.email,t.type,t.title,JSON.stringify(t.values||{}),t.status,t.due,now()));return {detail:`${st.valid.length} rows saved`}}))
 .addNode("reminders",node("deadline_reminders",async st=>({detail:`${await remindJob(st.email)} new reminder(s)`})))
 .addNode("report",node("record_report",async st=>{db.prepare("INSERT INTO reports(email,file,ts) VALUES(?,?,?)").run(st.email,st.file||"",now());return {detail:st.file}}))
 .addEdge(START,"validate").addConditionalEdges("validate",st=>st.valid&&st.valid.length?"persist":END)
 .addEdge("persist","reminders").addEdge("reminders","report").addEdge("report",END).compile();
app.post("/api/graph/run",async(q,s)=>{const {email,tasks,file}=q.body||{};if(!email)return s.status(400).json({error:"bad request"});
 const run=crypto.randomUUID();try{await graph.invoke({email,tasks,file,run});s.json({run})}catch(e){s.status(500).json({error:e.message})}});
setInterval(()=>remindJob().catch(()=>{}),60*60*1000);remindJob().catch(()=>{});
app.listen(8787,()=>console.log("TerraMinds API :8787  model="+MODEL));
