
/* ================= file-format policy =================
   Chromium decodes jpeg/png/webp/gif/bmp/avif natively. HEIC and TIFF need a
   decoder, loaded lazily from a pinned CDN and skipped cleanly when offline.
   RAW, vector and video files are counted and reported but never sent to a model. */
const FMT = {
  native: /\.(jpe?g|jpe|jfif|pjpeg|png|apng|webp|gif|bmp|avif)$/i,
  heic:   /\.(heic|heif|hif)$/i,
  tiff:   /\.(tiff?)$/i,
  vector: /\.(svg|svgz|eps|ai|pdf)$/i,
  raw:    /\.(cr2|cr3|nef|nrw|arw|srf|sr2|dng|orf|rw2|raf|pef|ptx|srw|3fr|fff|iiq|x3f|erf|mef|mos|mrw|kdc|dcr)$/i,
  video:  /\.(mp4|mov|m4v|avi|mkv|webm|mpg|mpeg|wmv|3gp|mts|m2ts)$/i,
};
const isScannable = n => FMT.native.test(n) || FMT.heic.test(n) || FMT.tiff.test(n);
function classifyFile(name){
  if (FMT.native.test(name)) return "native";
  if (FMT.heic.test(name)) return "heic";
  if (FMT.tiff.test(name)) return "tiff";
  if (FMT.raw.test(name)) return "raw";
  if (FMT.vector.test(name)) return "vector";
  if (FMT.video.test(name)) return "video";
  return "other";
}

const WORKER_SRC = `
const LIB = {
  heif: "https://cdn.jsdelivr.net/npm/libheif-js@1.18.2/libheif-wasm/libheif-bundle.js",
  utif: "https://cdn.jsdelivr.net/npm/utif@3.1.0/UTIF.js"
};
let heifDec = null, heifErr = null, heifFails = 0, heifNextTry = 0, utifTried = false;

function loadOnce(url){
  try { importScripts(url); return true; } catch(e){ return false; }
}
/* libheif-js 1.18 exposes an async Emscripten FACTORY on the global, not a
   namespace: you must call it and await the module before constructing.
   Both shapes are handled so a future version cannot silently break this. */
async function initHeif(){
  /* Retry with backoff rather than latching off for the session: one failed
     CDN fetch used to turn every remaining .heic in a multi-day scan into an
     error record. */
  if (heifDec) return heifDec;
  if (Date.now() < heifNextTry) return null;
  try {
    if (!loadOnce(LIB.heif)) throw new Error("could not load the decoder (offline?)");
    if (typeof libheif === "undefined") throw new Error("decoder did not register itself");
    let ns = libheif;
    if (typeof ns === "function") ns = await ns();
    if (ns && ns.default && typeof ns.HeifDecoder !== "function") ns = ns.default;
    if (!ns || typeof ns.HeifDecoder !== "function")
      throw new Error("unexpected decoder API: no HeifDecoder constructor");
    heifDec = new ns.HeifDecoder();
  } catch (e){
    heifErr = String(e && e.message || e) || (e && e.name) || "unknown";
    heifFails++;
    heifNextTry = Date.now() + Math.min(300000, 5000 * Math.pow(2, heifFails));
    heifDec = null;
  }
  return heifDec;
}
async function heicBitmap(buf){
  const dec = await initHeif();
  if (!dec) throw new Error("HEIC decoder unavailable: " + (heifErr || "unknown"));
  const heifDec = dec;
  const imgs = heifDec.decode(new Uint8Array(buf));
  if (!imgs || !imgs.length) throw new Error("HEIC decode produced no image");
  const im = imgs[0], w = im.get_width(), h = im.get_height();
  const id = new ImageData(w, h);
  await new Promise((res, rej) =>
    im.display(id, r => r ? res() : rej(new Error("HEIC display failed"))));
  return createImageBitmap(id);
}
async function tiffBitmap(buf){
  if (!utifTried){ utifTried = true; loadOnce(LIB.utif); }
  if (typeof UTIF === "undefined") throw new Error("TIFF decoder unavailable (offline?)");
  const ifds = UTIF.decode(buf);
  if (!ifds || !ifds.length) throw new Error("TIFF has no pages");
  UTIF.decodeImage(buf, ifds[0], ifds);
  const rgba = UTIF.toRGBA8(ifds[0]);
  const w = ifds[0].width, h = ifds[0].height;
  if (!w || !h) throw new Error("TIFF has no dimensions");
  return createImageBitmap(new ImageData(new Uint8ClampedArray(rgba), w, h));
}
function fit(w, h, max){
  if (w <= max && h <= max) return [w, h];
  return w >= h ? [max, Math.round(h * max / w)] : [Math.round(w * max / h), max];
}
async function toJpeg(bmp, max, quality){
  const [w, h] = fit(bmp.width, bmp.height, max);
  const c = new OffscreenCanvas(w, h);
  const cx = c.getContext("2d");
  cx.fillStyle = "#fff"; cx.fillRect(0, 0, w, h);   // flatten alpha, PNGs stay readable
  cx.drawImage(bmp, 0, 0, w, h);
  return { blob: await c.convertToBlob({ type:"image/jpeg", quality }), w, h };
}
self.onmessage = async e => {
  const { id, file, kind, bigPx, thumbPx, thumbQ } = e.data;
  try {
    let bmp = null, decoder = "native";
    if (kind === "native"){
      // imageOrientation:"from-image" applies EXIF rotation during decode.
      bmp = await createImageBitmap(file, { imageOrientation:"from-image" });
    } else if (kind === "heic"){
      try { bmp = await createImageBitmap(file, { imageOrientation:"from-image" }); }
      catch { bmp = await heicBitmap(await file.arrayBuffer()); decoder = "libheif"; }
    } else if (kind === "tiff"){
      try { bmp = await createImageBitmap(file, { imageOrientation:"from-image" }); }
      catch { bmp = await tiffBitmap(await file.arrayBuffer()); decoder = "utif"; }
    } else {
      throw new Error("unsupported kind: " + kind);
    }
    if (!bmp || !bmp.width || !bmp.height) throw new Error("decoded image has no pixels");
    const srcW = bmp.width, srcH = bmp.height;
    const big = await toJpeg(bmp, bigPx, 0.82);
    const th  = await toJpeg(bmp, thumbPx, thumbQ);
    bmp.close();
    self.postMessage({ id, ok:true, big:big.blob, thumb:th.blob,
      w:big.w, h:big.h, srcW, srcH, decoder });
  } catch (err){
    self.postMessage({ id, ok:false, error: String(err && err.message || err) });
  }
};`;

