/* ================= library =================
   A flat gallery of every photo, newest first, with a size slider -- and a
   viewer that grows out of the tile you click. Like the timeline it is only a
   view over records already in memory; nothing here calls a model.

   6,635 tiles are never in the DOM at once. The grid is virtualised: tiles are
   absolutely positioned inside a container of the full height, and only the
   rows near the viewport exist. Their thumbnails are pinned while shown and
   released when they scroll away, so the thumbnail cache stays bounded. */

const GAL = { list:[], built:0, size:130, desc:true, gap:2, cols:1, cell:0, rows:0,
              shown:new Map(), raf:0, loading:false,
              view:"all",                     // "all" or "removed"
              selMode:false, sel:new Set(), last:-1, removed:0 };
try { const v = +localStorage.getItem("ps.galSize"); if (v >= 70 && v <= 260) GAL.size = v; } catch {}

/* Newest first, undated last in either direction. The clock time is used where
   it exists; a record with only a day falls back to midnight of that day. */
function galSortKey(r){
  const t = Date.parse(r.date_taken);
  if (!isNaN(t)) return t;
  const k = tlDayKey(r);
  return k ? Date.parse(k) : null;
}
function galBuild(){
  const dated = [], undated = [];
  let removed = 0;
  for (const r of IDX.records.values()){
    if (r.deleted || r.status === "error") continue;
    /* `hidden` is the user's "remove from library". It is deliberately not
       `deleted`: the scan plan treats a deleted record as absent and would
       index the same file again on the next scan. */
    if (r.hidden) removed++;
    if (!!r.hidden !== (GAL.view === "removed")) continue;
    const t = galSortKey(r);
    (t == null ? undated : dated).push({ r, t });
  }
  dated.sort((a, b) => GAL.desc ? b.t - a.t : a.t - b.t);
  GAL.list = dated.concat(undated);
  GAL.undated = undated.length;
  GAL.removed = removed;
  const inList = new Set(GAL.list.map(x => x.r.id));
  for (const id of GAL.sel) if (!inList.has(id)) GAL.sel.delete(id);
}

function galMessage(text){
  const m = $("#galMsg");
  m.hidden = !text; m.textContent = text || "";
}

function galClear(){
  for (const f of GAL.shown.values()){ f.remove(); thumbUnpin(f.dataset.id); }
  GAL.shown.clear();
}

/* Works out columns and tile size from the container width and the slider,
   then (re)draws. Keeps the row at the top of the screen where it was. */
function galLayout(){
  const host = $("#galGrid");
  const w = host.clientWidth;
  if (!w || !GAL.list.length) return;
  const oldRow = GAL.cell ? Math.max(0, Math.floor((100 - host.getBoundingClientRect().top)
                                                    / (GAL.cell + GAL.gap))) : 0;
  const oldCols = GAL.cols, oldH = GAL.cell + GAL.gap;
  GAL.cols = Math.max(1, Math.round((w + GAL.gap) / (GAL.size + GAL.gap)));
  GAL.cell = (w - GAL.gap * (GAL.cols - 1)) / GAL.cols;
  GAL.rows = Math.ceil(GAL.list.length / GAL.cols);
  const rowH = GAL.cell + GAL.gap;
  host.style.height = Math.max(0, GAL.rows * rowH - GAL.gap) + "px";
  galClear();
  if (oldH > GAL.gap && (oldCols !== GAL.cols || Math.abs(oldH - rowH) > .5))
    window.scrollBy(0, Math.floor(oldRow * oldCols / GAL.cols) * rowH - oldRow * oldH);
  galRender();
}

function galQueue(){ if (!GAL.raf) GAL.raf = requestAnimationFrame(galRender); }

