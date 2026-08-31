// Room-multiplayer integration test for three and four players in one room,
// against a local stand-in for the Firebase RTDB REST API (test/fbserver.js),
// driven in real browser contexts.
//   NODE_PATH=<playwright dir> CHROME=<chromium binary> node test/multi.test.js
// FBLOG=1 logs every non-board database write.
const {chromium}=require("playwright");
const {spawn}=require("child_process");
const PORT=8732, BASE="http://localhost:"+PORT;
// the database on a second origin, the way Firebase always is
const DB="http://127.0.0.1:"+PORT+"/db";
const HTML=process.argv[2]||__dirname+"/../Tetris2_Beta.html";
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let fails=0, checks=0;
const T0=Date.now();
const sect=n=>console.log("\n== "+n+" ==  ["+((Date.now()-T0)/1000).toFixed(0)+"s]");
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
    p.name=name;
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
  const join=async (p,id)=>{
    await p.waitForSelector('[data-room="'+id+'"]',{timeout:15000});
    await p.click('[data-room="'+id+'"]');
    await p.waitForFunction(()=>UI.cur==="#v-room"&&RoomClient.on,{timeout:15000});
  };
  const pid=p=>p.evaluate(()=>PID);
  const st=p=>p.evaluate(()=>({
    cur:UI.cur, room:RoomClient.on, over:!!(G&&G.over), spectating:!!(G&&G.spectating),
    playing:!!(G&&!G.over&&G.mode==="versus"&&!G.spectating),
    wins:RoomClient.on?RoomClient.view().seats.map(s=>s.n+":"+s.w):null,
    seats:RoomClient.on?RoomClient.view().seats.map(s=>s.n+(s.spec?"(spec)":"")+(s.d?"[KO]":"")):null,
    roster:RoomClient.on?Object.keys(RoomClient.view().roster||{}).length:null,
    inRound:RoomClient.on?RoomState.inRound(RoomClient.view(),PID):null,
    alive:RoomClient.on?RoomClient.view().alive.map(s=>s.n):null,
    foes:(FOES||[]).map(f=>({n:f.name,dead:!!f.dead,hasBoard:!!f.board})),
    twin:typeof TWIN!=="undefined"?TWIN:null,
    recv:G?G.attackRecv|0:null
  }));
  // every seat has to see the same round before anyone is KO'd
  const allPlaying=async ps=>{
    for(const p of ps) await p.waitForFunction(()=>!!(G&&!G.over&&G.mode==="versus"&&!G.spectating&&COUNT===0),{timeout:25000});
  };
  const cardOn=p=>p.evaluate(()=>$("#game-over").classList.contains("on"));
  // the card lands a beat after the run ends, and "back to room" is a click
  const waitCard=(p,ms)=>p.waitForFunction(()=>$("#game-over").classList.contains("on"),{timeout:ms||12000});
  const toRoom=async p=>{
    if((await p.evaluate(()=>UI.cur))==="#v-room") return;
    await waitCard(p,8000).catch(()=>{});
    if(await cardOn(p)) await p.click("#go-menu");
    await p.waitForFunction(()=>UI.cur==="#v-room",{timeout:12000}).catch(()=>{});
  };
  // a result card still up hides the room, and the room is where ready lives
  const readyAll=async ps=>{
    for(const p of ps) if((await p.evaluate(()=>UI.cur))!=="#v-room") await toRoom(p);
    for(const p of ps) await p.click("#b-ready");
  };

  try{
    sect("three in a room");
    const A=await mk("ALICE"), B=await mk("BOB"), D=await mk("DAVE");
    for(const p of [A,B,D]) await toLobby(p);
    await A.click("#b-mkroom");
    await A.waitForFunction(()=>UI.cur==="#v-room"&&RoomClient.on);
    const room=await A.evaluate(()=>RoomClient.id);
    console.log("  room "+room);
    for(const p of [B,D]) await join(p,room);
    await sleep(700);
    for(const p of [A,B,D]) ok("3 seats visible to "+p.name,(await st(p)).seats.length===3,(await st(p)).seats);

    sect("a three-player round starts for everyone");
    await readyAll([A,B,D]);
    await allPlaying([A,B,D]);
    await sleep(1600);   // a few board publishes
    for(const p of [A,B,D]){
      const s=await st(p);
      ok(p.name+" is in the frozen roster of 3",s.roster===3&&s.inRound,{roster:s.roster,inRound:s.inRound});
      ok(p.name+" mirrors the other two wells",s.foes.length===2&&s.foes.every(f=>f.hasBoard),s.foes);
      ok(p.name+" lays out 2 opponent boards",s.twin===2,{twin:s.twin});
      ok(p.name+" counts 3 alive",s.alive.length===3,s.alive);
    }
    await A.screenshot({path:(process.env.SHOTDIR||__dirname)+"/shot-3p-round.png"});

    sect("attacks route to the seat they are addressed to");
    const bPid=await pid(B);
    const before=(await st(B)).recv;
    await A.evaluate(t=>RoomClient.sendAttack(t,4),bPid);
    await B.waitForFunction(n=>!!G&&G.attackRecv>n,before,{timeout:10000}).catch(()=>{});
    ok("BOB took the 4 lines ALICE addressed to him",(await st(B)).recv>=before+4,{before,after:(await st(B)).recv});
    ok("DAVE took none of them",(await st(D)).recv===0,(await st(D)).recv);

    sect("last of three standing wins");
    await B.evaluate(()=>{G.die();});
    await sleep(600);
    await D.evaluate(()=>{G.die();});
    await A.waitForFunction(()=>RoomClient.view().seats.some(s=>s.pid===PID&&s.w>0),{timeout:15000}).catch(()=>{});
    ok("ALICE credited the win",await A.evaluate(()=>{
      const m=RoomClient.view().seats.find(s=>s.pid===PID); return !!m&&m.w===1;}),(await st(A)).wins);
    await waitCard(A).catch(()=>{});
    ok("winner shown a result card",await cardOn(A));
    for(const p of [B,D]){
      await waitCard(p).catch(()=>{});
      ok("result card shown to "+p.name,await cardOn(p));
    }
    ok("no win credited to the two losers",
      (await B.evaluate(()=>RoomClient.view().seats.find(s=>s.pid===PID).w))===0 &&
      (await D.evaluate(()=>RoomClient.view().seats.find(s=>s.pid===PID).w))===0,(await st(A)).wins);

    sect("everyone lands back in the room and can go again");
    for(const p of [A,B,D]) await toRoom(p);
    for(const p of [A,B,D]) ok(p.name+" back in the room",(await st(p)).cur==="#v-room",(await st(p)).cur);
    ok("ready cleared for the next round",
      await A.evaluate(()=>RoomClient.view().seats.every(s=>!s.rdy)),
      await A.evaluate(()=>RoomClient.view().seats.map(s=>s.n+":"+(s.rdy?1:0))));
    await readyAll([A,B,D]);
    await allPlaying([A,B,D]);
    ok("second round started for all three",true);
    ok("the win from round one survived",(await st(A)).wins.some(w=>w==="ALICE:1"),(await st(A)).wins);
    // park the round so the next section starts from an idle room
    await sleep(1200);
    for(const p of [B,D,A]){ await p.evaluate(()=>{G&&!G.over&&G.die();}); await sleep(400); }
    for(const p of [A,B,D]) await toRoom(p);

    sect("a fourth player joins");
    const E=await mk("EVE");
    await toLobby(E);
    await join(E,room);
    await sleep(700);
    for(const p of [A,B,D,E]) ok("4 seats visible to "+p.name,(await st(p)).seats.length===4,(await st(p)).seats);

    sect("a fifth is turned away: the room is full");
    const F=await mk("FRANK");
    await toLobby(F);
    await F.waitForSelector('[data-room="'+room+'"]',{timeout:15000});
    await F.click('[data-room="'+room+'"]');
    await sleep(2500);
    ok("FRANK did not get a seat",!(await F.evaluate(()=>RoomClient.on)));
    ok("the room still holds exactly 4",(await st(A)).seats.length===4,(await st(A)).seats);

    sect("a four-player round");
    await readyAll([A,B,D,E]);
    await allPlaying([A,B,D,E]);
    await sleep(1600);
    for(const p of [A,B,D,E]){
      const s=await st(p);
      ok(p.name+" is in the frozen roster of 4",s.roster===4&&s.inRound,{roster:s.roster,inRound:s.inRound});
      ok(p.name+" mirrors the other three wells",s.foes.length===3&&s.foes.every(f=>f.hasBoard),s.foes);
      ok(p.name+" lays out 3 opponent boards",s.twin===3,{twin:s.twin});
      ok(p.name+" counts 4 alive",s.alive.length===4,s.alive);
    }
    await A.screenshot({path:(process.env.SHOTDIR||__dirname)+"/shot-4p-round.png"});

    sect("KOs thin the field one at a time");
    await B.evaluate(()=>{G.die();});
    await A.waitForFunction(()=>RoomClient.view().alive.length===3,{timeout:12000}).catch(()=>{});
    ok("3 alive after one KO",(await st(A)).alive.length===3,(await st(A)).alive);
    await D.evaluate(()=>{G.die();});
    await A.waitForFunction(()=>RoomClient.view().alive.length===2,{timeout:12000}).catch(()=>{});
    ok("2 alive after two KOs",(await st(A)).alive.length===2,(await st(A)).alive);
    await E.evaluate(()=>{G.die();});
    await A.waitForFunction(()=>RoomClient.view().seats.some(s=>s.pid===PID&&s.w>1),{timeout:15000}).catch(()=>{});
    ok("ALICE credited the second win",await A.evaluate(()=>{
      const m=RoomClient.view().seats.find(s=>s.pid===PID); return !!m&&m.w===2;}),(await st(A)).wins);
    for(const p of [B,D,E]){
      await waitCard(p).catch(()=>{});
      ok("result card shown to "+p.name,await cardOn(p));
    }
    for(const p of [A,B,D,E]) await toRoom(p);

    sect("spectate cannot be pressed once you are ready");
    await sleep(500);
    // the stream is a round trip away, so a click landing in the same tick as
    // the ready is the case that used to slip through
    await E.evaluate(()=>{ $("#b-ready").click(); $("#b-spectate").click(); });
    await sleep(1500);
    ok("EVE is ready and not spectating",
      await E.evaluate(()=>{const m=RoomClient.view().seats.find(s=>s.pid===PID); return !!m&&m.rdy&&!m.spec;}),
      await E.evaluate(()=>RoomClient.view().seats.map(s=>s.n+":"+(s.rdy?"R":"-")+(s.spec?"S":"-"))));
    ok("the spectate button is disabled while ready",await E.evaluate(()=>$("#b-spectate").disabled));
    await E.evaluate(()=>{ $("#b-ready").click(); });
    await E.waitForFunction(()=>{const m=RoomClient.view().seats.find(s=>s.pid===PID); return m&&!m.rdy;},{timeout:8000});
    ok("un-readying frees the spectate button again",await E.evaluate(()=>!$("#b-spectate").disabled));
    // whatever the section left behind, the next one starts from a clean seat
    for(const p of [A,B,D,E]){
      await p.evaluate(()=>Sig.patch(RoomClient.mine(),{rdy:false,spec:false}).catch(()=>{}));
    }
    await sleep(800);

    sect("a seat that spectates after the roster froze does not hang the round");
    // exactly what the network race produces: the host freezes the roster with
    // EVE in it, and her spec flag lands before the go event does
    await A.evaluate(()=>{
      const put=Sig.put.bind(Sig);
      window._putWas=put;
      Sig.put=(p,v)=>/\/go$/.test(p)
        ? new Promise(r=>setTimeout(()=>r(put(p,v)),1600))
        : put(p,v);
    });
    await readyAll([A,B,D,E]);
    await E.waitForFunction(()=>!!(RoomClient.st.tree.go&&RoomClient.st.tree.go.roster),{timeout:20000}).catch(()=>{});
    await E.evaluate(()=>{ RoomClient.setSpectating(true); });
    await allPlaying([A,B,D]);
    await sleep(1800);
    let s=await st(E);
    ok("EVE was frozen into the roster",s.roster===4,{roster:s.roster});
    ok("EVE is spectating, not playing",s.spectating,s);
    ok("EVE does not count as alive",!(await st(A)).alive.includes("EVE"),(await st(A)).alive);
    await B.evaluate(()=>{G.die();});
    await sleep(500);
    await D.evaluate(()=>{G.die();});
    await A.waitForFunction(()=>RoomClient.view().seats.some(s=>s.pid===PID&&s.w>2),{timeout:15000}).catch(()=>{});
    ok("the round still found its last player standing",await A.evaluate(()=>{
      const m=RoomClient.view().seats.find(s=>s.pid===PID); return !!m&&m.w===3;}),(await st(A)).wins);
    for(const p of [B,D]){
      await waitCard(p).catch(()=>{});
      const d=await p.evaluate(()=>({card:$("#game-over").classList.contains("on"), cur:UI.cur, goTimer,
        G:G?{over:G.over,won:G.won,pending:G.pending,resolved:G.resolved,spectating:G.spectating,stranded:G.stranded}:null,
        live:Object.fromEntries(Object.entries(RoomClient.st.tree.live||{}).map(([k,v])=>[k,{o:v.o,ms:v.ms}])),
        alive:RoomClient.view().alive.map(s=>s.n)}));
      ok("result card shown to "+p.name,d.card,d);
    }

    sect("a well that ends during the countdown still resolves");
    await A.evaluate(()=>{ if(window._putWas) Sig.put=window._putWas; });
    for(const p of [A,B,D]) await toRoom(p);   // the winner is holding a card too
    await E.evaluate(()=>RoomClient.setSpectating(false).catch(()=>{}));
    await E.waitForFunction(()=>{const m=RoomClient.view().seats.find(s=>s.pid===PID); return m&&!m.spec;},{timeout:8000});
    await sleep(600);
    await readyAll([A,B,D,E]);
    // the tab going hidden calls dropOut() at any moment, the countdown included
    await B.waitForFunction(()=>!!(G&&!G.over&&COUNT>0),{timeout:20000});
    await B.evaluate(()=>{G.die();});
    await waitCard(B).catch(()=>{});
    ok("a countdown death still gets its result card",await cardOn(B),
      await B.evaluate(()=>({count:COUNT,G:G?{over:G.over,pending:G.pending,resolved:G.resolved}:null})));
    await allPlaying([A,D,E]);
    await D.evaluate(()=>{G.die();});
    await sleep(400);
    await E.evaluate(()=>{G.die();});
    await A.waitForFunction(()=>RoomClient.view().seats.some(s=>s.pid===PID&&s.w>3),{timeout:15000}).catch(()=>{});
    ok("the round it happened in still resolved",await A.evaluate(()=>{
      const m=RoomClient.view().seats.find(s=>s.pid===PID); return !!m&&m.w===4;}),(await st(A)).wins);

    console.log("\n"+(fails?"FAILED "+fails+"/"+checks:"ALL "+checks+" CHECKS PASSED"));
  }catch(e){ console.log("\nERROR "+e.message+"\n"+e.stack); fails++; }
  await browser.close(); srv.kill();
  process.exit(fails?1:0);
})();
