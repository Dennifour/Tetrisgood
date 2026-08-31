// Room-multiplayer integration test: 3 players + 1 spectator against a local
// stand-in for the Firebase RTDB REST API (test/fbserver.js), driven in four
// real browser contexts.
//   NODE_PATH=<playwright dir> CHROME=<chromium binary> node test/spectate.test.js
// FBLOG=1 logs every non-board database write.
const {chromium}=require("playwright");
const {spawn}=require("child_process");
const PORT=8731, BASE="http://localhost:"+PORT;
// the database on a second origin, the way Firebase always is
const DB="http://127.0.0.1:"+PORT+"/db";
const HTML=process.argv[2]||__dirname+"/../Tetris2_Beta.html";
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let fails=0, checks=0;
function ok(name,cond,extra){
  checks++;
  if(cond) console.log("  PASS  "+name);
  else { fails++; console.log("  FAIL  "+name+(extra!==undefined?"  -> "+JSON.stringify(extra):"")); }
}

(async()=>{
  const srv=spawn("node",[__dirname+"/fbserver.js",String(PORT),HTML],{stdio:"inherit"});
  await sleep(600);
  const browser=await chromium.launch({executablePath:process.env.CHROME||undefined,
    args:["--disable-background-timer-throttling","--disable-backgrounding-occluded-windows","--disable-renderer-backgrounding"]});
  const mk=async name=>{
    const ctx=await browser.newContext({viewport:{width:1280,height:760}});
    await ctx.addInitScript(([n,db])=>{
      localStorage.setItem("tfx:fbUrl",JSON.stringify(db));
      localStorage.setItem("tfx:name",JSON.stringify(n));
      localStorage.setItem("tfx:touch",JSON.stringify("off"));
      localStorage.setItem("tfx:touchSet",JSON.stringify(true));
      localStorage.setItem("tfx:lang",JSON.stringify("en"));
    },[name,DB]);
    const p=await ctx.newPage();
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
  const st=p=>p.evaluate(()=>({
    cur:UI.cur, room:RoomClient.on, spectating:!!(G&&G.spectating), over:!!(G&&G.over),
    SPEC:typeof SPEC!=="undefined"?SPEC:null,
    specBoxes:(L&&L.spec)?L.spec.map(b=>({x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.w),h:Math.round(b.h)})):null,
    foes:(FOES||[]).map(f=>({n:f.name,dead:!!f.dead,hasBoard:!!f.board})),
    alive:RoomClient.on?RoomClient.view().alive.map(s=>s.n):null,
    seats:RoomClient.on?RoomClient.view().seats.map(s=>s.n+(s.spec?"(spec)":"")+(s.fresh?"":"[STALE]")+(s.d?"[KO]":"")):null,
    roster:RoomClient.on?RoomClient.view().roster:null,
    inRound:RoomClient.on?RoomState.inRound(RoomClient.view(),PID):null,
    hbAge:RoomClient.on?Date.now()-(((RoomClient.st.tree.seat||{})[PID]||{}).hb||0):null
  }));

  try{
    console.log("\n== setup: 3 players + 1 spectator ==");
    const A=await mk("ALICE"), B=await mk("BOB"), D=await mk("DAVE"), C=await mk("WATCHER");
    for(const p of [A,B,D,C]) await toLobby(p);

    await A.click("#b-mkroom");
    await A.waitForFunction(()=>UI.cur==="#v-room"&&RoomClient.on);
    const roomId=await A.evaluate(()=>RoomClient.id);
    console.log("  room "+roomId);

    for(const p of [B,D,C]){
      await p.waitForSelector("[data-room]",{timeout:15000});
      await p.click("[data-room]");
      await p.waitForFunction(()=>UI.cur==="#v-room"&&RoomClient.on,{timeout:15000});
    }
    await sleep(800);
    ok("4 seats visible to host",(await st(A)).seats.length===4,(await st(A)).seats);

    console.log("\n== spectate button is reachable before a match ==");
    ok("spectate button visible in an idle room",await C.isVisible("#b-spectate"));
    await C.click("#b-spectate");
    await C.waitForFunction(()=>{const m=RoomClient.view().seats.find(s=>s.pid===PID);return m&&m.spec;},{timeout:8000});
    ok("seat flagged spectating",(await st(C)).seats.some(s=>s.includes("(spec)")),(await st(C)).seats);

    console.log("\n== match starts with 3 players, spectator excluded ==");
    for(const p of [A,B,D]) await p.click("#b-ready");
    await C.waitForFunction(()=>!!(G&&G.spectating),{timeout:15000});
    await A.waitForFunction(()=>!!(G&&!G.over),{timeout:15000});
    await sleep(4000);   // countdown + a few board publishes
    let c=await st(C);
    ok("spectator is spectating",c.spectating,c);
    ok("spectator is not in the roster",await C.evaluate(()=>!RoomState.inRound(RoomClient.view(),PID)));
    ok("3 boards laid out",c.SPEC===3,{SPEC:c.SPEC,boxes:c.specBoxes});
    ok("boards are side by side (same y)",c.specBoxes&&new Set(c.specBoxes.map(b=>b.y)).size===1,c.specBoxes);
    ok("boards left-to-right, non-overlapping",c.specBoxes&&c.specBoxes.every((b,i)=>i===0||b.x>=c.specBoxes[i-1].x+c.specBoxes[i-1].w),c.specBoxes);
    ok("all 3 boards have data",c.foes.length===3&&c.foes.every(f=>f.hasBoard),c.foes);
    ok("no hold/next/hud drawn for a spectator",
      await C.evaluate(()=>L.hold.w===0&&L.next.w===0&&L.hud.w===0&&L.gw===0));
    ok("no countdown left frozen on screen",await C.evaluate(()=>COUNT===0));
    await C.screenshot({path:(process.env.SHOTDIR||__dirname)+"/shot-3boards.png"});

    console.log("\n== KO'd board is dropped ==");
    await B.evaluate(()=>{G.die();});
    await C.waitForFunction(()=>SPEC===2,{timeout:15000}).catch(()=>{});
    await sleep(1200);
    c=await st(C);
    ok("2 boards after one KO",c.SPEC===2,{SPEC:c.SPEC,foes:c.foes});
    ok("BOB not drawn",!(c.specBoxes||[]).length||!c.foes.filter(f=>!f.dead).some(f=>f.n==="BOB"),c.foes);
    ok("BOB still marked dead in FOES",c.foes.some(f=>f.n==="BOB"&&f.dead),c.foes);
    ok("boards re-centred side by side",c.specBoxes&&c.specBoxes.length===2&&new Set(c.specBoxes.map(b=>b.y)).size===1,c.specBoxes);
    ok("still spectating, not ended early",c.spectating&&c.cur===null,c);
    await C.screenshot({path:(process.env.SHOTDIR||__dirname)+"/shot-2boards.png"});

    console.log("\n== spectating ends when the round ends ==");
    await D.evaluate(()=>{G.die();});
    await C.waitForFunction(()=>UI.cur==="#v-room",{timeout:15000}).catch(()=>{});
    await sleep(1500);
    c=await st(C);
    ok("spectator returned to the room",c.cur==="#v-room",c);
    ok("spectator still seated in the room",c.room,c);
    for(const [nm,pg] of [["ALICE",A],["BOB",B],["DAVE",D]])
      console.log("  tree["+nm+"] "+JSON.stringify(await pg.evaluate(()=>({
        pid:PID, over:G&&G.over, won:G&&G.won, spectating:G&&G.spectating,
        go:RoomClient.st.tree.go,
        seatJ:Object.fromEntries(Object.entries(RoomClient.st.tree.seat||{}).map(([k,v])=>[k,v.j])),
        live:Object.fromEntries(Object.entries(RoomClient.st.tree.live||{}).map(([k,v])=>[k,{o:v.o,ms:v.ms}]))
      }))));
    // sampled from the room, not from G: by now the winner's card has run
    // dropBoard() and G is null, which is correct and says nothing about the win
    await A.waitForFunction(()=>RoomClient.view().seats.some(s=>s.pid===PID&&s.w>0),{timeout:10000}).catch(()=>{});
    ok("last player standing won",await A.evaluate(()=>{
      const m=RoomClient.view().seats.find(s=>s.pid===PID); return !!m&&m.w===1;}),
      await A.evaluate(()=>RoomClient.view().seats.map(s=>s.n+":"+s.w)));
    ok("winner shown a result card",await A.evaluate(()=>$("#game-over").classList.contains("on")));
    for(const [nm,pg] of [["BOB",B],["DAVE",D]]){
      // a loser waits out TIE_CAP for a winner's ms that never comes (a win
      // publishes o:1 through the board but no duration), so the card is ~3s
      await pg.waitForFunction(()=>$("#game-over").classList.contains("on"),{timeout:10000}).catch(()=>{});
      const s=await pg.evaluate(()=>({card:$("#game-over").classList.contains("on"),bodyOver:document.body.classList.contains("over"),
        G:G?{over:G.over,won:G.won,pending:G.pending,resolved:G.resolved,spectating:G.spectating,stranded:G.stranded}:null,
        goneFor:UI._goneFor===null?"null":(UI._goneFor===undefined?"undef":(UI._goneFor===G?"===G":"other")),
        goTimer:goTimer, cur:UI.cur}));
      console.log("  card["+nm+"] "+JSON.stringify(s));
      ok("result card shown to "+nm,s.card,s);
    }
    ok("no win credited to the losers",await B.evaluate(()=>RoomClient.view().seats.every(s=>s.pid===PID?s.w===0:true))&&
                                       await D.evaluate(()=>RoomClient.view().seats.every(s=>s.pid===PID?s.w===0:true)));
    await C.screenshot({path:(process.env.SHOTDIR||__dirname)+"/shot-back-in-room.png"});

    console.log("\n== spectator can play the next round ==");
    await C.click("#b-spectate");
    await C.waitForFunction(()=>{const m=RoomClient.view().seats.find(s=>s.pid===PID);return m&&!m.spec;},{timeout:8000});
    ok("un-spectated",!(await st(C)).seats.some(s=>s.includes("(spec)")),(await st(C)).seats);

    console.log("\n"+(fails?"FAILED "+fails+"/"+checks:"ALL "+checks+" CHECKS PASSED"));
  }catch(e){ console.log("\nERROR "+e.message+"\n"+e.stack); fails++; }
  await browser.close(); srv.kill();
  process.exit(fails?1:0);
})();