function galTile(i){
  const r = GAL.list[i].r;
  const row = Math.floor(i / GAL.cols), col = i % GAL.cols;
  const f = el("figure", "gtile");
  f.style.cssText = "left:" + col * (GAL.cell + GAL.gap) + "px;top:" + row * (GAL.cell + GAL.gap)
    + "px;width:" + GAL.cell + "px;height:" + GAL.cell + "px";
  f.tabIndex = 0;
  f.dataset.id = r.id;           // tiles outlive the list they were drawn from
  f.title = r.caption || r.name || "";
  const im = el("img");
  im.alt = r.caption || r.name || "";
  im.draggable = false;
  thumbPin(r.id);
  thumbUrl(r.id).then(u => { if (u) im.src = u; });
  f.append(im);
  if (GAL.sel.has(r.id)) f.classList.add("sel");
  f.onclick = e => galClick(i, e);
  f.onkeydown = e => { if (e.key === "Enter" || e.key === " "){ e.preventDefault(); galClick(i, e); } };
  return f;
}

function galRender(){
  GAL.raf = 0;
  const host = $("#galGrid");
  if ($("#tab-library").hidden || !GAL.cell) return;
  const top = host.getBoundingClientRect().top, rowH = GAL.cell + GAL.gap, buf = 700;
  const r0 = Math.max(0, Math.floor((-top - buf) / rowH));
  const r1 = Math.min(GAL.rows - 1, Math.floor((-top + window.innerHeight + buf) / rowH));
  const lo = r0 * GAL.cols, hi = Math.min(GAL.list.length - 1, (r1 + 1) * GAL.cols - 1);
  for (const [i, f] of GAL.shown){
    if (i < lo || i > hi){ f.remove(); thumbUnpin(f.dataset.id); GAL.shown.delete(i); }
  }
  const frag = document.createDocumentFragment();
  for (let i = lo; i <= hi; i++){
    if (GAL.shown.has(i)) continue;
    const f = galTile(i);
    GAL.shown.set(i, f); frag.append(f);
  }
  host.append(frag);
}

function galBar(){
  const removedView = GAL.view === "removed";
  $("#galCount").textContent = removedView
    ? GAL.list.length.toLocaleString() + " removed — hidden from search, never deleted"
    : GAL.list.length.toLocaleString() + " photos"
      + (GAL.undated ? " · " + GAL.undated.toLocaleString() + " undated" : "");
  $("#galSort").textContent = GAL.desc ? "Newest first" : "Oldest first";
  $("#galSize").value = String(GAL.size);
  $("#galRemoved").textContent = removedView ? "Back to library"
    : "Removed" + (GAL.removed ? " (" + GAL.removed.toLocaleString() + ")" : "");
  $("#galRemoved").hidden = !removedView && !GAL.removed;
  const n = GAL.sel.size;
  $("#galSelect").textContent = GAL.selMode ? "Done" : "Select";
  $("#galSelCount").hidden = !GAL.selMode;
  $("#galSelCount").textContent = n ? n.toLocaleString() + " selected" : "Click photos to select";
  $("#galAct").hidden = !GAL.selMode;
  $("#galAct").disabled = !n;
  $("#galAct").textContent = removedView ? "Restore" : "Remove";
  $("#galAct").classList.toggle("danger", !removedView);
  $("#galGrid").classList.toggle("selecting", GAL.selMode);
}

/* ---- selecting and removing ---- */
function galPaint(){
  for (const f of GAL.shown.values()) f.classList.toggle("sel", GAL.sel.has(f.dataset.id));
  galBar();
}
function galClick(i, e){
  if (!GAL.selMode){ openViewer(i); return; }
  const id = GAL.list[i].r.id;
  if (e && e.shiftKey && GAL.last >= 0){
    const [a, b] = GAL.last < i ? [GAL.last, i] : [i, GAL.last];
    for (let k = a; k <= b; k++) GAL.sel.add(GAL.list[k].r.id);
  } else if (GAL.sel.has(id)) GAL.sel.delete(id);
  else GAL.sel.add(id);
  GAL.last = i;
  galPaint();
}
function galSelectMode(on){
  GAL.selMode = on;
  if (!on){ GAL.sel.clear(); GAL.last = -1; }
  galPaint();
}

/* Marks photos hidden (or brings them back). Only the index changes: the
   original files are never touched. The record is rewritten in full from disk
   so the model's raw output survives, and memory is updated only after the
   write succeeded, so a failed write leaves the screen telling the truth. */
