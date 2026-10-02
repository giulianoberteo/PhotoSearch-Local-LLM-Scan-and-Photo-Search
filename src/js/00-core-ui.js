/* ================= tabs =================
   Each tab has an address: PhotoSearch.html#library, #chat, #timeline, #people,
   #scan or #settings. Choosing a tab updates the address (so Back and Forward
   work, and a tab can be bookmarked or shared), and opening or changing an
   address chooses the tab. Hashes that are not a tab, such as #selftest, are
   left alone. */
const TABS = ["library","favourites","search","chat","timeline","people","scan","settings"];
/* Favourites is the Library's grid showing only favourites, so it has no section of its own. */
const TAB_SECTION = { favourites:"library" };
let curTab = "settings";
function tabFromHash(hash){
  let h = hash == null ? location.hash : hash;
  try { h = decodeURIComponent(h); } catch {}
  h = h.replace(/^#\/?/, "").toLowerCase().split(/[&?\/]/)[0];
  return TABS.includes(h) ? h : null;
}
/* Some tabs read the whole index, so they are built when first shown rather
   than at boot: opening the app must not wait for them. */
function tabShownHook(name){
  if (name === "library" && typeof onLibraryShown === "function"){
    onLibraryShown();
    if (GAL.view === "favourites") galSetView("all");
  }
  if (name === "favourites" && typeof galSetView === "function") galSetView("favourites");
  if (name === "search" && typeof onSearchShown === "function") onSearchShown();
  if (name === "chat" && typeof chatFillGrids === "function") chatFillGrids();
  if (name === "timeline" && typeof onTimelineShown === "function") onTimelineShown();
  if (name === "people" && typeof onPeopleShown === "function") onPeopleShown();
}
function showTab(name){
  curTab = name;
  document.querySelectorAll('nav button').forEach(x =>
    x.setAttribute("aria-selected", String(x.dataset.tab === name)));
  const sec = TAB_SECTION[name] || name;
  TABS.forEach(t => { const s = $("#tab-" + t); if (s) s.hidden = (t !== sec); });
  tabShownHook(name);
}
/* A folder connecting after the page loaded (Chrome drops access on reload, so
   this is the normal order) must not leave the open tab on "connect a folder". */
function refreshActiveTab(){ tabShownHook(curTab); }
document.querySelectorAll('nav button').forEach(b => b.onclick = () => {
  const t = b.dataset.tab;
  if (tabFromHash() !== t) location.hash = t;      // adds a history entry
  showTab(t);
});
window.addEventListener("hashchange", () => {
  const t = tabFromHash();
  if (t && t !== curTab) showTab(t);
});

/* ================= browser gate ================= */
function checkBrowser(){
  const miss = [];
  if (!window.showDirectoryPicker) miss.push("File System Access API");
  if (!window.createImageBitmap) miss.push("createImageBitmap");
  if (!window.OffscreenCanvas) miss.push("OffscreenCanvas");
  if (!miss.length) return true;
  const w = $("#browserWarn"); w.hidden = false; w.innerHTML = "";
  /* Chrome and Edge hide the File System Access API on an insecure page, so a
     supported browser opened over plain http:// from another machine looks
     unsupported. Say what to change instead of blaming the browser. */
  if (!window.isSecureContext && miss.includes("File System Access API")){
    w.append(el("b", null, "This page is not on a secure address. "));
    w.append(document.createTextNode(
      "Chrome and Edge only allow choosing folders on https:// or localhost, and this page was "
      + "opened from " + location.origin + ". Open it over HTTPS, or from localhost (for example "
      + "through an SSH tunnel). See docs/SETUP.md, \u201CServing it to other machines\u201D."));
  } else {
    w.append(el("b", null, "This browser is not supported. "));
    w.append(document.createTextNode(
      "PhotoSearch needs desktop Chrome or Edge. Missing: " + miss.join(", ") + "."));
  }
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

/* Browsers describe file and network trouble in terms that explain nothing to
   the person looking at them: "It was determined that certain files are unsafe
   for access within a Web application" is a security rule, not a damaged file.
   This turns the common ones into a sentence plus the steps that fix them. It
   only ever ADDS to errText(), which stays exactly as it was. */
const ERR_HELP = [
  { test: (n, m) => n === "SecurityError" || /unsafe for access|too many calls/i.test(m),
    hint: "Chrome blocked access to a file or folder; this is a security rule, not damage to your files.",
    steps: [
      "Self-test, or anything using the browser's private storage: a page opened from disk (file://) is not given it. Quit Chrome completely and start it with --allow-file-access-from-files, or serve the folder and open http://localhost:8000/PhotoSearch.html (run: python3 -m http.server 8000).",
      "Choosing a folder: Chrome refuses a few places outright (your home folder, Desktop, Documents, Downloads, and system folders themselves). Pick a subfolder inside one.",
      "On a slow network share: lower \u201cFile-stat concurrency\u201d in Settings so fewer files are touched at once." ] },
  { test: n => n === "NotAllowedError",
    hint: "Permission to use the folder was refused or has expired.",
    steps: [ "Chrome forgets folder access whenever the page reloads. Press Reconnect, or choose the folder again.",
             "If Chrome asked for permission, choose Allow." ] },
  { test: n => n === "NotFoundError",
    hint: "A file or folder could not be found.",
    steps: [ "Is the drive or network share still mounted?",
             "Was the folder moved or renamed? Choose it again, then press Refresh plan." ] },
  { test: n => n === "AbortError",
    hint: "The action was cancelled.",
    steps: [ "If you closed a picker, this is expected. Otherwise try again." ] },
  { test: n => n === "QuotaExceededError",
    hint: "There is no space left for this.",
    steps: [ "Free some disk space, or choose another place for the index in Settings." ] },
  { test: n => n === "NoModificationAllowedError" || n === "InvalidStateError",
    hint: "The file is locked or read-only.",
    steps: [ "Close any other tab or program using the same index.",
             "Check the folder is not read-only (network shares often are)." ] },
  { test: (n, m) => /failed to fetch|networkerror|load failed/i.test(m),
    hint: "Could not reach the model server.",
    steps: [ "Is the server running?", "Is the URL in Settings right?",
             "Is this page allowed to connect (CORS)? Settings \u2192 Test connection names the fix." ] },
  { test: (n, m) => /did not finish within|timed out|timeout/i.test(m) || n === "TimeoutError",
    hint: "A storage operation took too long.",
    steps: [ "A sleeping NAS can take half a minute to wake. Wait, then try again." ] }
];
function errExplain(e){
  if (!e) return null;
  const n = String(e.name || ""), m = String(e.message || "");
  return ERR_HELP.find(h => h.test(n, m)) || null;
}
function errHint(e){ const h = errExplain(e); return h ? h.hint : ""; }
/* errText plus the plain-language reading, for anything shown to a person. */
function humanError(e){
  const t = errText(e), h = errHint(e);
  return h ? t + " \u2014 " + h : t;
}

function toast(msg){
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 7000);
}

/* In-app replacement for window.confirm(): a styled <dialog> that resolves true
   (confirm) or false (Cancel, Esc, or a click outside). `body` is an array of
   paragraphs; an item may be a string or an array of strings/Nodes. */
function confirmDialog({ title, body = [], confirmLabel = "Continue", cancelLabel = "Cancel", note }){
  return new Promise(resolve => {
    const d = el("dialog", "dlg");
    d.setAttribute("aria-labelledby", "dlgTitle");
    d.append(el("h3", null, title));
    d.firstChild.id = "dlgTitle";
    for (const p of body){
      const para = el("p");
      para.append(...[].concat(p));
      d.append(para);
    }
    if (note) d.append(el("p", "dlgNote", note));
    const acts = el("div", "dlgActs");
    const no = el("button", "btn sec", cancelLabel), yes = el("button", "btn", confirmLabel);
    acts.append(no, yes);
    d.append(acts);
    let result = false;
    no.onclick = () => d.close();
    yes.onclick = () => { result = true; d.close(); };
    d.addEventListener("click", e => { if (e.target === d) d.close(); });
    d.addEventListener("close", () => { d.remove(); resolve(result); });
    document.body.append(d);
    d.showModal();
    yes.focus();
  });
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

