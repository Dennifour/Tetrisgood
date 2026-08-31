// Marathon Zone rule: toggled at the Play menu, a topout holds, dusts, and
// resets instead of ending the run. No signaling server needed (single-player).
//   NODE_PATH=<playwright dir> CHROME=<chromium binary> node test/zone.test.js
const {chromium}=require("playwright");
const HTML=process.argv[2]||__dirname+"/../Tetris2_Beta.html";
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let fails=0,checks=0;
const ok=(n,c,x)=>{checks++;c?console.log("  PASS  "+n):(fails++,console.log("  FAIL  "+n+(x!==undefined?"  -> "+JSON.stringify(x):"")))};

(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME||undefined});
 const page=await browser.newPage();
 page.on("pageerror",e=>{ console.log("  !! pageerror "+e.message); fails++; });
 await page.goto("file://"+HTML,{waitUntil:"load"});

 const goSolo=async()=>{
  await page.click('[data-go="play"]');
  await page.waitForFunction(()=>UI.cur==="#v-play");
  await page.click('[data-go="solo"]');
  await page.waitForFunction(()=>G && !G.over && COUNT<=0 && !startHoldEnd,{timeout:6000});
  await sleep(100);
 };
 const exitToMenu=async()=>{
  await page.evaluate(()=>{ if(UI.pauseOpen) UI.closePauseMenu(); UI.quitToMenu(); });
  await page.waitForFunction(()=>UI.cur==="#v-home",{timeout:5000});
 };

 try{
  console.log("\n== the toggle exists on the Play menu, off by default ==");
  await page.click('[data-go="play"]');
  await page.waitForFunction(()=>UI.cur==="#v-play");
  ok("zone toggle is off by default",!(await page.evaluate(()=>CFG.zoneMode)));
  ok("toggle is not marked on",!(await page.evaluate(()=>$("#s-zonemode").classList.contains("on"))));
  await page.click("#s-zonemode");
  ok("clicking it flips CFG.zoneMode",await page.evaluate(()=>CFG.zoneMode===true));
  ok("and persists to storage",await page.evaluate(()=>JSON.parse(localStorage.getItem("tfx:zoneMode"))===true));
  await page.evaluate(()=>UI.show("#v-home"));

  console.log("\n== with the toggle on, a fresh Marathon game is in Zone ==");
  await goSolo();
  ok("G.zone is true",await page.evaluate(()=>G.zone===true));
  ok("not zoning yet -- nothing has topped out",!(await page.evaluate(()=>G.zoning)));

  console.log("\n== a real topout (spawn blocked) enters Zone instead of ending ==");
  await page.evaluate(()=>{
   for(let y=0;y<=BUFFER;y++) for(let x=0;x<COLS;x++) G.board[y][x]="I";
   G.spawn();
  });
  await sleep(80);
  let st=await page.evaluate(()=>({over:G.over,zoning:!!G.zoning,phase:G.zoning&&G.zoning.phase,cells:G.zoning&&G.zoning.cells.length}));
  ok("the game is not over",st.over===false,st);
  ok("a zoning reset started",st.zoning,st);
  ok("it begins in the hold phase",st.phase==="hold",st);
  ok("the filled rows were captured as dust cells",st.cells>0,st);
  ok("no game-over card appeared",!(await page.evaluate(()=>document.body.classList.contains("over"))));

  console.log("\n== the hold phase freezes play and does not touch score yet ==");
  const scoreBefore=await page.evaluate(()=>{ G.score=12345; return G.score; });
  await sleep(300);   // comfortably under ZONE_HOLD_MS=1000, even with scheduling jitter
  st=await page.evaluate(()=>({phase:G.zoning?G.zoning.phase:"(already gone)",score:G.score,board:G.board.flat().some(c=>!!c)}));
  ok("still holding, ~0.4s in (< 1s hold)",st.phase==="hold",st);
  ok("score has not been touched during the hold",st.score===scoreBefore,st);
  ok("the topped-out board is still there to look at",st.board,st);

  console.log("\n== the hold gives way to dust, then to a clean reset ==");
  await page.waitForFunction(()=>G.zoning && G.zoning.phase==="dust",{timeout:3000});
  st=await page.evaluate(()=>({particles:G.zoning.particles.length,score:G.score}));
  ok("dust particles were spawned",st.particles>0,st);
  ok("score is still untouched mid-dust",st.score===scoreBefore,st);
  await page.waitForFunction(()=>G.zoning===null,{timeout:3000});
  st=await page.evaluate(()=>({
   score:G.score, lines:G.lines, level:G.level, over:G.over,
   boardEmpty:!G.board.flat().some(c=>!!c), hasCur:!!G.cur,
   hold:G.hold, combo:G.combo
  }));
  ok("score reset to 0",st.score===0,st);
  ok("lines and level reset",st.lines===0&&st.level===1,st);
  ok("the board is empty",st.boardEmpty,st);
  ok("a fresh piece is in play",st.hasCur,st);
  ok("the run never actually ended",st.over===false,st);
  ok("hold slot cleared",st.hold===null,st);
  ok("combo state reset",st.combo===-1,st);
  ok("still no game-over card",!(await page.evaluate(()=>document.body.classList.contains("over"))));

  console.log("\n== a topout with a real score banks a Marathon record ==");
  await page.evaluate(()=>{ REC.marathon=0; });
  await page.evaluate(()=>{ G.score=777; });
  await page.evaluate(()=>{ G.die(); });
  await page.waitForFunction(()=>G.zoning && G.zoning.beat===true,{timeout:2000});
  ok("the run is flagged as a new best",await page.evaluate(()=>G.zoning.beat===true));
  ok("REC.marathon was actually updated",await page.evaluate(()=>REC.marathon===777));
  await page.waitForFunction(()=>G.zoning===null,{timeout:3000});

  console.log("\n== zoning shows an overlay, not the game-over screen ==");
  await page.evaluate(()=>{ G.die(); });
  await sleep(150);
  const corner=await page.evaluate(()=>{
   const c=document.createElement("canvas"); c.width=cv.width; c.height=cv.height;
   c.getContext("2d").drawImage(cv,0,0);
   const d=c.getContext("2d").getImageData(0,0,cv.width,cv.height).data;
   let lit=0; for(let i=0;i<d.length;i+=4) if(d[i]+d[i+1]+d[i+2]>40) lit++;
   return lit;
  });
  ok("something is drawn over the well during the hold",corner>1000,corner);
  ok("the game-over overlay never appears",!(await page.evaluate(()=>document.body.classList.contains("over"))));
  await page.waitForFunction(()=>G.zoning===null,{timeout:3000});

  console.log("\n== music (if it were on) is never touched by a Zone reset ==");
  // Radio itself is covered by test/radio.test.js; this only re-confirms the
  // one thing Zone could plausibly break: that a topout never calls Radio.stop
  const stopped=await page.evaluate(()=>{
   let called=false;
   const orig=Radio.stop;
   Radio.stop=()=>{ called=true; orig.call(Radio); };
   G.die();
   return new Promise(res=>setTimeout(()=>{ Radio.stop=orig; res(called); },ZONE_HOLD_MS+ZONE_DUST_MS+200));
  });
  ok("Radio.stop is never called by a zoning cycle",!stopped);

  console.log("\n== with the toggle off, a topout ends the run normally (no regression) ==");
  await exitToMenu();
  await page.click('[data-go="play"]');
  await page.waitForFunction(()=>UI.cur==="#v-play");
  await page.click("#s-zonemode");   // back off
  ok("toggle is off again",!(await page.evaluate(()=>CFG.zoneMode)));
  await page.evaluate(()=>UI.show("#v-home"));
  await goSolo();
  ok("a fresh non-zone game has G.zone false",!(await page.evaluate(()=>G.zone)));
  await page.evaluate(()=>{ G.die(); });
  await page.waitForFunction(()=>G && G.over,{timeout:3000});
  st=await page.evaluate(()=>({over:G.over,zoning:!!G.zoning}));
  ok("the game ends normally",st.over===true&&!st.zoning,st);
  await page.waitForFunction(()=>document.body.classList.contains("over"),{timeout:3000});
  ok("the normal game-over card appears",await page.evaluate(()=>document.body.classList.contains("over")));

  console.log("\n"+(fails?"FAILED "+fails+"/"+checks:"ALL "+checks+" CHECKS PASSED"));
 }catch(e){ console.log("\nERROR "+e.message+"\n"+e.stack); fails++; }
 await browser.close();
 process.exit(fails?1:0);
})();