async function galApply(ids, hide, quiet){
  ids = [...ids].filter(id => IDX.records.has(id));
  if (!ids.length) return 0;
  try {
    await ensureIndex(null, { write:false });
    const full = await readFullRecords(new Set(ids));
    const at = new Date().toISOString();
    const lines = ids.map(id => {
      const base = full.get(id) || IDX.records.get(id);
      return hide ? { ...base, hidden:true, hidden_at:at }
                  : { ...base, hidden:false, hidden_at:undefined };
    });
    await appendLines("records.jsonl", lines);
    for (const l of lines) IDX.records.set(l.id, lighten(l));
  } catch (e){
    toast("Could not " + (hide ? "remove" : "restore") + " — " + errText(e));
    return 0;
  }
  rebuildDerived();
  TL.built = 0;
  galBuild(); galBar(); galClear(); galLayout();
  if (!quiet) galUndo(ids, hide);
  return ids.length;
}

function galUndo(ids, hide){
  const n = ids.length, noun = n === 1 ? "1 photo" : n + " photos";
  const u = $("#undo");
  $("#undoMsg").textContent = (hide ? "Removed " : "Restored ") + noun
    + (hide ? " from the library. The file is untouched." : ".");
  u.hidden = false;
  $("#undoBtn").onclick = async () => {
    u.hidden = true;
    await galApply(ids, !hide, true);
  };
  clearTimeout(galUndo._t);
  galUndo._t = setTimeout(() => { u.hidden = true; }, 9000);
}

async function galAct(){
  const ids = [...GAL.sel];
  if (!ids.length) return;
  if (GAL.view === "all" && ids.length >= 25
      && !confirm("Remove " + ids.length + " photos from the library?\n\nThe files stay where they are and you can restore them from Removed.")) return;
  const n = await galApply(ids, GAL.view === "all");
  if (n){ GAL.sel.clear(); GAL.last = -1; galPaint(); }
}

/* Scrolls just far enough to bring tile i into view; used when the viewer
   steps to a photo whose tile is off screen, so closing can zoom back to it. */
function galReveal(i){
  if (!GAL.cell) return;
  const host = $("#galGrid"), rowH = GAL.cell + GAL.gap;
  const y = host.getBoundingClientRect().top + Math.floor(i / GAL.cols) * rowH;
  const lo = 100, hi = window.innerHeight - 40 - rowH;     // clear of the bars
  if (y < lo) window.scrollBy(0, y - lo - rowH);
  else if (y > hi) window.scrollBy(0, y - hi);
  galRender();
}

let libLoading = false;
async function onLibraryShown(force){
  if (libLoading) return;
  if (!force && GAL.built && GAL.built === IDX.records.size){ galLayout(); return; }
  libLoading = true;
  try {
    if (!IDX.dir || !IDX.loaded){
      if (!S.dirHandle && !S.indexDirHandle){
        galMessage("Connect a folder in Settings first.");
        return;
      }
      galMessage("Opening the index…");
      await ensureIndex(null, { write:false });
      await loadRecords();
    }
    galBuild();
    GAL.built = IDX.records.size;
    galMessage(GAL.list.length ? "" : "Nothing indexed yet — run a scan first.");
    galBar();
    GAL.cell = 0;                       // a fresh list has no scroll anchor
    galClear();
    galLayout();
  } catch (e){
    galMessage(errText(e));
  } finally { libLoading = false; }
}

