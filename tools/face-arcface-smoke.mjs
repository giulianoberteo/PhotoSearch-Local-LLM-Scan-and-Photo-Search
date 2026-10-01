// Live check of the ArcFace recognition pipeline, which the self-test cannot
// cover: it stubs the engine rather than downloading 13 MB of weights.
//
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
//     --headless=new --remote-debugging-port=9222 \
//     --user-data-dir=/tmp/arc-smoke --allow-file-access-from-files about:blank &
//   node tools/face-arcface-smoke.mjs "file://$PWD/PhotoSearch.html"
//
// Expected: detected 1, hasMesh true, cropMade true, cropSize 112x112,
// embedDim 512 and a NON-ZERO embedNorm. A zero norm or a missing crop means
// alignment broke, which is what makes grouping useless.
const sleep = ms => new Promise(r => setTimeout(r, ms));
let list=null;
for (let i=0;i<60;i++){ try { list=await (await fetch("http://127.0.0.1:9222/json/list")).json(); break; } catch { await sleep(250);} }
const ws = new WebSocket(list.find(t=>t.type==="page").webSocketDebuggerUrl);
let id=0; const pending=new Map();
ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}};
const send=(m,p)=>new Promise(r=>{const i=++id;pending.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:p||{}}));});
await new Promise(r=>ws.onopen=r);
await send("Runtime.enable"); await send("Page.enable");
await send("Page.navigate",{url:process.argv[2]});
await sleep(2500);
const ev = async expr => {
  const r = await send("Runtime.evaluate",{expression:expr,returnByValue:true,awaitPromise:true});
  if (r.result?.exceptionDetails) return "THREW: "+(r.result.exceptionDetails.exception?.description||"").slice(0,300);
  return r.result?.result?.value;
};
console.log(await ev(`
 (async () => {
  const out = {};
  try {
    S.faces.embedder = "arcface";
    out.engineId = faceEngineId();
    out.threshold = faceThreshold();
    const t0 = performance.now();
    await loadHumanEngine();
    out.detectorMs = Math.round(performance.now()-t0);
    const t1 = performance.now();
    await loadArcFace();
    out.arcLoadMs = Math.round(performance.now()-t1);

    const c = new OffscreenCanvas(1024,768); const x = c.getContext("2d");
    x.fillStyle="#9ab"; x.fillRect(0,0,1024,768);
    const cx=420, cy=330;
    x.fillStyle="#e8c39e"; x.beginPath(); x.ellipse(cx,cy,110,145,0,0,7); x.fill();
    x.fillStyle="#3a2d25"; x.beginPath(); x.ellipse(cx,cy-125,113,56,0,Math.PI,2*Math.PI); x.fill();
    x.fillStyle="#fff";
    x.beginPath(); x.ellipse(cx-44,cy-25,25,14,0,0,7); x.fill();
    x.beginPath(); x.ellipse(cx+44,cy-25,25,14,0,0,7); x.fill();
    x.fillStyle="#241a12";
    x.beginPath(); x.arc(cx-44,cy-25,10,0,7); x.fill();
    x.beginPath(); x.arc(cx+44,cy-25,10,0,7); x.fill();
    x.strokeStyle="#c9a184"; x.lineWidth=6;
    x.beginPath(); x.moveTo(cx,cy-10); x.lineTo(cx-7,cy+35); x.lineTo(cx+10,cy+37); x.stroke();
    x.strokeStyle="#8d4b45"; x.lineWidth=9;
    x.beginPath(); x.arc(cx,cy+65,42,0.25,Math.PI-0.25); x.stroke();
    const bmp = await createImageBitmap(await c.convertToBlob());

    const found = await FACE_ENGINE(bmp);
    out.detected = found.length;
    if (found.length){
      out.hasMesh = !!(found[0].mesh && found[0].mesh.length > 400);
      const crop = faceAlignedCrop(bmp, found[0].mesh);
      out.cropMade = !!crop;
      if (crop){
        out.cropSize = crop.width + "x" + crop.height;
        const t2 = performance.now();
        const v = await arcEmbedCrop(crop);
        out.embedMs = Math.round(performance.now()-t2);
        out.embedDim = v.length;
        let n=0; for (const z of v) n += z*z;
        out.embedNorm = Math.sqrt(n).toFixed(2);
      }
    }
    bmp.close();
    return JSON.stringify(out, null, 1);
  } catch (e){ out.error = String(e && e.message || e).slice(0,250); return JSON.stringify(out,null,1); }
 })()
`));
process.exit(0);
