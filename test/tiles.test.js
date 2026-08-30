// Default tile skins: every skin loads, each matches its piece's classic
// colour, garbage takes the grey one, and custom uploads still win.
//   NODE_PATH=<playwright dir> CHROME=<chromium binary> node test/tiles.test.js
const {chromium}=require("playwright");
const {spawn}=require("child_process");
const PORT=8733, BASE="http://localhost:"+PORT;
const HTML=process.argv[2]||__dirname+"/../Tetris2_Beta.html";
const SHOT=process.env.SHOTDIR||__dirname;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let fails=0,checks=0;
const ok=(n,c,x)=>{checks++;c?console.log("  PASS  "+n):(fails++,console.log("  FAIL  "+n+(x!==undefined?"  -> "+JSON.stringify(x):"")))};

(async()=>{
 const srv=spawn("node",[__dirname+"/fbserver.js",String(PORT),HTML],{stdio:"ignore"});
 await sleep(600);
 const browser=await chromium.launch({executablePath:process.env.CHROME||undefined});
 const ctx=await browser.newContext({viewport:{width:1000,height:820}});
 const p=await ctx.newPage();
 p.on("pageerror",e=>{console.log("  !! "+e.message);fails++;});
 await p.goto(BASE,{waitUntil:"load"});
 try{
  console.log("\n== built-in skins load ==");
  await p.waitForFunction(()=>TILE_SKINS.every(t=>PIECE_TILE[t]&&PIECE_TILE[t].complete),{timeout:10000});
  const loaded=await p.evaluate(()=>TILE_SKINS.map(t=>({t,
    ok:!!(PIECE_TILE[t]&&PIECE_TILE[t].complete&&PIECE_TILE[t].naturalWidth),
    w:PIECE_TILE[t]&&PIECE_TILE[t].naturalWidth, h:PIECE_TILE[t]&&PIECE_TILE[t].naturalHeight,
    isDefault:PIECE_TILE[t]&&PIECE_TILE[t].src===DEFAULT_TILES[t]})));
  ok("all 8 skins present and decoded",loaded.length===8&&loaded.every(l=>l.ok),loaded.filter(l=>!l.ok));
  ok("all are 100x100",loaded.every(l=>l.w===100&&l.h===100),loaded.map(l=>l.t+":"+l.w+"x"+l.h));
  ok("all come from DEFAULT_TILES",loaded.every(l=>l.isDefault),loaded.filter(l=>!l.isDefault));
  // saveCfg() writes every CFG key, so "tfx:tiles" exists as {}; what matters
  // is that no default tile data is stored -- they live in the page, not storage
  ok("no default tile data in storage",await p.evaluate(()=>
    Object.keys(CFG.tiles).length===0 && JSON.stringify(JSON.parse(localStorage.getItem("tfx:tiles")||"{}"))==="{}"));

  console.log("\n== each skin matches its piece's classic colour ==");
  const hues=await p.evaluate(()=>{
   const c=document.createElement("canvas"); c.width=c.height=100;
   const x=c.getContext("2d");
   const hs=rgb=>{const[r,g,b]=rgb.map(v=>v/255),mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn;
    let h=0; if(d){h=mx===r?((g-b)/d+(g<b?6:0)):mx===g?((b-r)/d+2):((r-g)/d+4);h*=60;}
    return {h,s:mx?d/mx:0};};
   const hex=v=>[parseInt(v.slice(1,3),16),parseInt(v.slice(3,5),16),parseInt(v.slice(5,7),16)];
   return TILE_SKINS.map(t=>{
    x.clearRect(0,0,100,100); x.drawImage(PIECE_TILE[t],0,0,100,100);
    const d=x.getImageData(50,50,1,1).data;
    return {t, tile:hs([d[0],d[1],d[2]]), flat:hs(hex(PIECE_COLOR[t]))};
   });
  });
  // nearest-hue assignment rather than an absolute tolerance: what matters is
  // that no two skins are swapped, and the greens differ in warmth by ~37 deg
  const dh=(a,b)=>Math.min(Math.abs(a-b),360-Math.abs(a-b));
  const col=hues.filter(r=>r.t!=="G");
  for(const r of col){
   const nearest=col.slice().sort((a,b)=>dh(a.tile.h,r.flat.h)-dh(b.tile.h,r.flat.h))[0];
   ok(r.t+" gets the skin nearest PIECE_COLOR."+r.t+" (Δ"+dh(r.tile.h,r.flat.h).toFixed(0)+"°)",
      nearest.t===r.t,{want:r.t,got:nearest.t,tileHue:r.tile.h.toFixed(0),flatHue:r.flat.h.toFixed(0)});
  }
  ok("G is grey (no hue)",hues.find(r=>r.t==="G").tile.s<0.06,hues.find(r=>r.t==="G"));
  ok("every colour skin is saturated",col.every(r=>r.tile.s>0.3),col.map(r=>r.t+":"+r.tile.s.toFixed(2)));

  console.log("\n== tiles actually draw ==");
  await p.evaluate(()=>{
   startGame("solo"); COUNT=0; countEnd=0;
   // pausing would drop the dark overlay over the well, and a full row would
   // be cleared on the next lock, so leave the last column open
   const order=["I","J","L","O","S","T","Z","G"];
   order.forEach((t,i)=>{ for(let x=0;x<COLS-1;x++) G.board[ROWS-1-i][x]=t; });
  });
  await sleep(500);
  const drawn=await p.evaluate(()=>{
   const cv=document.querySelector("#cv"), x=cv.getContext("2d");
   // one sample per stacked row, in canvas pixels
   const c=L.cell*DPR, bx=L.bx*DPR, by=L.by*DPR;
   return [0,1,2,3,4,5,6,7].map(i=>{
    const px=Math.round(bx+c*4.5), py=Math.round(by+c*(20-1-i)+c*0.5);
    const d=x.getImageData(px,py,1,1).data; return [d[0],d[1],d[2]];
   });
  });
  ok("eight stacked rows all painted",drawn.every(c=>c[0]+c[1]+c[2]>40),drawn);
  ok("rows are visibly different colours",new Set(drawn.map(c=>c.join(","))).size===8,drawn);
  await p.screenshot({path:SHOT+"/shot-tiles.png"});

  console.log("\n== a custom upload still wins, reset returns to default ==");
  await p.evaluate(()=>{
   const c=document.createElement("canvas"); c.width=c.height=8;
   const x=c.getContext("2d"); x.fillStyle="#ff00ff"; x.fillRect(0,0,8,8);
   CFG.tiles.I=c.toDataURL("image/png"); store.set("tiles",CFG.tiles); loadTile("I",CFG.tiles.I);
  });
  await p.waitForFunction(()=>PIECE_TILE.I.complete&&PIECE_TILE.I.naturalWidth===8);
  ok("custom tile overrides the default",await p.evaluate(()=>PIECE_TILE.I.src!==DEFAULT_TILES.I));
  ok("other pieces keep their defaults",await p.evaluate(()=>PIECE_TILE.J.src===DEFAULT_TILES.J));
  await p.evaluate(()=>{ delete CFG.tiles.I; store.set("tiles",CFG.tiles); loadTile("I",null); });
  await p.waitForFunction(()=>PIECE_TILE.I.src===DEFAULT_TILES.I,{timeout:5000}).catch(()=>{});
  ok("reset restores the built-in skin, not a flat colour",await p.evaluate(()=>PIECE_TILE.I.src===DEFAULT_TILES.I));

  console.log("\n"+(fails?"FAILED "+fails+"/"+checks:"ALL "+checks+" CHECKS PASSED"));
 }catch(e){ console.log("\nERROR "+e.message+"\n"+e.stack); fails++; }
 await browser.close(); srv.kill(); process.exit(fails?1:0);
})();
