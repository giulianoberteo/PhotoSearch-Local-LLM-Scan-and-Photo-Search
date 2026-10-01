"use strict";
/* Keep in step with the newest heading in ChangeLog.md. */
const APP_VERSION = "0.6.0";
/* ================= helpers ================= */
const $ = s => document.querySelector(s);
const el = (tag, cls, txt) => { const n = document.createElement(tag);
  if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; };
const fmt = n => n == null ? "–" : String(n);
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
    structuredMode:S.structuredMode, indexMode:S.indexMode, indexChosen:S.indexChosen, scanOrder:S.scanOrder, scanScope:S.scanScope, io:S.io,
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
    if (d.roles) S.roles = { ...S.roles, ...d.roles };
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

/* ================= tabs ================= */
document.querySelectorAll('nav button').forEach(b => b.onclick = () => {
  document.querySelectorAll('nav button').forEach(x =>
    x.setAttribute("aria-selected", String(x === b)));
  ["library","chat","timeline","people","scan","settings"].forEach(t =>
    $("#tab-" + t).hidden = (t !== b.dataset.tab));
  /* The timeline reads the whole index, so it is built on first view rather
     than at boot -- opening the app must not wait for it. */
  if (b.dataset.tab === "library" && typeof onLibraryShown === "function")
    onLibraryShown();
  if (b.dataset.tab === "timeline" && typeof onTimelineShown === "function")
    onTimelineShown();
  if (b.dataset.tab === "people" && typeof onPeopleShown === "function")
    onPeopleShown();
});

/* ================= browser gate ================= */
function checkBrowser(){
  const miss = [];
  if (!window.showDirectoryPicker) miss.push("File System Access API");
  if (!window.createImageBitmap) miss.push("createImageBitmap");
  if (!window.OffscreenCanvas) miss.push("OffscreenCanvas");
  if (!miss.length) return true;
  const w = $("#browserWarn"); w.hidden = false; w.innerHTML = "";
  w.append(el("b", null, "This browser is not supported. "));
  w.append(document.createTextNode(
    "PhotoSearch needs desktop Chrome or Edge. Missing: " + miss.join(", ") + "."));
  ["btnPick","btnWriteTest","btnReconnect"].forEach(id => { const n = $("#" + id); if (n) n.disabled = true; });
  return false;
}

/* ================= check rows ================= */
const ICON = { ok:"✓", warn:"!", err:"✕", busy:"…" };
function setRow(row, c){
  const ic = row.querySelector(".ic");
  ic.className = "ic " + (c.status === "busy" ? "dim" : c.status);
  ic.textContent = ICON[c.status] || "…";
  row.querySelector(".t").textContent = c.title;
  row.querySelector(".d").textContent = c.detail || "";
}
function checkRow(c){
  const row = el("div","check");
  row.append(el("div","ic"));
  const b = el("div","body"); b.append(el("div","t")); b.append(el("div","d"));
  row.append(b); setRow(row, c); return row;
}
function checksBox(host){
  let box = host.querySelector(".checks");
  if (!box){ host.innerHTML = ""; box = el("div","checks");
    box.style.marginTop = "12px"; host.append(box); }
  return box;
}
function resetChecks(host){ host.innerHTML = ""; return checksBox(host); }
function renderChecks(host, checks){
  const box = resetChecks(host);
  for (const c of checks) box.append(checkRow(c));
}
function step(host, title){
  const row = checkRow({ status:"busy", title, detail:"working…" });
  checksBox(host).append(row);
  return {
    note: d => { row.querySelector(".d").textContent = d; return paint(); },
    ok:   d => setRow(row, { status:"ok",   title, detail:d }),
    warn: d => setRow(row, { status:"warn", title, detail:d }),
    err:  d => setRow(row, { status:"err",  title, detail:d }),
    paint
  };
}
/* DOMExceptions frequently carry an empty .message, which rendered as a blank
   error and left only the last progress label on screen. Always produce text. */
