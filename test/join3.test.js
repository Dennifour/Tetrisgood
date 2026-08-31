// Why a third player cannot get into a room that already holds two.
// Runs each scenario against a local stand-in for the Firebase RTDB REST API
// (test/fbserver.js), with an optional injected latency on every write so the
// compare-and-swap in RoomClient.join() gets a real window to lose.
//   NODE_PATH=<playwright dir> CHROME=<chromium binary> node test/join3.test.js
const {chromium}=require("playwright");
const {spawn}=require("child_process");
const PORT=8734, BASE="http://localhost:"+PORT;
const HTML=process.argv[2]||__dirname+"/../Tetris2_Beta.html";
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let fails=0, checks=0;
const T0=Date.now();
const sect=n=>console.log("\n== "+n+" ==  ["+((Date.now()-T0)/1000).toFixed(0)+"s]");
const ok=(n,c,x)=>{checks++;c?console.log("  PASS  "+n):(fails++,console.log("  FAIL  "+n+(x!==undefined?"  -> "+JSON.stringify(x):"")))};

(async()=>{
  const srv=spawn("node",[__dirname+"/fbserver.js",String(PORT),HTML],{stdio:"inherit"});
  await sleep(600);
  const browser=await chromium.launch({executablePath:process.env.CHROME||undefined,
    args:["--disable-background-timer-throttling","--disable-backgrounding-occluded-windows","--disable-renderer-backgrounding"]});

  // skewMs shifts this page's whole clock, the way two real devices differ
  const mk=async (name,skewMs,lagMs)=>{
    const ctx=await browser.newContext({viewport:{width:1000,height:720}});
    await ctx.addInitScript(([n,base,skew,lag])=>{
      localStorage.setItem("tfx:fbUrl",JSON.stringify(base+"/db"));
      localStorage.setItem("tfx:name",JSON.stringify(n));
      localStorage.setItem("tfx:touch",JSON.stringify("off"));
      localStorage.setItem("tfx:touchSet",JSON.stringify(true));
      localStorage.setItem("tfx:lang",JSON.stringify("en"));
      if(skew){ const real=Date.now.bind(Date); Date.now=()=>real()+skew; }
      if(lag){
        const f=window.fetch.bind(window);
        window.fetch=(u,o)=>new Promise(r=>setTimeout(()=>r(f(u,o)),lag));
      }
    },[name,BASE,skewMs||0,lagMs||0]);
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
  // what the player sees after tapping the room row, error text included
  const tapJoin=async (p,id)=>{
    const seen=await p.waitForSelector('[data-room="'+id+'"]',{timeout:20000}).then(()=>true,()=>false);
    if(!seen) return {cur:await p.evaluate(()=>UI.cur), room:false, listed:false, seats:0,
      hint:await p.evaluate(()=>(($("#srv-hint")||{}).textContent)||"")};
    await p.click('[data-room="'+id+'"]');
    await p.waitForFunction(()=>UI.cur==="#v-room"&&RoomClient.on,{timeout:12000}).catch(()=>{});
    return p.evaluate(()=>({cur:UI.cur, room:RoomClient.on, listed:true,
      hint:($("#srv-hint")||{}).textContent||"", seats:RoomClient.on?RoomClient.view().seats.length:0}));
  };
  const seatsOf=p=>p.evaluate(()=>RoomClient.on
    ? RoomClient.view().seats.map(s=>s.n+(s.fresh?"":"[STALE]"))
    : null);
  const listed=p=>p.evaluate(()=>[...document.querySelectorAll("[data-room]")].map(b=>b.textContent));

  try{
    sect("two sit in a room, then a third taps it");
    const A=await mk("ALICE"), B=await mk("BOB");
    for(const p of [A,B]) await toLobby(p);
    await A.click("#b-mkroom");
    await A.waitForFunction(()=>UI.cur==="#v-room"&&RoomClient.on);
    const room=await A.evaluate(()=>RoomClient.id);
    console.log("  room "+room);
    await tapJoin(B,room);
    ok("BOB got in",(await B.evaluate(()=>RoomClient.on)));
    // long enough that every seat has heartbeated several times and the
    // original lobby entry has aged past LOBBY_TTL
    console.log("  ...letting the room sit for 25s (SEAT_TTL and LOBBY_TTL are 20s)");
    await sleep(25000);
    ok("ALICE still sees both seats fresh",(await seatsOf(A)).join()==="ALICE,BOB",await seatsOf(A));
    const C=await mk("CARL");
    await toLobby(C);
    ok("the room is still listed for CARL",(await listed(C)).length===1,await listed(C));
    const r=await tapJoin(C,room);
    ok("CARL got into the room",r.room&&r.cur==="#v-room",r);
    ok("CARL sees all three seats",r.seats===3,{seats:r.seats,list:await seatsOf(C)});
    await sleep(1500);
    ok("ALICE sees all three seats",(await seatsOf(A)).length===3,await seatsOf(A));
    ok("BOB sees all three seats",(await seatsOf(B)).length===3,await seatsOf(B));

    sect("a third taps in while the other two are mid-round");
    const D=await mk("DAVE");
    await toLobby(D);
    for(const p of [A,B,C]) await p.click("#b-ready");
    for(const p of [A,B,C]) await p.waitForFunction(()=>!!(G&&!G.over&&COUNT===0),{timeout:25000}).catch(()=>{});
    const r2=await tapJoin(D,room);
    ok("DAVE got in mid-round",r2.room&&r2.cur==="#v-room",r2);
    await sleep(1200);
    ok("ALICE sees the fourth seat",(await seatsOf(A)).length===4,await seatsOf(A));
    for(const p of [A,B,C]) await p.evaluate(()=>{G&&!G.over&&G.die();});
    await sleep(2500);

    // a fresh room: the one above is already at MAX_SEATS, and a full room is
    // a different rejection entirely
    const host=async name=>{
      const h=await mk(name); await toLobby(h);
      await h.click("#b-mkroom");
      await h.waitForFunction(()=>UI.cur==="#v-room"&&RoomClient.on,{timeout:15000});
      return [h,await h.evaluate(()=>RoomClient.id)];
    };

    sect("a third whose clock runs 45s ahead of the other two");
    const [G1,room2]=await host("GINA");
    const H=await mk("HANK"); await toLobby(H); await tapJoin(H,room2);
    ok("two are seated in the new room",(await seatsOf(G1)).length===2,await seatsOf(G1));
    const E=await mk("EVE",45000);
    await toLobby(E);
    const r3=await tapJoin(E,room2);
    console.log("  EVE joined:",JSON.stringify(r3));
    ok("the room is listed for EVE at all",r3.listed,r3);
    ok("EVE got a seat",r3.room,r3);
    ok("EVE sees the others, not an empty room",(await seatsOf(E)||[]).length===3,await seatsOf(E));
    await sleep(1500);
    ok("GINA sees EVE as a live seat",
      (await seatsOf(G1)||[]).some(x=>x.startsWith("EVE")&&!x.includes("STALE")),await seatsOf(G1));

    sect("a third whose clock runs 45s behind the other two");
    const [G2,room3]=await host("IRIS");
    const J=await mk("JUDE"); await toLobby(J); await tapJoin(J,room3);
    const F=await mk("FRANK",-45000);
    await toLobby(F);
    const r4=await tapJoin(F,room3);
    console.log("  FRANK joined:",JSON.stringify(r4));
    ok("the room is listed for FRANK at all",r4.listed,r4);
    ok("FRANK got a seat",r4.room,r4);
    ok("FRANK sees all three seats",(await seatsOf(F)||[]).length===3,await seatsOf(F));
    await sleep(1500);
    ok("IRIS sees FRANK as a live seat",
      (await seatsOf(G2)||[]).some(x=>x.startsWith("FRANK")&&!x.includes("STALE")),await seatsOf(G2));
    ok("a skewed seat can still be readied into a round",
      await G2.evaluate(()=>RoomClient.view().seats.filter(s=>s.fresh).length===3),await seatsOf(G2));

    console.log("\n"+(fails?"FAILED "+fails+"/"+checks:"ALL "+checks+" CHECKS PASSED"));
  }catch(e){ console.log("\nERROR "+e.message+"\n"+e.stack); fails++; }
  await browser.close(); srv.kill();
  process.exit(fails?1:0);
})();
