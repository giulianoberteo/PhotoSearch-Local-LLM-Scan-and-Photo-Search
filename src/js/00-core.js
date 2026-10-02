"use strict";
/* Keep in step with the newest heading in ChangeLog.md. */
const APP_VERSION = "0.6.23";
/* ================= helpers ================= */
const $ = s => document.querySelector(s);
const el = (tag, cls, txt) => { const n = document.createElement(tag);
  if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; };
const fmt = n => n == null ? "–" : String(n);
/* Lazy modules (see LAZY in build.py) sit in the page as inert <script type="text/plain"
   data-lazy="name"> text and run, once, the first time something needs them. As a classic
   script they share the page's global scope exactly as if they had been in the main one.
   In the test build they are part of the main script, so this finds nothing and does nothing. */
const LAZY_DONE = new Set();
function loadModule(name){
  if (LAZY_DONE.has(name)) return;
  const src = document.querySelector('script[type="text/plain"][data-lazy="' + name + '"]');
  if (!src) return;
  LAZY_DONE.add(name);
  const s = document.createElement("script");
  s.textContent = '"use strict";\n' + src.textContent;
  document.head.append(s);
  s.remove();
}

function fmtDur(s){
  s = Math.round(s);
  if (s < 90) return s + "s";
  const m = Math.round(s / 60);
  if (m < 90) return m + " min";
  const h = s / 3600;
  return h < 48 ? h.toFixed(1) + " h" : (h / 24).toFixed(1) + " days";
}
/* requestAnimationFrame does not fire while a tab is hidden, occluded, or on
   another Space. Anything that AWAITS a repaint would then hang forever — which
   is exactly what happened to the progress notes. Always resolve, with a timer
   as the backstop. */
const paint = () => new Promise(r => {
  let done = false;
  const fin = () => { if (done) return; done = true; r(); };
  try { requestAnimationFrame(() => setTimeout(fin, 0)); } catch { /* ignore */ }
  setTimeout(fin, 60);
});

/* ================= state ================= */
const S = {
  baseUrl: "http://localhost:1234",
  provider: null, structuredMode: "json_schema",
  models: [], nativeApi: null, connected: false,
  dirHandle: null, indexDirHandle: null, photoCount: 0,
  roles: { scan:"", embed:"", chat:"auto" },
  scan: { concurrency:1, statConcurrency:12, maxTokens:2000, temp:0.1,
          estSecs:23, batchSize:25, bigPx:1024, thumbPx:384, thumbQ:0.7 },
  /* maxTokens is a ceiling, not a target: an ordinary photo generates ~400.
     900 truncated text-heavy images mid-JSON once the prompt asked for full
     transcription, so it costs nothing to be generous here. */
  date: { hemisphere:"north", occasions:null, overrides:[] },
  events: { gapHours:6, km:25 },
  search: { minCosine:0.30, minKeywordShare:0.25 },
  chat: { historyChars:24000, toolResultChars:8000 },
  ocr: { enabled:true, px:1600, maxTokens:3000, embedChars:1200, minChars:40 },
  /* A NAS library wants its index on local disk: every batch flush would
     otherwise cross SMB, and search should keep working when the share sleeps. */
  indexMode: "folder",            // "folder" = .photoindex beside the photos
  indexChosen: false,             // did the user actually pick, or is this the default?
  scanOrder: "newest",            // newest | oldest | path | smallest
  /* Always keep the library ROOT as the picked folder so paths stay unique and
     one index covers everything. Scope narrows only what a scan walks. */
  scanExclude: [],                // folders left out of every scan, relative to the library root: ["2019/Screenshots/"]
  scanScope: "",                  // "" = whole library, else "Sicily/" etc.
  subfolders: [],
  /* deadlineFactor multiplies the MEASURED cost of a round trip; cap is the
     ceiling, and the floor stops a fast local disk producing deadlines so
     tight that a momentary stall looks like a failure. */
  io: { retries:3, retryMs:400, deadlineFactor:40, deadlineFloorMs:8000,
        deadlineCapMs:180000 },
  storage: { openMs:null, readMs:null, listMs:null, at:0, listTimedOut:false },
  /* threshold is cosine similarity between unit vectors: higher splits one
     person into several groups, lower merges different people together. */
  /* minScore matches the detector's own minConfidence: a second, stricter
     floor on top of it just discards faces the detector already accepted. */
  /* threshold measured, not guessed: with alignment on, the same face across
     poses scores ~0.93 and two different faces ~0.59, so 0.75 sits between
     them. Adjustable in the People tab, because only you can judge your own
     library -- and re-grouping is instant, the vectors are already on disk.
     minFacePx: below this many pixels across there is nothing to describe.
     source "thumbs" reads the 384px thumbnails already in the index -- for a
     14 GB library on a 430 KB/s share that is 8 minutes against 9.7 HOURS of
     re-reading originals, for the same photos. "originals" is the accurate
     option, and should be pointed at a subset. */
  /* embedder: "arcface" is a purpose-built recognition model (13 MB, fetched
     once); "faceres" is the descriptor human produces as a by-product of
     estimating age and gender, and is kept only so the two can be compared on
     the same faces. Threshold depends on the embedder -- they are different
     spaces -- so each carries its own. */
  /* refinePx: when re-reading an original, decode this big. ArcFace consumes
     112x112, so a face below that is UPSCALED and real detail is gone -- the
     measured cost is 0.899 similarity at 103px against 1.000 at 412px. A 384px
     thumbnail only yields a 112px face when the face fills 29% of the frame,
     which most snapshots do not. Decoding to 2048 puts a typical face well
     above 112px, and detection there costs 32ms. */
  faces: { enabled:false, embedder:"arcface",
           threshold:0.42, faceresThreshold:0.75,
           minScore:0.4, minFacePx:40, refinePx:2048,
           maxPerPhoto:20, source:"thumbs", readConcurrency:5 },
  backup: { enabled:true, keep:3, minNewRecords:1 },
  plan: null
};