function errText(e){
  if (!e) return "unknown error";
  const name = e.name && e.name !== "Error" ? e.name : "";
  const msg = (e.message || "").trim();
  if (name && msg) return name + ": " + msg;
  if (msg) return msg;
  if (name) return name;
  const s = String(e);
  return s === "[object Object]" ? JSON.stringify(e).slice(0, 200) : s;
}

function toast(msg){
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 7000);
}

/* A mounted SMB share drops reads under load. One failure should not become a
   permanent error record in the middle of a multi-day scan. */
/* A DOMException carries its identity in its NAME, not its message, and that
   name is lost the instant it is re-wrapped in a plain Error. Callers that
   must tell "this folder is gone" from "the share is down" therefore have to
   walk the cause chain rather than pattern-match the text. */
function isNotFound(e){
  for (let x = e, depth = 0; x && depth < 5; x = x.cause, depth++)
    if (x.name === "NotFoundError") return true;
  return false;
}

async function withRetry(label, fn){
  let last, tries = 0;
  for (let i = 0; i < S.io.retries; i++){
    tries++;
    try { return await fn(); }
    catch (e){
      if (e && e.name === "AbortError") throw e;
      last = e;
      /* An entry that does not exist will not appear by waiting. Retrying it
         spent three backoffs per absent file for nothing. */
      if (isNotFound(e)) break;
      if (i < S.io.retries - 1)
        await new Promise(r => setTimeout(r, S.io.retryMs * (i + 1)));
    }
  }
  /* Keep the original as the cause: errText() alone flattens a DOMException to
     prose, after which no caller can recover which failure it was. */
  const err = new Error(label + " failed after " + tries
    + (tries === 1 ? " try: " : " tries: ") + errText(last));
  err.cause = last;
  throw err;
}

/* Every await against a network share can stall. Without a deadline the UI sits
   on one label forever with no way to tell which step is stuck. */
async function withDeadline(label, ms, promise){
  let timer;
  const bomb = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(label + " did not finish within "
      + Math.round(ms / 1000) + "s — the share may be slow or asleep")), ms);
  });
  try { return await Promise.race([promise, bomb]); }
  finally { clearTimeout(timer); }
}

/* ---- storage speed ----
   Deadlines used to be guessed constants: 30s, then 120s, then 120s again, each
   raised after it fired on a share that was merely slow rather than broken. A
   guess cannot be right for both a local SSD and a sleeping NAS, where a single
   round trip measured 24 seconds. So measure one, and size the rest from it.

   The measurement is taken from work the app has to do anyway -- opening
   .photoindex/ and reading config.json -- so it costs nothing extra. */
function noteStorageTiming(kind, ms){
  if (!(ms >= 0)) return;
  S.storage[kind] = ms;
  S.storage.at = Date.now();
}

/* A directory listing is the operation that actually hurts on this share, so
   probe with one. Deliberately lists the index folder, never thumbs/.

   The probe must never become the thing that hangs: a listing on this share is
   exactly what sometimes never returns, and this runs on every connect. Give up
   at the budget and treat "it did not finish in 15s" as the measurement it is --
   that is far more informative than no reading at all. */
async function probeStorage(dir, budgetMs){
  if (!dir) return S.storage;
  const budget = budgetMs || 15000;
  const t0 = performance.now();
  const listing = (async () => {
    let n = 0;
    for await (const _ of dir.keys()){ if (++n >= 25) break; }
    return "done";
  })();
  let outcome;
  try {
    outcome = await Promise.race([
      listing.catch(() => "failed"),
      new Promise(r => setTimeout(() => r("timeout"), budget))
    ]);
  } catch { outcome = "failed"; }
  if (outcome === "failed") return S.storage;
  S.storage.listTimedOut = outcome === "timeout";
  noteStorageTiming("listMs", outcome === "timeout" ? budget : performance.now() - t0);
  return S.storage;
}

/* The slowest thing measured so far, as a unit of "one round trip here". */
function storageUnitMs(){
  const seen = [S.storage.openMs, S.storage.readMs, S.storage.listMs]
    .filter(v => typeof v === "number" && v >= 0);
  return seen.length ? Math.max(...seen) : null;
}