let WORKER = null, WORKER_URL = null, wSeq = 0;
const wJobs = new Map();
function imgWorker(){
  if (WORKER) return WORKER;
  WORKER_URL = URL.createObjectURL(new Blob([WORKER_SRC], { type:"text/javascript" }));
  WORKER = new Worker(WORKER_URL);
  WORKER.onmessage = e => {
    const j = wJobs.get(e.data.id);
    if (!j) return;
    wJobs.delete(e.data.id);
    clearTimeout(j.timer);
    e.data.ok ? j.res(e.data) : j.rej(new Error(e.data.error));
  };
  WORKER.onerror = e => {
    /* ErrorEvent.message is routinely empty for worker failures, and the old
       worker kept running with its blob URL leaked. */
    const why = (e && e.message) || (e && e.filename) || "no detail available";
    for (const [, j] of wJobs){ clearTimeout(j.timer); j.rej(new Error("image worker crashed: " + why)); }
    wJobs.clear();
    try { WORKER.terminate(); } catch {}
    try { if (WORKER_URL) URL.revokeObjectURL(WORKER_URL); } catch {}
    WORKER = null; WORKER_URL = null;
  };
  return WORKER;
}
function processImage(file, kind, opts){
  opts = opts || {};
  const id = ++wSeq;
  return new Promise((res, rej) => {
    const timer = setTimeout(() => {
      if (wJobs.has(id)){ wJobs.delete(id); rej(new Error("decode timeout after 120s")); }
    }, 120000);
    wJobs.set(id, { res, rej, timer });
    imgWorker().postMessage({ id, file, kind,
      bigPx: opts.bigPx || S.scan.bigPx, thumbPx: opts.thumbPx || S.scan.thumbPx,
      thumbQ: S.scan.thumbQ });
  });
}