$("#galSize").oninput = e => {
  GAL.size = +e.target.value;
  try { localStorage.setItem("ps.galSize", String(GAL.size)); } catch {}
  galLayout();
};
$("#galSelect").onclick = () => galSelectMode(!GAL.selMode);
$("#galAct").onclick = galAct;
$("#galRemoved").onclick = () => {
  GAL.view = GAL.view === "all" ? "removed" : "all";
  GAL.sel.clear(); GAL.last = -1;
  galBuild(); galBar(); galClear(); galLayout();
  window.scrollTo(0, 0);
};
document.addEventListener("keydown", e => {
  if (VW.open || $("#tab-library").hidden || !GAL.selMode) return;
  if (e.target.closest && e.target.closest("input,textarea,select")) return;
  if (e.key === "Escape") galSelectMode(false);
  else if (e.key === "Delete" || e.key === "Backspace") galAct();
  else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a"){
    for (const x of GAL.list) GAL.sel.add(x.r.id);
    galPaint();
  } else return;
  e.preventDefault();
});
$("#galSort").onclick = () => {
  GAL.desc = !GAL.desc;
  galBuild(); galBar(); galClear(); galRender();
  window.scrollTo(0, 0);
};
window.addEventListener("scroll", galQueue, { passive:true });
window.addEventListener("resize", () => {
  if (!$("#tab-library").hidden) galLayout();
  if (VW.open) vwPlace(false);
});

/* ---- viewer ---- */
const VW = { open:false, i:-1, tok:0, url:null, info:false };

function vwRectFor(img){
  const availW = window.innerWidth - (VW.info ? 320 : 0), top = 56, availH = window.innerHeight - top - 16;
  const ar = img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 1;
  const w = Math.min(availW - 32, availH * ar), h = w / ar;
  return { left:(availW - w) / 2, top:top + (availH - h) / 2, width:w, height:h };
}
function vwSet(img, rc){
  img.style.left = rc.left + "px"; img.style.top = rc.top + "px";
  img.style.width = rc.width + "px"; img.style.height = rc.height + "px";
}
/* Fits the photo to the free space. Animated when the layout changes under it
   (opening the info panel), instant while the window itself is being resized. */
function vwPlace(animate){
  const img = $("#vwImg");
  img.classList.toggle("still", !animate);
  vwSet(img, vwRectFor(img));
}

function vwFill(r){
  $("#vwName").textContent = r.name || r.path;
  $("#vwWhen").textContent = [r.when_phrase, r.place].filter(Boolean).join(" · ");
  const meta = $("#vwMeta"); meta.textContent = "";
  meta.append(metaList(r));
  $("#vwNote").textContent = "";
  $("#vwRemove").textContent = GAL.view === "removed" ? "Restore" : "Remove";
  $("#vwPrev").disabled = VW.i <= 0;
  $("#vwNext").disabled = VW.i >= GAL.list.length - 1;
}

/* The stored thumbnail is on screen the instant the viewer opens; the original
   replaces it once it has decoded, in the same box, so nothing jumps. */
async function vwLoadOriginal(r, tok){
  const note = t => { if (tok === VW.tok) $("#vwNote").textContent = t; };
  try {
    if (!/\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(r.path)){
      note("Showing the stored thumbnail — the browser cannot display this format directly.");
      return;
    }
    const f = await fileByPath(r.path);
    if (!f){
      note("The original is not reachable (the folder is not connected), so this is the stored thumbnail.");
      return;
    }
    const url = URL.createObjectURL(f);
    const probe = new Image();
    probe.src = url;
    await probe.decode();
    if (tok !== VW.tok){ URL.revokeObjectURL(url); return; }
    if (VW.url) URL.revokeObjectURL(VW.url);
    VW.url = url;
    $("#vwImg").src = url;
    vwPlace(false);
  } catch (e){
    note("Original not reachable (" + errText(e) + ") — showing the thumbnail.");
  }
}

async function vwShow(i){
  const tok = ++VW.tok, r = GAL.list[i].r, img = $("#vwImg");
  VW.i = i;
  vwFill(r);
  const u = await thumbUrl(r.id);
  if (tok !== VW.tok) return;
  img.src = u || "";
  try { await img.decode(); } catch {}
  if (tok !== VW.tok) return;
  vwLoadOriginal(r, tok);
}

