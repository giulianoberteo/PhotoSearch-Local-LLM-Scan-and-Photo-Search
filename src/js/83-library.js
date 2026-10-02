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
              view:"all",                     // "all", "removed" or "search"
              chips:[], texts:[], results:[],    // the header search, shown as a view of this grid
              selMode:false, sel:new Set(), last:-1, removed:0 };
try { const v = +localStorage.getItem("ps.galSize"); if (v >= 70 && v <= 260) GAL.size = v; } catch {}

/* Rotation is a VIEW setting. The original file is never touched, so the angle
   lives in the photo's record (degrees clockwise: 0, 90, 180 or 270) and is
   applied when the picture is drawn. CSS `rotate` is used rather than
   `transform` so it composes with the hover and selection scaling. */
const normRot = d => ((Math.round(d / 90) * 90) % 360 + 360) % 360;
const rotOdd = a => Math.abs(Math.round(a / 90)) % 2 === 1;
function applyRotation(im, rec){ im.style.rotate = rec && rec.rotation ? rec.rotation + "deg" : ""; }

/* Newest first, undated last in either direction. The clock time is used where
   it exists; a record with only a day falls back to midnight of that day. */
function galSortKey(r){
  const t = Date.parse(r.date_taken);
  if (!isNaN(t)) return t;
  const k = tlDayKey(r);
  return k ? Date.parse(k) : null;
}
function galBuild(){
  if (GAL.view === "search"){
    /* Search results keep the order the ranker gave them. Records are looked up
       afresh, so a photo removed or rotated since the search is still right. */
    const list = [];
    let removed = 0;
    for (const r of IDX.records.values())
      if (r.hidden && !r.deleted && r.status !== "error") removed++;
    for (const id of GAL.results){
      const r = IDX.records.get(id);
      if (r && !r.hidden && !r.deleted && r.status !== "error") list.push({ r, t:galSortKey(r) });
    }
    GAL.list = list; GAL.undated = 0; GAL.removed = removed;
    const inList = new Set(list.map(x => x.r.id));
    for (const id of GAL.sel) if (!inList.has(id)) GAL.sel.delete(id);
    return;
  }
  const dated = [], undated = [];
  let removed = 0;
  for (const r of IDX.records.values()){
    if (r.deleted || r.status === "error") continue;
    /* `hidden` is the user's "remove from library". It is deliberately not
       `deleted`: the scan plan treats a deleted record as absent and would
       index the same file again on the next scan. */
    if (r.hidden) removed++;
    if (!!r.hidden !== (GAL.view === "removed")) continue;
    if (GAL.view === "favourites" && !r.favourite) continue;
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
  if (!GAL.list.length){ host.style.height = "0px"; GAL.rows = 0; return; }
  if (!w) return;
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
  applyRotation(im, r);
  thumbUrl(r.id).then(u => { if (u) im.src = u; });
  f.append(im);
  const heart = el("button", "gheart");
  heart.title = "Favourite"; heart.setAttribute("aria-label", "Favourite");
  heart.onclick = e => { e.stopPropagation(); galFavourite([r.id], !(IDX.records.get(r.id) || {}).favourite); };
  f.append(heart);
  galHeart(heart, r);
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

/* The active search is shown as tokens inside the search field (88-search.js). */
function galChips(){ if (typeof sgRenderChips === "function") sgRenderChips(); }
function galBar(){
  const removedView = GAL.view === "removed", searchView = GAL.view === "search",
        favView = GAL.view === "favourites";
  galChips();
  $("#galClearSearch").hidden = !searchView;
  $("#galSort").hidden = searchView;
  $("#galCount").textContent = searchView
    ? GAL.list.length.toLocaleString() + (GAL.list.length === 1 ? " result" : " results")
    : favView ? GAL.list.length.toLocaleString() + (GAL.list.length === 1 ? " favourite" : " favourites")
    : removedView
    ? GAL.list.length.toLocaleString() + " removed — hidden from search, never deleted"
    : GAL.list.length.toLocaleString() + " photos"
      + (GAL.undated ? " · " + GAL.undated.toLocaleString() + " undated" : "");
  $("#galSort").textContent = GAL.desc ? "Newest first" : "Oldest first";
  $("#galSize").value = String(GAL.size);
  $("#galRemoved").textContent = removedView ? "Back to library"
    : "Removed" + (GAL.removed ? " (" + GAL.removed.toLocaleString() + ")" : "");
  $("#galRemoved").hidden = searchView || (!removedView && !GAL.removed);
  const n = GAL.sel.size;
  $("#galSelect").textContent = GAL.selMode ? "Done" : "Select";
  $("#galSelCount").hidden = !GAL.selMode;
  $("#galSelCount").textContent = n ? n.toLocaleString() + " selected" : "Click photos to select";
  $("#galRotL").hidden = $("#galRotR").hidden = !GAL.selMode;
  $("#galRotL").disabled = $("#galRotR").disabled = !n;
  $("#galFav").hidden = !GAL.selMode;
  $("#galFav").disabled = !n;
  $("#galFav").textContent = galAllFav() ? "\u2665 Unfavourite" : "\u2661 Favourite";
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

/* Every index change made from the Library goes through here: the record is
   rewritten in full from disk (so the model's raw output survives), and memory
   is updated only after the write succeeded, so a failed write leaves the
   screen telling the truth. Calls are queued, because two quick clicks would
   otherwise both start from the same old value and one would be lost. */
let galIO = Promise.resolve();
function galPersist(ids, change){
  const run = async () => {
    ids = [...ids].filter(id => IDX.records.has(id));
    if (!ids.length) return 0;
    await ensureIndex(null, { write:false });
    const full = await readFullRecords(new Set(ids));
    const lines = ids.map(id => change({ ...(full.get(id) || IDX.records.get(id)) }));
    await appendLines("records.jsonl", lines);
    for (const l of lines) IDX.records.set(l.id, lighten(l));
    return lines.length;
  };
  const p = galIO.then(run, run);
  galIO = p.catch(() => {});
  return p;
}

/* Marks photos hidden (or brings them back). Only the index changes: the
   original files are never touched. */
async function galApply(ids, hide, quiet){
  ids = [...ids].filter(id => IDX.records.has(id));
  if (!ids.length) return 0;
  const at = new Date().toISOString();
  try {
    await galPersist(ids, base => hide ? { ...base, hidden:true, hidden_at:at }
                                       : { ...base, hidden:false, hidden_at:undefined });
  } catch (e){
    toast("Could not " + (hide ? "remove" : "restore") + " — " + humanError(e));
    return 0;
  }
  rebuildDerived();
  TL.built = 0;
  galBuild(); galBar(); galClear(); galLayout();
  if (!quiet) galUndo(ids, hide);
  return ids.length;
}

/* Turns photos by `delta` degrees (multiples of 90, clockwise positive). Each
   photo moves from its own current angle, so a mixed selection stays mixed and
   the exact opposite turn is a perfect undo. */
async function galRotate(ids, delta, quiet){
  ids = [...ids].filter(id => IDX.records.has(id));
  if (!ids.length) return 0;
  try {
    await galPersist(ids, base => {
      const cur = IDX.records.get(base.id);
      return { ...base, rotation: normRot(((cur && cur.rotation) || 0) + delta) };
    });
  } catch (e){
    toast("Could not rotate — " + humanError(e));
    return 0;
  }
  const set = new Set(ids);
  for (const x of GAL.list) if (set.has(x.r.id)) x.r = IDX.records.get(x.r.id);
  for (const f of GAL.shown.values()) applyRotation(f.firstChild, IDX.records.get(f.dataset.id));
  TL.built = 0;                       // the Timeline redraws its tiles next time it is shown
  if (!quiet){
    const n = ids.length, noun = n === 1 ? "1 photo" : n + " photos";
    galSnack("Rotated " + noun + (delta > 0 ? " right" : " left") + ". The file is untouched.",
             () => galRotate(ids, -delta, true));
  }
  return ids.length;
}

/* ---- favourites ----
   A heart, kept on the record like rotation: a mark the user made, not
   something the scan produced, so it survives a rescan and never touches the
   file. */
function galHeart(btn, rec){
  const on = !!(rec && rec.favourite);
  btn.textContent = on ? "\u2665" : "\u2661";
  btn.classList.toggle("on", on);
}
function galPaintHearts(){
  for (const f of GAL.shown.values()) galHeart(f.querySelector(".gheart"), IDX.records.get(f.dataset.id));
}
function galAllFav(){
  return GAL.sel.size > 0 && [...GAL.sel].every(id => (IDX.records.get(id) || {}).favourite);
}
async function galFavourite(ids, on, quiet){
  ids = [...ids].filter(id => IDX.records.has(id));
  if (!ids.length) return 0;
  try {
    await galPersist(ids, base => ({ ...base, favourite:on }));
  } catch (e){
    toast("Could not " + (on ? "favourite" : "unfavourite") + " \u2014 " + humanError(e));
    return 0;
  }
  const set = new Set(ids);
  for (const x of GAL.list) if (set.has(x.r.id)) x.r = IDX.records.get(x.r.id);
  TL.built = 0;
  if (GAL.view === "favourites"){        // an unfavourited photo leaves this view
    galBuild(); galBar(); galClear(); galLayout();
    galMessage(GAL.list.length ? "" : "No favourites yet. Click the heart on a photo to add it.");
  } else { galPaintHearts(); galBar(); }
  if (VW.open) vwHeart();
  if (!quiet){
    const n = ids.length, noun = n === 1 ? "1 photo" : n + " photos";
    galSnack((on ? "Added " + noun + " to Favourites." : "Removed " + noun + " from Favourites."),
             () => galFavourite(ids, !on, true));
  }
  return ids.length;
}
async function galFavSel(){
  const ids = [...GAL.sel];
  if (ids.length) await galFavourite(ids, !galAllFav());
}

/* Switches the grid between the whole library, favourites, and so on. */
async function galSetView(view){
  await onLibraryShown();
  if (!IDX.records.size) return;
  if (view === "favourites" && (GAL.chips.length || GAL.texts.length)){   // leave any search behind
    GAL.chips = []; GAL.texts = []; GAL.results = [];
    if (typeof sgRenderChips === "function") sgRenderChips();
  }
  GAL.view = view; GAL.sel.clear(); GAL.last = -1;
  galBuild(); galBar(); galClear(); GAL.cell = 0; galLayout();
  galMessage(GAL.list.length ? "" : (view === "favourites"
    ? "No favourites yet. Click the heart on a photo, or select photos and press Favourite." : ""));
  window.scrollTo(0, 0);
}

function galSnack(msg, undo){
  const u = $("#undo");
  $("#undoMsg").textContent = msg;
  u.hidden = false;
  $("#undoBtn").onclick = async () => { u.hidden = true; await undo(); };
  clearTimeout(galSnack._t);
  galSnack._t = setTimeout(() => { u.hidden = true; }, 9000);
}
function galUndo(ids, hide){
  const n = ids.length, noun = n === 1 ? "1 photo" : n + " photos";
  galSnack((hide ? "Removed " : "Restored ") + noun
             + (hide ? " from the library. The file is untouched." : "."),
           () => galApply(ids, !hide, true));
}

async function galRotSel(delta){
  const ids = [...GAL.sel];
  if (ids.length) await galRotate(ids, delta);
}

async function galAct(){
  const ids = [...GAL.sel];
  if (!ids.length) return;
  if (GAL.view !== "removed" && ids.length >= 25
      && !confirm("Remove " + ids.length + " photos from the library?\n\nThe files stay where they are and you can restore them from Removed.")) return;
  const n = await galApply(ids, GAL.view !== "removed");
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

/* One load at a time, and everyone who asks while it runs waits for the same
   one. A search started from another tab needs the index open before it can
   look anything up. */
let libJob = null;
function onLibraryShown(force){
  if (!libJob) libJob = libLoad(force).finally(() => { libJob = null; });
  return libJob;
}
async function libLoad(force){
  if (!force && GAL.built && GAL.built === IDX.records.size){ galLayout(); return; }
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
    galMessage(GAL.list.length ? "" : (GAL.view === "search" ? "No photos match this search."
                                                              : "Nothing indexed yet — run a scan first."));
    galBar();
    GAL.cell = 0;                       // a fresh list has no scroll anchor
    galClear();
    galLayout();
    if (RESTORE.pending && IDX.records.size) restoreView();
  } catch (e){
    galMessage(humanError(e));
  }
}

$("#galSize").oninput = e => {
  GAL.size = +e.target.value;
  try { localStorage.setItem("ps.galSize", String(GAL.size)); } catch {}
  galLayout();
};
$("#galSelect").onclick = () => galSelectMode(!GAL.selMode);
$("#galAct").onclick = galAct;
$("#galFav").onclick = galFavSel;
$("#galRotL").onclick = () => galRotSel(-90);
$("#galRotR").onclick = () => galRotSel(90);
$("#galRemoved").onclick = () => {
  GAL.view = GAL.view === "removed" ? "all" : "removed";
  GAL.sel.clear(); GAL.last = -1;
  galBuild(); galBar(); galClear(); galLayout();
  window.scrollTo(0, 0);
};
document.addEventListener("keydown", e => {
  if (VW.open || $("#tab-library").hidden || !GAL.selMode) return;
  if (e.target.closest && e.target.closest("input,textarea,select")) return;
  if (e.key === "Escape") galSelectMode(false);
  else if (e.key === "Delete" || e.key === "Backspace") galAct();
  else if ((e.key === "r" || e.key === "R") && !e.metaKey && !e.ctrlKey && !e.altKey)
    galRotSel(e.shiftKey ? -90 : 90);
  else if ((e.key === "f" || e.key === "F") && !e.metaKey && !e.ctrlKey && !e.altKey) galFavSel();
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
const VW = { open:false, i:-1, tok:0, url:null, info:false, angle:0, z:1, px:0, py:0 };
const VW_MAXZ = 8;

function vwRectFor(img){
  const availW = window.innerWidth - (VW.info ? 320 : 0), top = 56, availH = window.innerHeight - top - 16;
  let ar = img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 1;
  if (rotOdd(VW.angle)) ar = 1 / ar;            // a quarter turn swaps width and height
  const w = Math.min(availW - 32, availH * ar), h = w / ar;
  return { left:(availW - w) / 2, top:top + (availH - h) / 2, width:w, height:h };
}
/* `rc` is the box the photo should OCCUPY on screen. A quarter-turned element
   is laid out with width and height swapped and the same centre, then turned.
   VW.angle accumulates (90, 180, 270, 360 ...) so the animation takes the short
   way round; it is equivalent to the record's 0-270 value modulo 360. */
function vwSet(img, rc){
  const odd = rotOdd(VW.angle), w = odd ? rc.height : rc.width, h = odd ? rc.width : rc.height;
  img.style.width = w + "px"; img.style.height = h + "px";
  img.style.left = (rc.left + (rc.width - w) / 2) + "px";
  img.style.top = (rc.top + (rc.height - h) / 2) + "px";
  img.style.rotate = VW.angle + "deg";
  /* Zoom is a scale about the photo's centre plus a pan, kept so the photo
     never leaves the window. Both compose with the quarter turn above. */
  if (VW.z > 1){
    const mx = Math.max(0, (rc.width * VW.z - (window.innerWidth - (VW.info ? 320 : 0))) / 2),
          my = Math.max(0, (rc.height * VW.z - window.innerHeight) / 2);
    VW.px = Math.max(-mx, Math.min(mx, VW.px)); VW.py = Math.max(-my, Math.min(my, VW.py));
  } else { VW.px = 0; VW.py = 0; }
  img.style.scale = String(VW.z);
  img.style.translate = VW.px + "px " + VW.py + "px";
  img.classList.toggle("zoomed", VW.z > 1);
}
function vwZoomUI(){
  $("#vwZr").value = String(Math.round(VW.z * 100));
  $("#vwZv").textContent = VW.z <= 1 ? "Fit" : Math.round(VW.z * 100) + "%";
}
function vwZoomReset(){ VW.z = 1; VW.px = 0; VW.py = 0; vwZoomUI(); }
/* Zooms to `z`, keeping the point under (cx, cy) where it is, so the wheel
   zooms into whatever the pointer is over. */
function vwZoomTo(z, cx, cy){
  if (!VW.open) return;
  z = Math.max(1, Math.min(VW_MAXZ, z));
  const rc = vwRectFor($("#vwImg")), Cx = rc.left + rc.width / 2, Cy = rc.top + rc.height / 2;
  if (cx == null){ cx = Cx; cy = Cy; }
  const k = z / VW.z;
  VW.px = (cx - Cx) - k * (cx - Cx - VW.px);
  VW.py = (cy - Cy) - k * (cy - Cy - VW.py);
  VW.z = z;
  vwPlace(false);
  vwZoomUI();
}
/* Fits the photo to the free space. Animated when the layout changes under it
   (opening the info panel), instant while the window itself is being resized. */
function vwPlace(animate){
  const img = $("#vwImg");
  img.classList.toggle("still", !animate);
  vwSet(img, vwRectFor(img));
}

function vwHeart(){
  const rec = GAL.list[VW.i] && IDX.records.get(GAL.list[VW.i].r.id);
  const on = !!(rec && rec.favourite), b = $("#vwFav");
  b.textContent = on ? "\u2665" : "\u2661";
  b.classList.toggle("on", on);
  b.title = on ? "Remove from Favourites (F)" : "Add to Favourites (F)";
}
function vwFill(r){
  $("#vwName").textContent = r.name || r.path;
  $("#vwWhen").textContent = [r.when_phrase, r.place].filter(Boolean).join(" · ");
  const meta = $("#vwMeta"); meta.textContent = "";
  meta.append(metaList(r));
  $("#vwNote").textContent = "";
  $("#vwStatus").hidden = true;
  $("#vwRemove").textContent = GAL.view === "removed" ? "Restore" : "Remove";
  vwHeart();
  $("#vwPrev").disabled = VW.i <= 0;
  $("#vwNext").disabled = VW.i >= GAL.list.length - 1;
}

/* The stored thumbnail is on screen the instant the viewer opens; the original
   replaces it once it has decoded, in the same box, so nothing jumps. */
async function vwLoadOriginal(r, tok){
  /* Shown over the photo as well as in the Info panel: when this is the
     thumbnail, zooming is blurry and the reason has to be visible. */
  const note = t => {
    if (tok !== VW.tok) return;
    $("#vwNote").textContent = t;
    const st = $("#vwStatus"); st.textContent = t; st.hidden = !t;
  };
  try {
    const f = await fileByPath(r.path);
    if (!f){
      note("The original is not reachable (the folder is not connected), so this is the stored thumbnail.");
      return;
    }
    let url;
    if (/\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(r.path)) url = URL.createObjectURL(f);
    else {
      // RAW, HEIC and TIFF: decode again at display size (a RAW's embedded preview is full size).
      note("Loading the full-size picture\u2026");
      const big = await processImage(f, classifyFile(r.path), { bigPx:6000 });
      url = URL.createObjectURL(big.big);
      note("");
    }
    const probe = new Image();
    probe.src = url;
    await probe.decode();
    if (tok !== VW.tok){ URL.revokeObjectURL(url); return; }
    if (VW.url) URL.revokeObjectURL(VW.url);
    VW.url = url;
    $("#vwImg").src = url;
    vwPlace(false);
  } catch (e){
    note("Original not reachable (" + humanError(e) + ") — showing the thumbnail.");
  }
}

async function vwShow(i){
  const tok = ++VW.tok, r = GAL.list[i].r, img = $("#vwImg");
  VW.i = i;
  VW.angle = r.rotation || 0;
  vwZoomReset();
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
  vwZoomReset();
  v.hidden = false;
  const tok = ++VW.tok;
  VW.i = i;
  VW.angle = GAL.list[i].r.rotation || 0;
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
  vwZoomReset();
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
  if (!await galApply([GAL.list[i].r.id], GAL.view !== "removed")) return;
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

/* Turns the open photo at once, then saves it. If saving fails the picture
   turns back, so what is on screen is what is stored. */
async function vwRotate(dir){
  if (!VW.open || !GAL.list[VW.i]) return;
  const id = GAL.list[VW.i].r.id, was = VW.angle;
  VW.angle = was + dir * 90;
  vwPlace(true);
  if (!await galRotate([id], dir * 90, true) && VW.open && GAL.list[VW.i]
      && GAL.list[VW.i].r.id === id){
    VW.angle = was;
    vwPlace(true);
  }
}
/* Toggles the heart on the open photo. In the Favourites view an unfavourited
   photo leaves the list, so carry on with its neighbour, as Remove does. */
async function vwFavourite(){
  if (!VW.open || !GAL.list[VW.i]) return;
  const id = GAL.list[VW.i].r.id, i = VW.i;
  const on = !(IDX.records.get(id) || {}).favourite;
  if (!await galFavourite([id], on, true)) return;
  if (GAL.view === "favourites" && !on){
    if (!GAL.list.length){ closeViewer(); return; }
    const ni = Math.min(i, GAL.list.length - 1);
    galReveal(ni);
    const img = $("#vwImg");
    img.classList.add("still");
    img.classList.remove("swap"); void img.offsetWidth; img.classList.add("swap");
    await vwShow(ni);
    vwPlace(false);
  }
}
$("#vwFav").onclick = vwFavourite;
$("#vwRotL").onclick = () => vwRotate(-1);
$("#vwRotR").onclick = () => vwRotate(1);
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
  if (e.target.closest("#vwInfo")) return;
  e.preventDefault();
  if (e.target.closest(".vwBar, #vwZoom")) return;
  // Wheel and trackpad pinch (which arrives as ctrl+wheel) zoom into the pointer.
  vwZoomTo(VW.z * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX, e.clientY);
}, { passive:false });
$("#vwZr").oninput = () => vwZoomTo(+$("#vwZr").value / 100);
$("#vwZm").onclick = () => vwZoomTo(VW.z / 1.5);
$("#vwZp").onclick = () => vwZoomTo(VW.z * 1.5);
$("#vwZv").onclick = () => vwZoomTo(1);
$("#vwImg").addEventListener("dblclick", e => vwZoomTo(VW.z > 1 ? 1 : 2.5, e.clientX, e.clientY));
{
  let drag = null;
  const img = $("#vwImg");
  img.addEventListener("pointerdown", e => {
    if (VW.z <= 1 || e.button) return;
    drag = { x:e.clientX, y:e.clientY, px:VW.px, py:VW.py };
    img.setPointerCapture(e.pointerId); img.classList.add("drag");
  });
  img.addEventListener("pointermove", e => {
    if (!drag) return;
    VW.px = drag.px + e.clientX - drag.x; VW.py = drag.py + e.clientY - drag.y;
    vwPlace(false);
  });
  const end = () => { drag = null; img.classList.remove("drag"); };
  img.addEventListener("pointerup", end); img.addEventListener("pointercancel", end);
}
document.addEventListener("keydown", e => {
  if (!VW.open) return;
  if (e.key === "Escape") closeViewer();
  else if (e.key === "ArrowLeft") vwStep(-1);
  else if (e.key === "ArrowRight") vwStep(1);
  else if (e.key === "i" || e.key === "I") $("#vwInfoBtn").click();
  else if ((e.key === "+" || e.key === "=") && !e.metaKey && !e.ctrlKey) vwZoomTo(VW.z * 1.5);
  else if ((e.key === "-" || e.key === "_") && !e.metaKey && !e.ctrlKey) vwZoomTo(VW.z / 1.5);
  else if (e.key === "0" && !e.metaKey && !e.ctrlKey) vwZoomTo(1);
  else if (e.key === "Delete" || e.key === "Backspace") vwRemove();
  else if ((e.key === "r" || e.key === "R") && !e.metaKey && !e.ctrlKey && !e.altKey)
    vwRotate(e.shiftKey ? -1 : 1);
  else if ((e.key === "f" || e.key === "F") && !e.metaKey && !e.ctrlKey && !e.altKey) vwFavourite();
  else return;
  e.preventDefault();
});