function ioDeadline(units, floorMs){
  const unit = storageUnitMs();
  const floor = floorMs || S.io.deadlineFloorMs;
  /* Unmeasured storage gets the floor: assuming it is fast is the mistake that
     produced a 30-second backup deadline on a share needing 24s just to wake. */
  const want = unit == null ? floor
    : Math.max(floor, unit * (units || 1) * S.io.deadlineFactor);
  return Math.min(S.io.deadlineCapMs, want);
}

function describeStorage(){
  const unit = storageUnitMs();
  if (unit == null) return "storage speed not measured yet";
  const how = S.storage.listTimedOut ? "not responding — listing did not finish"
            : unit > 3000 ? "very slow — likely a sleeping network share"
            : unit > 300  ? "slow — a network share"
            : "fast";
  return "storage: " + (S.storage.listTimedOut ? "over " : "")
       + Math.round(unit) + " ms per operation (" + how
       + "); deadlines " + Math.round(ioDeadline(1) / 1000) + "s";
}

/* ---- one way to run an index operation ----
   The scan, the backup and the plan each grew their own mixture of deadline,
   retry and progress reporting, and they disagreed: some reported every step,
   some sat on a single label, and the one that failed most often reported the
   least. indexOp gives all of them the same contract -- a deadline sized from
   measured storage speed, and a failure that always names the step it died on. */
async function indexOp(label, fn, opts){
  const o = opts || {};
  let phase = label;
  const say = async m => {
    phase = m;
    if (o.onPhase) await o.onPhase(m);
  };
  const ms = o.timeoutMs || ioDeadline(o.cost || 1, o.floorMs);
  try {
    return await withDeadline(label, ms, fn(say));
  } catch (e){
    if (e && e.name === "AbortError") throw e;
    /* "[stuck at: …]" is the difference between a bug report and a shrug: the
       label says what was attempted, the phase says how far it got. */
    const err = new Error(errText(e)
      + (phase && phase !== label ? "  [stuck at: " + phase + "]" : ""));
    err.cause = e;
    err.phase = phase;
    err.op = label;
    throw err;
  }
}

/* Re-acquires folder permission from inside a click. Chrome grants it only in
   response to a gesture, which a button press already is, so any action can
   simply reconnect itself instead of failing and telling the user to go and
   press something else first. */
async function ensureConnected(what){
  if (S.dirHandle) return true;
  const h = await idbGet("lastDir");
  if (!h){
    toast("Choose a photo folder first (Settings).");
    return false;
  }
  let perm = await h.queryPermission({ mode:"readwrite" });
  if (perm !== "granted") perm = await h.requestPermission({ mode:"readwrite" });
  if (perm !== "granted"){
    toast("Chrome denied access to " + h.name + ". Pick the folder again.");
    return false;
  }
  await useDirectory(h);
  toast("Reconnected " + h.name + (what ? " — continuing with " + what : ""));
  return true;
}
/* The index folder needs the same treatment when it lives outside the photos. */
async function ensureIndexConnected(){
  if (S.indexMode !== "custom") return true;
  if (S.indexDirHandle) return true;
  const h = await idbGet("lastIndexDir");
  if (!h){ toast("Choose where to save the index (Settings)."); return false; }
  let perm = await h.queryPermission({ mode:"readwrite" });
  if (perm !== "granted") perm = await h.requestPermission({ mode:"readwrite" });
  if (perm !== "granted"){ toast("Chrome denied access to " + h.name + "."); return false; }
  S.indexDirHandle = h;
  return true;
}

/* ================= directory picker =================
   Deliberately minimal. Earlier versions added a busy flag, a button-disable
   and a watchdog; the disable let macOS dismiss the dialog and left the button
   stuck. One direct call in the click handler is what works. */
async function pickDirectory(){
  return window.showDirectoryPicker({ mode:"readwrite" });
}

/* Chrome keeps a per-document "a file picker is open" flag. If a dialog is ever
   dismissed without settling its promise, that flag stays set and every later
   picker is refused — for the life of the document. Only a reload clears it,
   and nothing the page does can reset it. So detect it and offer the reload;
   folders and settings survive, since they live in IndexedDB and localStorage. */