async function openViewer(i){
  if (VW.open || !GAL.list[i]) return;
  VW.open = true;
  const tile = GAL.shown.get(i), v = $("#viewer"), img = $("#vwImg");
  const from = tile ? tile.getBoundingClientRect() : null;
  VW.info = false; v.classList.remove("info");
  v.hidden = false;
  const tok = ++VW.tok;
  VW.i = i;
  vwFill(GAL.list[i].r);
  const u = await thumbUrl(GAL.list[i].r.id);
  if (tok !== VW.tok) return;
  img.classList.add("still");
  img.src = u || "";
  try { await img.decode(); } catch {}
  if (tok !== VW.tok) return;
  /* Start exactly over the tile, then let the transition carry it to full size. */
  if (from) vwSet(img, { left:from.left, top:from.top, width:from.width, height:from.height });
  else vwSet(img, vwRectFor(img));
  img.style.opacity = from ? "1" : "0";
  void img.offsetWidth;                                  // commit the start state
  img.classList.remove("still");
  v.classList.add("on");
  vwSet(img, vwRectFor(img));
  img.style.opacity = "1";
  vwLoadOriginal(GAL.list[i].r, tok);
}

function closeViewer(){
  if (!VW.open) return;
  VW.open = false;
  const tok = ++VW.tok, v = $("#viewer"), img = $("#vwImg");
  const tile = GAL.shown.get(VW.i);
  const rc = tile ? tile.getBoundingClientRect() : null;
  const onScreen = rc && rc.bottom > 0 && rc.top < window.innerHeight;
  img.classList.remove("still");
  v.classList.remove("on", "info");
  if (onScreen) vwSet(img, { left:rc.left, top:rc.top, width:rc.width, height:rc.height });
  else img.style.opacity = "0";
  setTimeout(() => {
    if (VW.open || tok !== VW.tok) return;
    v.hidden = true;
    img.removeAttribute("src");
    if (VW.url){ URL.revokeObjectURL(VW.url); VW.url = null; }
  }, 320);
}

function vwStep(d){
  const ni = VW.i + d;
  if (!VW.open || ni < 0 || ni >= GAL.list.length) return;
  const img = $("#vwImg");
  galReveal(ni);
  img.classList.add("still");
  img.classList.remove("swap"); void img.offsetWidth; img.classList.add("swap");
  vwShow(ni).then(() => vwPlace(false));
}

/* Removes (or restores) the photo on screen and carries on with its neighbour,
   so a run of rejects can be cleared without leaving the viewer. */
async function vwRemove(){
  if (!VW.open) return;
  const i = VW.i;
  if (!await galApply([GAL.list[i].r.id], GAL.view === "all")) return;
  if (!GAL.list.length){ closeViewer(); return; }
  const ni = Math.min(i, GAL.list.length - 1);
  galReveal(ni);
  const img = $("#vwImg");
  img.classList.add("still");
  img.classList.remove("swap"); void img.offsetWidth; img.classList.add("swap");
  await vwShow(ni);
  vwPlace(false);
}
$("#vwRemove").onclick = vwRemove;
$("#vwClose").onclick = closeViewer;
$("#vwPrev").onclick = () => vwStep(-1);
$("#vwNext").onclick = () => vwStep(1);
$("#vwInfoBtn").onclick = () => {
  VW.info = !VW.info;
  $("#viewer").classList.toggle("info", VW.info);
  vwPlace(true);
};
$("#viewer").addEventListener("click", e => {
  if (e.target.classList.contains("vwBack")) closeViewer();
});
/* Keep the page behind the viewer from scrolling without locking it (a lock
   would change the scrollbar width and re-flow the grid underneath). */
$("#viewer").addEventListener("wheel", e => {
  if (!e.target.closest("#vwInfo")) e.preventDefault();
}, { passive:false });
document.addEventListener("keydown", e => {
  if (!VW.open) return;
  if (e.key === "Escape") closeViewer();
  else if (e.key === "ArrowLeft") vwStep(-1);
  else if (e.key === "ArrowRight") vwStep(1);
  else if (e.key === "i" || e.key === "I") $("#vwInfoBtn").click();
  else if (e.key === "Delete" || e.key === "Backspace") vwRemove();
  else return;
  e.preventDefault();
});
