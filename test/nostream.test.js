// The room when EventSource cannot connect. Firebase's REST streaming endpoint
// is not dependably reachable from a browser -- its own SDK uses WebSockets
// instead -- while the plain REST calls keep working, so a room can be entered
// and then never update again. Seats, ready, status and chat all arrive over
// that one socket, which is why a single dead stream looks like three bugs.
//   NODE_PATH=<playwright dir> node test/nostream.test.js
// Runs the server with NOSTREAM=1; pass STREAM=1 to check the same flow with a
// healthy stream.
const {chromium}=require("playwright");
const {spawn}=require("child_process");
const PORT=8735, BASE="http://localhost:"+PORT;
const DB="http://127.0.0.1:"+PORT+"/db";      // a second origin, as Firebase always is
const HTML=process.argv[2]||__dirname+"/../Tetris2_Beta.html";
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let fails=0, checks=0;
const T0=Date.now();
const sect=n=>console.log("\n== "+n+" ==  ["+((Date.now()-T0)/1000).toFixed(0)+"s]");
const ok=(n,c,x)=>{checks++;c?console.log("  PASS  "+n):(fails++,console.log("  FAIL  "+n+(x!==undefined?"  -> "+JSON.stringify(x):"")))};

(async()=>{
  const env=Object.assign({},process.env);
  if(!process.env.STREAM) env.NOSTREAM="1"; else delete env.NOSTREAM;
  console.log(process.env.STREAM?"(stream allowed)":"(EventSource refused: 403)");
  const srv=spawn("node",[__dirname+"/fbserver.js",String(PORT),HTML],{stdio:"inherit",env});
  await sleep(600);
  const browser=await chromium.launch({executablePath:process.env.CHROME||undefined,
    args:["--disable-background-timer-throttling","--disable-backgrounding-occluded-windows","--disable-renderer-backgrounding"]});
  const mk=async name=>{
    const ctx=await browser.newContext({viewport:{width:1100,height:740}});
    await ctx.addInitScript(([n,db])=>{
      localStorage.setItem("tfx:fbUrl",JSON.stringify(db));
      localStorage.setItem("tfx:name",JSON.stringify(n));
      localStorage.setItem("tfx:touch",JSON.stringify("off"));
      localStorage.setItem("tfx:touchSet",JSON.stringify(true));
      localStorage.setItem("tfx:lang",JSON.stringify("en"));
    },[name,DB]);
    const p=await ctx.newPage(); p.name=name;
    p.on("pageerror",e=>{ console.log("  !! pageerror ["+name+"] "+e.message); fails++; });
    await p.goto(BASE,{waitUntil:"load"});
    return p;
  };
  const toLobby=async p=>{
    await p.click('[data-go="play"]');
    await p.waitForFunction(()=>UI.cur==="#v-play");
    await p.click('[data-go="versus"]');
    await p.waitForFunction(()=>UI.cur==="#v-lobby");
  };
  const seatsOf=p=>p.evaluate(()=>RoomClient.on
    ? RoomClient.view().seats.map(s=>s.n+(s.fresh?"":"[STALE]")+(s.rdy?":READY":"")) : null);

  try{
    sect("three into one room with no usable stream");
    const A=await mk("ALICE"), B=await mk("BOB"), C=await mk("CARL");
    for(const p of [A,B,C]) await toLobby(p);
    await A.click("#b-mkroom");
    await A.waitForFunction(()=>UI.cur==="#v-room"&&RoomClient.on,{timeout:15000});
    const room=await A.evaluate(()=>RoomClient.id);
    console.log("  room "+room);
    for(const p of [B,C]){
      await p.waitForSelector('[data-room="'+room+'"]',{timeout:20000});
      await p.click('[data-room="'+room+'"]');
      await p.waitForFunction(()=>UI.cur==="#v-room"&&RoomClient.on,{timeout:15000});
    }
    ok("all three entered the room",(await A.evaluate(()=>RoomClient.on))&&
       (await B.evaluate(()=>RoomClient.on))&&(await C.evaluate(()=>RoomClient.on)));

    sect("symptom 3: the other players' status");
    await sleep(6000);   // past the stream warm-up, whatever transport wins
    for(const [nm,pg] of [["ALICE",A],["BOB",B],["CARL",C]])
      ok(nm+" sees all three seats",(await seatsOf(pg)||[]).length===3,await seatsOf(pg));

    sect("symptom 1: everyone readies and the round starts");
    // two of three is not enough to start, so the flags stay up to be looked at
    for(const p of [A,B]) await p.click("#b-ready");
    await sleep(3000);
    for(const [nm,pg] of [["ALICE",A],["BOB",B],["CARL",C]])
      ok(nm+" sees ALICE and BOB go ready",
        (await seatsOf(pg)||[]).filter(s=>s.includes(":READY")).length===2,await seatsOf(pg));
    await C.click("#b-ready");
    for(const [nm,pg] of [["ALICE",A],["BOB",B],["CARL",C]]){
      await pg.waitForFunction(()=>!!(G&&!G.over&&G.mode==="versus"),{timeout:25000}).catch(()=>{});
      ok("the round started for "+nm,await pg.evaluate(()=>!!(G&&!G.over&&G.mode==="versus")),
        await seatsOf(pg));
    }

    sect("boards still mirror between the players");
    await sleep(4000);
    for(const [nm,pg] of [["ALICE",A],["BOB",B],["CARL",C]])
      ok(nm+" mirrors the other two wells",
        await pg.evaluate(()=>FOES.length===2&&FOES.every(f=>!!f.board)),
        await pg.evaluate(()=>FOES.map(f=>f.name+":"+(f.board?"board":"empty"))));
    for(const p of [B,C]) await p.evaluate(()=>{G&&!G.over&&G.die();});
    await A.waitForFunction(()=>RoomClient.view().seats.some(s=>s.pid===PID&&s.w>0),{timeout:20000}).catch(()=>{});
    ok("last one standing was credited the win",
      await A.evaluate(()=>{const m=RoomClient.view().seats.find(s=>s.pid===PID); return !!m&&m.w===1;}),
      await A.evaluate(()=>RoomClient.view().seats.map(s=>s.n+":"+s.w)));
    for(const p of [A,B,C]){
      if(await p.evaluate(()=>$("#game-over").classList.contains("on"))) await p.click("#go-menu");
      await p.waitForFunction(()=>UI.cur==="#v-room",{timeout:15000}).catch(()=>{});
    }

    sect("symptom 2: chat");
    await B.fill("#chat-in","hello from bob");
    await B.press("#chat-in","Enter");
    await sleep(3000);
    for(const [nm,pg] of [["ALICE",A],["BOB",B],["CARL",C]]){
      const log=await pg.evaluate(()=>RoomClient.chat.map(m=>m.n+": "+m.m));
      ok(nm+" received the message",log.some(l=>l==="BOB: hello from bob"),log);
    }
    ok("the room reports the transport it fell back to",
      await A.evaluate(()=>Sig.polling>0)===!process.env.STREAM,
      await A.evaluate(()=>({polling:Sig.polling})));

    console.log("\n"+(fails?"FAILED "+fails+"/"+checks:"ALL "+checks+" CHECKS PASSED"));
  }catch(e){ console.log("\nERROR "+e.message+"\n"+e.stack); fails++; }
  await browser.close(); srv.kill();
  process.exit(fails?1:0);
})();