function isPickerStuck(e){
  return !!e && /file picker already active/i.test(String(e.message || e));
}
function offerPickerReset(){
  const w = $("#browserWarn");
  w.hidden = false; w.innerHTML = "";
  w.append(el("b", null, "The folder chooser is stuck. "));
  w.append(document.createTextNode(
    "Chrome thinks a file dialog is still open on this page. Reloading clears it "
    + "— your folders and settings are remembered."));
  const b = el("button", "btn");
  b.textContent = "Reload now";
  b.style.marginLeft = "10px";
  b.onclick = () => location.reload();
  w.append(b);
  const b2 = el("button", "btn sec");
  b2.textContent = "Dismiss";
  b2.style.marginLeft = "6px";
  b2.onclick = () => { w.hidden = true; };
  w.append(b2);
  w.scrollIntoView({ block:"nearest" });
}

/* Dragging a folder from Finder yields a directory handle directly, with no
   dialog involved. It is the reliable fallback when the picker misbehaves. */
function enableFolderDrop(btnId, onFolder){
  const n = document.getElementById(btnId);
  if (!n) return;
  const stop = e => { e.preventDefault(); e.stopPropagation(); };
  n.addEventListener("dragover", e => { stop(e); n.classList.add("dropping"); });
  n.addEventListener("dragleave", e => { stop(e); n.classList.remove("dropping"); });
  n.addEventListener("drop", async e => {
    stop(e); n.classList.remove("dropping");
    const item = e.dataTransfer && e.dataTransfer.items && e.dataTransfer.items[0];
    if (!item || !item.getAsFileSystemHandle){
      toast("This browser cannot accept dropped folders."); return;
    }
    try {
      const h = await item.getAsFileSystemHandle();
      if (!h || h.kind !== "directory"){ toast("Drop a FOLDER, not a file."); return; }
      let p = await h.queryPermission({ mode:"readwrite" });
      if (p !== "granted") p = await h.requestPermission({ mode:"readwrite" });
      if (p !== "granted"){ toast("Permission denied for " + h.name + "."); return; }
      await onFolder(h);
    } catch (err){ toast("Could not use that folder: " + String(err.message || err)); }
  });
}

/* ================= model server client ================= */
/* Any OpenAI-compatible server will do. LM Studio is http://localhost:1234 and
   Ollama is http://localhost:11434 -- but people paste the URL they were given,
   which for Ollama usually already ends in /v1, so tolerate both rather than
   producing /v1/v1 and a baffling 404. */
function url(p){
  const b = S.baseUrl.replace(/\/+$/, "");
  if (/^\/v1\//.test(p) && /\/v1$/.test(b)) return b + p.slice(3);
  return b + p;
}
/* Server-specific endpoints live at the root, not under /v1. */
function apiRoot(){ return S.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, ""); }
async function jgetAbs(absolute, ms = 8000){
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(absolute, { mode:"cors", signal: ac.signal });
    if (!r.ok) return { ok:false, error:"HTTP " + r.status };
    return { ok:true, data: await r.json() };
  } catch (e){ return { ok:false, error: errText(e) }; }
  finally { clearTimeout(t); }
}
async function jget(path, ms = 8000){
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url(path), { signal: ac.signal, mode: "cors" });
    if (!r.ok) return { ok:false, error:"HTTP " + r.status };
    return { ok:true, data: await r.json() };
  } catch (e) {
    return { ok:false, error: e.name === "AbortError" ? "timeout" : String(e.message || e) };
  } finally { clearTimeout(t); }
}
/* Accepts an external AbortSignal so Stop cancels the in-flight request
   immediately instead of waiting out the current image. */
