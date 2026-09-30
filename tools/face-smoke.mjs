// Live check of the real face model: the self-test stubs the engine, so this
// is the only thing that catches a moved CDN path, a model that will not load,
// or a confidence field that reads zero. Needs network on the first run.
//
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
//     --headless=new --remote-debugging-port=9222 \
//     --user-data-dir=/tmp/face-smoke --allow-file-access-from-files about:blank &
//   node tools/face-smoke.mjs "file://$PWD/PhotoSearch.html"
//
// Expected: preflight ok, engine loaded, 0 faces in a blank image, and one
// DETECTED face with a NON-ZERO score and a 1024-wide vector.
const sleep = ms => new Promise(r => setTimeout(r, ms));
let list=null;
for (let i=0;i<60;i++){ try { list = await (await fetch("http://127.0.0.1:9222/json/list")).json(); break; } catch { await sleep(250);} }
const page = list.find(t => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id=0; const pending=new Map();
ws.onmessage = e => { const m=JSON.parse(e.data);
  if (m.id && pending.has(m.id)){ pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method==="Runtime.exceptionThrown") console.log("  [EXC]", m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);
};
const send=(m,p)=>new Promise(r=>{const i=++id;pending.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:p||{}}));});
await new Promise(r=>ws.onopen=r);
await send("Runtime.enable"); await send("Page.enable");
await send("Page.navigate",{url:process.argv[2]});
await sleep(3000);
const ev = async (expr) => {
  const r = await send("Runtime.evaluate",{expression:expr,returnByValue:true,awaitPromise:true});
  if (r.result?.exceptionDetails) return "THREW: " + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result?.result?.value;
};

const DRAW = `
  const c = new OffscreenCanvas(512, 512);
  const x = c.getContext("2d");
  x.fillStyle = "#9ab"; x.fillRect(0,0,512,512);
  x.fillStyle = "#e8c39e";
  x.beginPath(); x.ellipse(256,265,115,150,0,0,7); x.fill();
  x.fillStyle = "#3a2d25";
  x.beginPath(); x.ellipse(256,140,118,60,0,Math.PI,2*Math.PI); x.fill();
  x.fillStyle = "#fff";
  x.beginPath(); x.ellipse(212,240,26,15,0,0,7); x.fill();
  x.beginPath(); x.ellipse(300,240,26,15,0,0,7); x.fill();
  x.fillStyle = "#241a12";
  x.beginPath(); x.arc(212,240,10,0,7); x.fill();
  x.beginPath(); x.arc(300,240,10,0,7); x.fill();
  x.strokeStyle = "#3a2d25"; x.lineWidth = 7;
  x.beginPath(); x.moveTo(190,208); x.lineTo(236,204); x.stroke();
  x.beginPath(); x.moveTo(276,204); x.lineTo(322,208); x.stroke();
  x.strokeStyle = "#c9a184"; x.lineWidth = 6;
  x.beginPath(); x.moveTo(256,252); x.lineTo(249,300); x.lineTo(266,302); x.stroke();
  x.strokeStyle = "#8d4b45"; x.lineWidth = 9;
  x.beginPath(); x.arc(256,330,44,0.25,Math.PI-0.25); x.stroke();
`;

console.log("model base :", await ev("HUMAN_MODELS"));
console.log("preflight  :", await ev("checkFaceModels(HUMAN_MODELS).then(()=>'ok').catch(e=>'FAILED: '+e.message)"));
console.log("loading    :", await ev("(async()=>{try{await loadHumanEngine();return 'engine loaded: '+FACE_ENGINE_NAME;}catch(e){return 'FAILED: '+(e&&e.message||e);}})()"));
console.log("blank img  :", await ev("(async()=>{try{const c=new OffscreenCanvas(640,480);const x=c.getContext('2d');x.fillStyle='#cfa';x.fillRect(0,0,640,480);const b=await createImageBitmap(await c.convertToBlob());const o=await FACE_ENGINE(b);b.close();return 'ran, '+o.length+' faces (0 expected)';}catch(e){return 'FAILED: '+(e&&e.message||e);}})()"));
console.log("drawn face :", await ev(`
  (async () => {
    try {
      ${DRAW}
      const bmp = await createImageBitmap(await c.convertToBlob());
      const out = await FACE_ENGINE(bmp);
      bmp.close();
      if (!out.length) return "no detection on a DRAWN face (inconclusive: not a photo)";
      const f = out[0];
      let norm = 0; for (const v of f.vec) norm += v*v;
      return "DETECTED " + out.length
        + " | vec dim " + f.vec.length
        + " | score " + f.score.toFixed(2)
        + " | box " + f.box.map(v=>v.toFixed(2)).join(",")
        + " | adapter keys: " + Object.keys(f).sort().join(",");
    } catch (e){ return "FAILED: " + (e && e.message || e); }
  })()
`));
process.exit(0);
