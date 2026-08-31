// Minimal stand-in for the subset of the Firebase RTDB REST API the game uses:
// GET/PUT/PATCH/DELETE on <path>.json, ETag + if-match, and EventSource
// streaming with put/patch events. Served same-origin as the page so the
// browser can read ETag and open EventSource without any CORS setup.
const http=require("http"), fs=require("fs"), crypto=require("crypto");
const HTML=fs.readFileSync(process.argv[3],"utf8");
let DB={};
const subs=[];   // {path, res}

const seg=p=>p.split("/").filter(Boolean);
// Firebase resolves {".sv":"timestamp"} anywhere in a written body to the
// server's own epoch ms. The game leans on that: it is the only clock all
// clients share, and the Date response header is not readable cross-origin.
function resolveSV(v){
  if(v===null||typeof v!=="object") return v;
  if(v[".sv"]==="timestamp") return Date.now();
  if(Array.isArray(v)) return v.map(resolveSV);
  const o={};
  for(const k of Object.keys(v)) o[k]=resolveSV(v[k]);
  return o;
}
function getIn(parts){
  let n=DB;
  for(const s of parts){ if(n===null||typeof n!=="object"||!(s in n)) return null; n=n[s]; }
  return n===undefined?null:n;
}
// firebase prunes empty branches; the game relies on a wiped /live reading as absent
function prune(n){
  if(n===null||typeof n!=="object") return n;
  for(const k of Object.keys(n)){
    n[k]=prune(n[k]);
    if(n[k]===null||(typeof n[k]==="object"&&!Object.keys(n[k]).length)) delete n[k];
  }
  return Object.keys(n).length?n:null;
}
function setIn(parts,val){
  if(!parts.length){ DB=val===null?{}:val; return; }
  let n=DB;
  for(const s of parts.slice(0,-1)){ if(n[s]===null||typeof n[s]!=="object") n[s]={}; n=n[s]; }
  const last=parts[parts.length-1];
  if(val===null) delete n[last]; else n[last]=val;
  prune(DB);
}
const etagOf=v=>'"'+crypto.createHash("sha1").update(JSON.stringify(v===null?null:v)).digest("hex").slice(0,16)+'"';

// relative path from a subscription root to a changed path, or null if outside
function rel(root,changed){
  const r=seg(root), c=seg(changed);
  for(let i=0;i<r.length;i++) if(r[i]!==c[i]) return null;
  return "/"+c.slice(r.length).join("/");
}
function emit(type,changedPath,data){
  for(const s of subs.slice()){
    const p=rel(s.path,changedPath);
    if(p===null) continue;
    try{ s.res.write("event: "+type+"\ndata: "+JSON.stringify({path:p,data})+"\n\n"); }
    catch(e){ }
  }
}

// Firebase is always a different origin from the page, and a cross-origin
// response only exposes the CORS-safelisted headers to JS -- Date is not one of
// them. Point the page at 127.0.0.1 and the DB at localhost (or the reverse) to
// exercise that: same server, two origins, the browser applies the real rules.
const CORS={"access-control-allow-origin":"*",
            "access-control-allow-methods":"GET,PUT,PATCH,DELETE,OPTIONS",
            "access-control-allow-headers":"content-type,if-match,x-firebase-etag",
            "access-control-max-age":"600"};
// deliberately no access-control-expose-headers, exactly like the real thing

http.createServer((req,res)=>{
  const u=new URL(req.url,"http://x");
  if(req.method==="OPTIONS"){ res.writeHead(204,CORS); res.end(); return; }
  if(!u.pathname.startsWith("/db/")){
    res.writeHead(200,{"content-type":"text/html; charset=utf-8"}); res.end(HTML); return;
  }
  const path=u.pathname.slice(3).replace(/\.json$/,"");
  const parts=seg(path);
  if((req.headers.accept||"").includes("text/event-stream")){
    res.writeHead(200,Object.assign({"content-type":"text/event-stream","cache-control":"no-cache","connection":"keep-alive"},CORS));
    res.write("event: put\ndata: "+JSON.stringify({path:"/",data:getIn(parts)})+"\n\n");
    const s={path,res}; subs.push(s);
    req.on("close",()=>{ const i=subs.indexOf(s); if(i>=0) subs.splice(i,1); });
    return;
  }
  let body="";
  req.on("data",d=>body+=d);
  req.on("end",()=>{
    const cur=getIn(parts);
    const want=req.headers["if-match"];
    if(want && want!=="*" && want!==etagOf(cur)){ res.writeHead(412,CORS); res.end(); return; }
    let out=null;
    if(req.method==="GET") out=cur;
    else if(req.method==="PUT"){ const v=resolveSV(JSON.parse(body||"null")); setIn(parts,v); out=v; emit("put",path,v); }
    else if(req.method==="PATCH"){
      const v=resolveSV(JSON.parse(body||"{}"));
      for(const k in v) setIn(parts.concat(seg(k)),v[k]);
      out=v; emit("patch",path,v);
    }
    else if(req.method==="DELETE"){ setIn(parts,null); out=null; emit("put",path,null); }
    if(process.env.FBLOG && !/\/live\/[^/]+$/.test(path))
      console.log("  [db] "+req.method+" "+path+" "+(body||"").slice(0,120));
    if(process.env.FBLOG && /\/live\/[^/]+$/.test(path) && /"o"/.test(body||""))
      console.log("  [db] "+req.method+" "+path+" (has o) "+(body||"").replace(/"d":"[^"]*",?/,"").slice(0,90));
    const h=Object.assign({"content-type":"application/json"},CORS);
    if(req.headers["x-firebase-etag"]) h.ETag=etagOf(getIn(parts));
    res.writeHead(200,h); res.end(JSON.stringify(out));
  });
}).listen(+process.argv[2],()=>console.log("up on "+process.argv[2]));