async function chat(body, signal, ms = 600000){
  if ($("#mock").checked) return mockChat(body);
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (signal){
    if (signal.aborted) throw new DOMException("aborted","AbortError");
    signal.addEventListener("abort", onAbort, { once:true });
  }
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url("/v1/chat/completions"), {
      method:"POST", mode:"cors", signal: ac.signal,
      headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
    const txt = await r.text();
    if (!r.ok) throw new Error("HTTP " + r.status + ": " + txt.slice(0,300));
    return JSON.parse(txt);
  } catch (e){
    if (e.name === "AbortError" && signal && signal.aborted)
      throw new DOMException("aborted","AbortError");
    throw e;
  } finally {
    clearTimeout(t);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}
function mockChat(body){
  const structured = !!body.response_format;
  if (!structured)
    return Promise.resolve({ choices:[{ message:{ content:"The sky is blue.",
      reasoning_content:"(pretend thinking) ".repeat(40) } }], usage:{ completion_tokens:780 } });
  const rec = {
    template_version:"1.0",
    observations:["a mock scene with three shapes","flat colour background","no people present"],
    image_type:"photo", scene_type:"outdoor", setting:"garden",
    people:{ count:0, count_bucket:"0", age_groups:[], description:"" },
    animals:[], objects:["tree","bench","path"], activities:["standing"],
    visible_text:{ has_text:false, text:"" },
    landmark:{ name:null, confidence:"low" },
    time_of_day:"midday", season:"summer", weather:"sunny", mood:"calm",
    dominant_colors:["green","blue"],
    quality:{ sharpness:"sharp", exposure:"ok", flags:[] },
    caption:"A mock photo of a garden with a bench under a tree.",
    description:"This is a synthetic record produced by mock mode. It exists so the "
      + "interface and the index can be exercised without a model loaded.",
    search_keywords:["mock","garden","test"],
    confidence:{ overall:"high", uncertain_fields:[] }
  };
  return Promise.resolve({ choices:[{ message:{ content:"", reasoning_content:JSON.stringify(rec) } }],
    usage:{ completion_tokens:151 } });
}

/* How to let a browser talk to each server. A file:// page sends Origin: null,
   which every one of these refuses by default -- and the failure looks like the
   server being down rather than a policy. */
const CORS_HELP = {
  "LM Studio": "lms server start --cors --port 1234   (or tick CORS in the "
    + "Developer tab)",
  "Ollama":    "OLLAMA_ORIGINS='*' ollama serve   (on macOS: "
    + "launchctl setenv OLLAMA_ORIGINS '*' then restart Ollama)",
  "OpenAI-compatible": "start the server with CORS enabled for any origin"
};
function corsHint(){
  return CORS_HELP[S.provider] || (S.baseUrl.includes("11434")
    ? CORS_HELP["Ollama"] : CORS_HELP["LM Studio"]);
}
function serverName(){ return S.provider || "the model server"; }

/* ---- does this server honour a JSON schema? ----
   The whole scan depends on it. Constrained decoding is what stops a reasoning
   model spending its entire budget thinking: 799 tokens and an empty answer
   becomes 13 tokens and valid JSON. A server that ignores the field does not
   fail -- it quietly returns prose, 20x the tokens, and a parse error per
   photo. So ask once, and know. */
async function probeStructured(model){
  const schema = { type:"object", additionalProperties:false,
    properties:{ ok:{ type:"boolean" } }, required:["ok"] };
  try {
    const d = await chat({ model, max_tokens: 40, temperature: 0,
      messages:[{ role:"user", content:"Reply with {\"ok\":true} and nothing else." }],
      response_format:{ type:"json_schema",
        json_schema:{ name:"probe", strict:true, schema } } });
    const m = d.choices && d.choices[0] && d.choices[0].message;
    const text = ((m && m.content) || "").trim()
      || ((m && (m.reasoning_content || m.reasoning)) || "").trim();
    const parsed = JSON.parse(stripThink(text));
    return { ok: parsed && parsed.ok === true, mode:"json_schema" };
  } catch (e){
    /* Fall back to the weaker contract rather than giving up: json_object at
       least forbids prose, even if it cannot enforce the shape. */
    try {
      const d = await chat({ model, max_tokens: 40, temperature: 0,
        messages:[{ role:"user", content:"Reply with {\"ok\":true} and nothing else." }],
        response_format:{ type:"json_object" } });
      const m = d.choices && d.choices[0] && d.choices[0].message;
      JSON.parse(stripThink(((m && m.content) || "").trim()));
      return { ok:true, mode:"json_object", why: errText(e) };
    } catch (e2){
      return { ok:false, mode:"none", why: errText(e) };
    }
  }
}

/* ================= model detection ================= */
async function detectModels(){
  if ($("#mock").checked){
    S.nativeApi = "/api/v0/models (mock)";
    S.models = [
      { id:"qwen3.5-9b-mlx", type:"vlm", state:"loaded" },
      { id:"text-embedding-nomic-embed-text-v1.5", type:"embeddings", state:"loaded" },
      { id:"mock-llm-20b", type:"llm", state:"not-loaded" }];
    return { ok:true };
  }
  /* 1. LM Studio's own endpoint: the richest, since it reports type and whether
        the model is actually loaded. */
  /* Server-specific endpoints sit at the ROOT, so resolve them against the root
     rather than the base URL -- otherwise pasting ".../v1" quietly demotes a
     recognised server to the generic path and loses its type and load state. */
  const n = await jgetAbs(apiRoot() + "/api/v0/models");
  if (n.ok && n.data && Array.isArray(n.data.data)){
    S.provider = "LM Studio";
    S.nativeApi = "/api/v0/models";
    S.models = n.data.data.map(m => ({ id:m.id, type:m.type || "llm",
      state:m.state || "unknown", arch:m.arch, ctx:m.max_context_length }));
    return { ok:true };
  }
  /* 2. Ollama. Worth a dedicated probe rather than guessing from names: it
        reports model families, and a vision model carries "clip" or "mllama"
        among them, which is a fact rather than an inference. */
  const t = await jgetAbs(apiRoot() + "/api/tags");
  if (t.ok && t.data && Array.isArray(t.data.models)){
    S.provider = "Ollama";
    S.nativeApi = "/api/tags";
    S.models = t.data.models.map(m => {
      const fam = ((m.details && m.details.families) || []).join(",").toLowerCase();
      const type = /clip|mllama|vision/.test(fam) ? "vlm"
                 : /bert|embed/.test(fam) ? "embeddings"
                 : guessType(m.name || m.model || "");
      return { id: m.name || m.model, type, state:"unknown",
               arch: (m.details && m.details.family) || undefined };
    });
    return { ok:true };
  }
  /* 3. Anything else that speaks OpenAI: only ids, so types are guessed and the
        user can correct them under Model roles. */
  const v = await jget("/v1/models");
  if (v.ok && v.data && Array.isArray(v.data.data)){
    S.provider = "OpenAI-compatible";
    S.nativeApi = null;
    S.models = v.data.data.map(m => ({ id:m.id, type:guessType(m.id), state:"unknown" }));
    return { ok:true };
  }
  return { ok:false, error: n.error || t.error || v.error };
}
/* Name heuristics for servers that do not say what a model is. Deliberately
   broad: a vision model missed here cannot be chosen for scanning, and the user
   can always override it. */
function guessType(id){
  const s = String(id).toLowerCase();
  if (/embed|bge|nomic-embed|gte|e5-|minilm|mxbai|arctic-embed|snowflake/.test(s))
    return "embeddings";
  if (/vl|vision|llava|bakllava|moondream|minicpm-v|pixtral|internvl|cogvlm|idefics|florence|phi-?3\.5-vision|phi-?4-multimodal|gemma-?[34]|qwen-?[23]|qwen3\.5|llama-?3\.2-vision|granite.*vision|aya-vision|smolvlm/.test(s))
    return "vlm";
  return "llm";
}
function renderModels(){
  const host = $("#models"); host.innerHTML = "";
  if (!S.models.length){ host.append(el("span","dim","No models reported.")); return; }
  const t = el("table");
  t.innerHTML = "<thead><tr><th>Model</th><th>Type</th><th>State</th><th>Context</th></tr></thead>";
  const tb = el("tbody");
  for (const m of S.models){
    const tr = el("tr");
    tr.append(Object.assign(el("td","mono"), { textContent:m.id }));
    const tt = el("td"); tt.append(el("span","pill" + (m.type === "vlm" ? " vlm" : ""), m.type)); tr.append(tt);
    const ts = el("td"); ts.append(el("span","pill" + (m.state === "loaded" ? " loaded" : ""), m.state)); tr.append(ts);
    tr.append(el("td","dim", m.ctx ? (m.ctx/1024).toFixed(0) + "k" : "–"));
    tb.append(tr);
  }
  t.append(tb); host.append(t);
  if (!S.nativeApi) host.append(Object.assign(el("div","hint"),
    { textContent:"Native /api/v0/models unavailable — types guessed from the model id." }));
  fillRoles();
}
function fillRoles(){
  const before = { ...S.roles };
  const vis = S.models.filter(m => m.type === "vlm");
  const emb = S.models.filter(m => m.type === "embeddings");
  const llm = S.models.filter(m => m.type !== "embeddings");
  const opt = (sel, list, extra, cur) => {
    sel.innerHTML = "";
    if (extra) sel.append(new Option(extra.label, extra.value));
    for (const m of list)
      sel.append(new Option(m.id + (m.state === "loaded" ? "  • loaded" : ""), m.id));
    if (cur && [...sel.options].some(o => o.value === cur)) sel.value = cur;
  };
  const pref = vis.find(m => /qwen3\.5|qwen3-?vl/i.test(m.id) && m.state === "loaded")
            || vis.find(m => /qwen3\.5|qwen3-?vl/i.test(m.id))
            || vis.find(m => m.state === "loaded") || vis[0];
  opt($("#mScan"), vis, vis.length ? null : { label:"— no vision model found —", value:"" },
      S.roles.scan || (pref && pref.id));
  opt($("#mEmbed"), emb, { label:"None (keyword search only)", value:"" }, S.roles.embed);
  opt($("#mChat"), llm, { label:"Auto: currently loaded LLM", value:"auto" }, S.roles.chat);
  syncRoles();
  /* A saved choice the server no longer offers is dropped by the selects
     above. Say so, rather than quietly switching the user to None. */
  const lost = [];
  for (const k of ["scan","embed","chat"])
    if (before[k] && before[k] !== "auto" && before[k] !== S.roles[k]) lost.push(before[k]);
  if (lost.length && S.models.length)
    toast("Model no longer available in " + serverName() + ": " + lost.join(", ")
      + ". Check Model roles in Settings.");
}
function syncRoles(){
  const picked = { scan:$("#mScan").value, embed:$("#mEmbed").value, chat:$("#mChat").value };
  /* Do not persist a role the UI merely failed to offer. /v1/models lists only
     LOADED models in some LM Studio builds, so an unloaded embedding model
     would be replaced by "None" and SAVED -- permanently degrading search with
     only a boot-time toast to explain it. */
  for (const k of ["scan","embed","chat"]){
    if (!picked[k] && S.roles[k] && !S.models.some(m => m.id === S.roles[k])){
      S.rolesUnavailable = S.rolesUnavailable || {};
      S.rolesUnavailable[k] = S.roles[k];
      picked[k] = S.roles[k];                 // keep the choice, flag it
    }
  }
  S.roles = picked;
  saveSettings();
  const loaded = S.models.filter(m => m.state === "loaded").map(m => m.id);
  $("#sModels").textContent = S.roles.scan
    ? "scan: " + S.roles.scan + (loaded.length ? "   loaded: " + loaded.join(", ") : "") : "";
}
function setConn(kind, txt){ $("#dotConn").className = "dot " + kind; $("#sConn").textContent = txt; }

/* Detect models without being asked. Nothing in the app can work until this has
   run once, so making the user press a button first was simply a trap. */
let connecting = null;
async function autoConnect(){
  if (connecting) return connecting;
  connecting = (async () => {
    setConn("busy", "Connecting…");
    const r = await detectModels();
    if (r.ok){
      S.connected = true;
      setConn("on", "Connected");
      renderModels();
    } else {
      S.connected = false;
      setConn("off", "Not connected");
    }
    connecting = null;
    return r.ok;
  })();
  return connecting;
}
/* Resolves the chat model, connecting first if we have not looked yet. */
async function ensureChatModel(){
  if (!S.models.length) await autoConnect();
  let m = chatModel();
  if (!m && S.models.length) return null;
  return m || null;
}
