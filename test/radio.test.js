// Marathon radio: ID3/filename tag reading, shuffle + gap playback lifecycle,
// the exact fall-start trigger, survival through game over, and the stop on
// "exit to menu". No signaling server needed -- this feature is single-player.
//   NODE_PATH=<playwright dir> CHROME=<chromium binary> node test/radio.test.js
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

 try{
  console.log("\n== readTags: ID3v2.3 frames ==");
  const v23=await page.evaluate(async()=>{
   const enc=(id,str)=>{
    const bytes=[0,...Array.from(str).map(c=>c.charCodeAt(0))];   // encoding byte 0 = Latin1
    const n=bytes.length;
    return [...Array.from(id).map(c=>c.charCodeAt(0)), (n>>24)&255,(n>>16)&255,(n>>8)&255,n&255, 0,0, ...bytes];
   };
   const tit2=enc("TIT2","Hello There"), tpe1=enc("TPE1","Some Artist");
   const framesLen=tit2.length+tpe1.length;
   const syncsafe=n=>[(n>>21)&0x7f,(n>>14)&0x7f,(n>>7)&0x7f,n&0x7f];
   const bytes=new Uint8Array([0x49,0x44,0x33, 3,0, 0, ...syncsafe(framesLen), ...tit2, ...tpe1]);
   const f=new File([bytes],"unrelated-filename.mp3");
   return await readTags(f);
  });
  ok("title read from TIT2",v23.title==="Hello There",v23);
  ok("artist read from TPE1",v23.artist==="Some Artist",v23);

  console.log("\n== readTags: ID3v2.4 (syncsafe frame sizes) + trailing padding ==");
  const v24=await page.evaluate(async()=>{
   const enc=(id,str)=>{
    const bytes=[0,...Array.from(str).map(c=>c.charCodeAt(0))];
    const n=bytes.length;
    const ss=[(n>>21)&0x7f,(n>>14)&0x7f,(n>>7)&0x7f,n&0x7f];
    return [...Array.from(id).map(c=>c.charCodeAt(0)), ...ss, 0,0, ...bytes];
   };
   const tit2=enc("TIT2","V4 Title"), tpe1=enc("TPE1","V4 Artist");
   const framesLen=tit2.length+tpe1.length;
   const syncsafe=n=>[(n>>21)&0x7f,(n>>14)&0x7f,(n>>7)&0x7f,n&0x7f];
   // padding after the real frames, plus junk beyond the declared tag size --
   // the "end" bound must stop at the tag's own size, not run into it
   const pad=new Array(20).fill(0);
   const bytes=new Uint8Array([0x49,0x44,0x33, 4,0, 0, ...syncsafe(framesLen+pad.length), ...tit2, ...tpe1, ...pad, 1,2,3,4,5]);
   const f=new File([bytes],"x.mp3");
   return await readTags(f);
  });
  ok("v2.4 title read (syncsafe sizes)",v24.title==="V4 Title",v24);
  ok("v2.4 artist read (syncsafe sizes)",v24.artist==="V4 Artist",v24);

  console.log("\n== readTags: ID3v1 fallback (no v2 header) ==");
  const v1=await page.evaluate(async()=>{
   const str=(s,n)=>{ const a=new Array(n).fill(0); for(let i=0;i<s.length&&i<n;i++) a[i]=s.charCodeAt(i); return a; };
   const tag=[0x54,0x41,0x47, ...str("V1 Title",30), ...str("V1 Artist",30), ...new Array(128-3-60).fill(0)];
   const bytes=new Uint8Array([9,9,9,9, ...tag]);   // 4 junk bytes so the ID3v1 block is the LAST 128 bytes, not the first
   const f=new File([bytes],"whatever-name.mp3");
   return await readTags(f);
  });
  ok("ID3v1 title",v1.title==="V1 Title",v1);
  ok("ID3v1 artist",v1.artist==="V1 Artist",v1);

  console.log("\n== readTags: filename fallback ==");
  const noTag=await page.evaluate(async()=>{
   const f=new File([new Uint8Array([1,2,3,4])],"Artist Name - Song Title.mp3");
   return await readTags(f);
  });
  ok("filename split on ' - '",noTag.title==="Song Title"&&noTag.artist==="Artist Name",noTag);
  const noDash=await page.evaluate(async()=>{
   const f=new File([new Uint8Array([1,2,3,4])],"JustATitle.mp3");
   return await readTags(f);
  });
  ok("filename with no dash is a bare title",noDash.title==="JustATitle"&&noDash.artist==="",noDash);

  console.log("\n== folder scan: extension filter, shuffle ==");
  await page.evaluate(async()=>{
   const files=[
    new File([new Uint8Array([1,2,3])],"Alice Artist - Song One.mp3",{type:"audio/mpeg"}),
    new File([new Uint8Array([1,2,3])],"Bob Band - Second Track.mp3",{type:"audio/mpeg"}),
    new File([new Uint8Array([1,2,3])],"Solo Title Only.wav",{type:"audio/wav"}),
    new File([new Uint8Array([1,2,3])],"readme.txt",{type:"text/plain"}),      // must be excluded
    new File([new Uint8Array([1,2,3])],"cover.jpg",{type:"image/jpeg"}),       // must be excluded
   ];
   await Radio.useFileList(files);
  });
  const scanned=await page.evaluate(()=>({n:Radio.tracks.length, names:Radio.tracks.map(t=>t.file.name)}));
  ok("only the 3 audio files were kept",scanned.n===3,scanned);
  const shuffled=await page.evaluate(()=>{
   Radio.shuffle();
   return Radio.queue.map(t=>t.file.name);
  });
  ok("shuffle produces a permutation of all 3 tracks",
    shuffled.length===3 && new Set(shuffled).size===3 &&
    scanned.names.every(n=>shuffled.includes(n)), {scanned:scanned.names,shuffled});

  console.log("\n== a track ending waits out the full 3s gap before the next one ==");
  // exercised on the gap timer directly, not through a real <audio> decode --
  // these fixture files are garbage bytes, so leaving it to play() would race
  // whatever the browser's own decode-failure timing happens to be
  await page.evaluate(()=>{
   clearTimeout(Radio.gapTimer); Radio.gapTimer=0;
   Radio.el.pause();
   Radio.qi=0; Radio.active=true;
  });
  await page.evaluate(()=>{ Radio.onEnded(); });
  await sleep(200);
  ok("nothing is queued to play immediately after a track ends",await page.evaluate(()=>Radio.el.paused));
  await sleep(2400);   // ~2.6s since onEnded -- still well inside the 3s gap
  let gap=await page.evaluate(()=>({paused:Radio.el.paused,qi:Radio.qi}));
  ok("still silent and un-advanced at ~2.6s",gap.paused && gap.qi===0,gap);
  await sleep(900);    // ~3.5s total -- the gap has elapsed
  gap=await page.evaluate(()=>({paused:Radio.el.paused,qi:Radio.qi}));
  ok("advanced to the next track once the 3s gap elapsed",gap.qi===1,gap);
  await page.evaluate(()=>{ Radio.stop(); });   // this test drove Radio directly; leave it clean for what follows

  console.log("\n== settings: toggle and volume wiring ==");
  await page.click('[data-go="settings"]');
  await page.click('[data-tab="audio"]');
  await page.waitForSelector("#b-radiofolder");
  const hint=await page.textContent("#radio-hint");
  ok("panel reports the scanned track count",/3/.test(hint),hint);
  ok("folder button offers to change, not pick, once tracks exist",
    (await page.textContent("#b-radiofolder"))!=="",);
  await page.evaluate(()=>{ CFG.radioVol=55; Radio.setVolume(CFG.radioVol); });
  ok("Radio.el.volume follows CFG.radioVol",Math.abs(await page.evaluate(()=>Radio.el.volume)-0.55)<0.01);
  await page.evaluate(()=>UI.show("#v-home"));

  console.log("\n== music starts exactly when tetrominoes start to fall ==");
  await page.click('[data-go="play"]');
  await page.waitForFunction(()=>UI.cur==="#v-play");
  await page.click('[data-go="solo"]');
  await page.waitForFunction(()=>typeof G!=="undefined" && G!==null,{timeout:5000});
  await sleep(300);
  let st=await page.evaluate(()=>({COUNT,startHoldEnd,active:Radio.active,paused:Radio.el.paused,meta:Radio.meta}));
  ok("no music during the 3-2-1 countdown",!st.active && st.paused,st);
  ok("no now-playing text during the countdown",!st.meta,st);
  await page.waitForFunction(()=>G && !G.over && COUNT<=0 && !startHoldEnd,{timeout:6000});
  await sleep(150);
  st=await page.evaluate(()=>({active:Radio.active,paused:Radio.el.paused,meta:Radio.meta,armed:G.radioArmed}));
  ok("music is active once the piece is actually falling",st.active,st);
  ok("radioArmed is consumed (fires once per game)",st.armed===false,st);
  ok("now-playing metadata is set",!!(st.meta&&st.meta.title),st);

  console.log("\n== bottom-right HUD text ==");
  const corner=await page.evaluate(()=>{
   const c=document.createElement("canvas"); c.width=cv.width; c.height=cv.height;
   c.getContext("2d").drawImage(cv,0,0);
   const x=c.getContext("2d");
   const d=x.getImageData(Math.max(0,cv.width-140),Math.max(0,cv.height-40),140,40).data;
   let lit=0; for(let i=0;i<d.length;i+=4) if(d[i]+d[i+1]+d[i+2]>30) lit++;
   return lit;
  });
  ok("something is drawn in the bottom-right corner while a track is playing",corner>5,corner);

  console.log("\n== game over: music keeps playing ==");
  await page.evaluate(()=>{ G.die(); });
  await page.waitForFunction(()=>G && G.over,{timeout:8000});
  await sleep(200);
  st=await page.evaluate(()=>({active:Radio.active,paused:Radio.el.paused,over:G.over}));
  ok("game is over",st.over,st);
  ok("music is still active after game over",st.active && !st.paused,st);

  console.log("\n== exit to menu stops the radio ==");
  await page.waitForFunction(()=>document.body.classList.contains("over"),{timeout:3000}).catch(()=>{});
  await page.click("#go-menu");
  await page.waitForFunction(()=>UI.cur==="#v-home",{timeout:5000});
  await sleep(150);
  st=await page.evaluate(()=>({active:Radio.active,paused:Radio.el.paused,meta:Radio.meta}));
  ok("radio stopped",!st.active && st.paused,st);
  ok("now-playing metadata cleared",!st.meta,st);

  console.log("\n== restart re-shuffles rather than staying silent ==");
  await page.click('[data-go="play"]');
  await page.click('[data-go="solo"]');
  await page.waitForFunction(()=>G && !G.over && COUNT<=0 && !startHoldEnd,{timeout:6000});
  await sleep(150);
  ok("music restarted for the fresh game",await page.evaluate(()=>Radio.active));
  await page.evaluate(()=>UI.togglePause());
  await page.waitForFunction(()=>UI.pauseOpen);
  await page.click("#p-restart");
  await page.waitForFunction(()=>G && !G.over && COUNT<=0 && !startHoldEnd,{timeout:6000});
  await sleep(150);
  st=await page.evaluate(()=>({active:Radio.active,armed:G.radioArmed}));
  ok("radio is still (or again) playing after a mid-pause restart",st.active,st);
  ok("the new game's own armed flag was consumed",st.armed===false,st);

  console.log("\n== toggling music off stops it immediately, and it stays off ==");
  await page.evaluate(()=>{ CFG.radioOn=false; Radio.stop(); });
  st=await page.evaluate(()=>({active:Radio.active,paused:Radio.el.paused}));
  ok("turning the setting off stops playback right away",!st.active && st.paused,st);
  await page.evaluate(()=>UI.togglePause());
  await page.click("#p-restart");
  await page.waitForFunction(()=>G && !G.over && COUNT<=0 && !startHoldEnd,{timeout:6000});
  await sleep(200);
  ok("no music starts while the setting is off",!(await page.evaluate(()=>Radio.active)));
  await page.evaluate(()=>{ CFG.radioOn=true; });

  console.log("\n== radio never plays outside Marathon ==");
  await page.evaluate(()=>UI.quitToMenu());
  await page.waitForFunction(()=>UI.cur==="#v-home");
  await page.click('[data-go="play"]');
  await page.click('[data-go="sprint"]');
  await page.waitForFunction(()=>typeof G!=="undefined"&&G!==null&&G.mode==="sprint",{timeout:5000});
  await page.waitForFunction(()=>G && !G.over && COUNT<=0 && !startHoldEnd,{timeout:6000});
  await sleep(300);
  ok("sprint mode never starts the radio",!(await page.evaluate(()=>Radio.active)));

  console.log("\n"+(fails?"FAILED "+fails+"/"+checks:"ALL "+checks+" CHECKS PASSED"));
 }catch(e){ console.log("\nERROR "+e.message+"\n"+e.stack); fails++; }
 await browser.close();
 process.exit(fails?1:0);
})();