/* ================= settings persistence ================= */
const LS = "photosearch.settings.v2";
const LS_OLD = "photosearch.settings.v1";
function saveSettings(){
  try { localStorage.setItem(LS, JSON.stringify({
    baseUrl:S.baseUrl, roles:S.roles, scan:S.scan, date:S.date, events:S.events,
    search:S.search, ocr:S.ocr, backup:S.backup, chat:S.chat, faces:S.faces,
    structuredMode:S.structuredMode, indexMode:S.indexMode, indexChosen:S.indexChosen, scanOrder:S.scanOrder, scanScope:S.scanScope, scanExclude:S.scanExclude, io:S.io,
    mock: $("#mock").checked })); } catch {}
}
function loadSettings(){
  try {
    // Carry forward settings written by an earlier version rather than
    // silently reverting the user to defaults (which loses the scan model).
    let raw = localStorage.getItem(LS);
    if (!raw){
      const old = localStorage.getItem(LS_OLD);
      if (old){ raw = old; try { localStorage.setItem(LS, old); } catch {} }
    }
    const d = JSON.parse(raw || "{}");
    if (d.baseUrl){ S.baseUrl = d.baseUrl; $("#baseUrl").value = d.baseUrl; }
    if (d.roles){
      // Earlier self-test runs could save their mock roles; they are never a real choice.
      const r = { ...d.roles };
      for (const k of Object.keys(r)) if (/^mock-/.test(String(r[k])) && !d.mock) delete r[k];
      S.roles = { ...S.roles, ...r };
    }
    if (d.scan)  S.scan  = { ...S.scan,  ...d.scan };
    if (d.date)  S.date  = { ...S.date,  ...d.date };
    if (d.events) S.events = { ...S.events, ...d.events };
    if (d.search) S.search = { ...S.search, ...d.search };
    if (d.chat) S.chat = { ...S.chat, ...d.chat };
    if (d.structuredMode) S.structuredMode = d.structuredMode;
    if (d.faces){
      /* MIGRATION. `faces.threshold` used to mean the faceres threshold, around
         0.75. It now means the ArcFace one, which lives near 0.42 -- a totally
         different space. Carrying the old number straight across applied 0.75 to
         ArcFace, which is far too strict, and the setting silently sabotaged the
         model it was supposed to tune. A saved threshold with no
         faceresThreshold beside it can only have come from the old scheme. */
      const old = { ...d.faces };
      if (old.threshold != null && old.faceresThreshold == null){
        old.faceresThreshold = old.threshold;
        delete old.threshold;                  // keep the new default
      }
      S.faces = { ...S.faces, ...old };
    }
    if (d.ocr) S.ocr = { ...S.ocr, ...d.ocr };
    if (d.indexMode) S.indexMode = d.indexMode;
    if (d.indexChosen) S.indexChosen = d.indexChosen;
    if (d.scanOrder) S.scanOrder = d.scanOrder;
    if (d.scanScope) S.scanScope = d.scanScope;
    if (Array.isArray(d.scanExclude)) S.scanExclude = d.scanExclude.filter(x => typeof x === "string");
    if (d.io) S.io = { ...S.io, ...d.io };
    if (d.backup) S.backup = { ...S.backup, ...d.backup };
    if (d.mock) $("#mock").checked = true;
    $("#sConc").value = S.scan.concurrency;
    $("#sStat").value = S.scan.statConcurrency;
    $("#sMaxTok").value = S.scan.maxTokens;
    $("#sTemp").value = S.scan.temp;
    $("#sGap").value = S.events.gapHours;
    $("#sKm").value = S.events.km;
    $("#sHemi").value = S.date.hemisphere;
    $("#sMinCos").value = S.search.minCosine;
    $("#sOcr").checked = S.ocr.enabled;
    $("#sOrder").value = S.scanOrder;
    $("#sBackup").checked = S.backup.enabled;
    $("#sKeep").value = S.backup.keep;
  } catch {}
}
function idb(){ return new Promise((res, rej) => {
  const r = indexedDB.open("photosearch", 1);
  r.onupgradeneeded = () => r.result.createObjectStore("kv");
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function idbSet(k, v){ const db = await idb(); return new Promise((res, rej) => {
  const t = db.transaction("kv","readwrite"); t.objectStore("kv").put(v, k);
  t.oncomplete = res; t.onerror = () => rej(t.error); }); }
async function idbGet(k){ const db = await idb(); return new Promise((res, rej) => {
  const t = db.transaction("kv","readonly"); const q = t.objectStore("kv").get(k);
  q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }

