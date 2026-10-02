/* ================= progress UI ================= */
function scanUi(running){
  $("#progCard").hidden = false;
  $("#btnPause").hidden = !running;
  $("#btnStop").hidden = !running;
  ["btnScan","btnStale","btnFull","btnRetry","btnMissing","btnPlan","btnCompact","btnThumbs"]
    .forEach(id => { const n = $("#" + id); if (n) n.disabled = running; });
  if (running) $("#btnPause").textContent = "Pause";
}
function updateProgress(){
  const pct = RUN.total ? Math.round(RUN.done / RUN.total * 100) : 0;
  $("#barFill").style.width = pct + "%";
  const avg = RUN.times.length
    ? RUN.times.slice(-12).reduce((a,b) => a+b, 0) / Math.min(RUN.times.length, 12) : 0;
  const avgTok = RUN.tokens.length
    ? RUN.tokens.reduce((a,b) => a+b, 0) / RUN.tokens.length : 0;
  $("#progStats").textContent = RUN.done + " / " + RUN.total + "  (" + pct + "%)   "
    + (avg ? avg.toFixed(1) + " s/image   " : "")
    + (avgTok ? Math.round(avgTok) + " tok/image   " : "")
    + ((RUN.errorCount || RUN.errors.length) ? (RUN.errorCount || RUN.errors.length) + " errors" : "");
  const left = RUN.total - RUN.done;
  const conc = RUN.mode === "faces"
    ? Math.max(1, Math.min(8, S.faces.readConcurrency))
    : Math.max(1, Math.min(4, S.scan.concurrency));
  $("#progEta").textContent = (RUN.active && avg && left)
    ? "About " + fmtDur(left * avg / conc) + " remaining."
    : (RUN.active ? "Estimating…" : "");
  /* A face run is started from the People tab, but every element above lives
     in the Scan tab -- which is hidden at the time. Without this the run gave
     no sign of life at all on the tab it was launched from, and looked like it
     had done nothing. */
  if (RUN.mode === "faces"){
    const fb = $("#facesBar");
    if (fb) fb.style.width = pct + "%";
    const fs = $("#facesStats");
    if (fs) fs.textContent = RUN.done.toLocaleString() + " / "
      + RUN.total.toLocaleString() + "  (" + pct + "%)"
      + (avg ? "   " + avg.toFixed(2) + " s/photo" : "")
      + (RUN.errorCount ? "   " + RUN.errorCount + " unreadable" : "");
    const fe = $("#facesEta");
    if (fe) fe.textContent = (RUN.active && avg && left)
      ? "About " + fmtDur(left * avg / conc) + " remaining."
      : (RUN.active ? "Estimating…" : "Finished.");
  }
}
let curUrl = null, curSeq = 0;
function showCurrent(blob, name){
  const fn = $("#facesNow");
  if (fn && RUN.mode === "faces") fn.textContent = name || "";
  const my = ++curSeq;                       // concurrency-safe: last start wins
  const u = URL.createObjectURL(blob);
  if (my !== curSeq){ URL.revokeObjectURL(u); return; }
  if (curUrl) URL.revokeObjectURL(curUrl);
  curUrl = u;
  $("#curThumb").src = u;
  $("#curName").textContent = name;
}
function renderErrors(){
  const host = $("#errBox"); host.innerHTML = "";
  if (!RUN.errors.length) return;
  const n = RUN.errorCount || RUN.errors.length;
  const first = el("div","note");
  first.append(el("b", null, n + " error" + (n === 1 ? "" : "s")
    + (RUN.errors.length < n ? " (showing the first " + RUN.errors.length + ")" : "")
    + ". First: "));
  first.append(document.createTextNode(RUN.errors[0].error.slice(0, 300)));
  host.append(first);
  const d = el("details"); d.style.marginTop = "12px";
  d.append(el("summary", null, RUN.errors.length + " errors"));
  const p = el("pre");
  p.textContent = RUN.errors.map(e => e.path + "\n    " + e.error).join("\n");
  d.append(p); host.append(d);
}
const recent = [];
function addRecent(rec){
  recent.unshift(rec);
  if (recent.length > 12) recent.pop();
  const host = $("#recentBox"); host.innerHTML = "";
  const g = el("div","grid");
  for (const r of recent){
    const fig = el("figure");
    const im = el("img"); im.alt = r.caption || r.name; im.loading = "lazy";
    thumbUrl(r.id).then(u => { if (u) im.src = u; });
    fig.append(im);
    fig.append(el("figcaption", null, r.caption || r.name));
    fig.onclick = () => showRecord(r);
    g.append(fig);
  }
  host.append(g);
}
function showRecord(r){
  const host = $("#recentBox");
  const box = el("div"); box.style.marginTop = "12px";
  const dl = el("dl","kv");
  const add = (k, v) => { dl.append(el("dt", null, k)); dl.append(el("dd", null, v)); };
  add("file", r.path);
  add("caption", r.caption || "–");
  add("description", r.description || "–");
  add("type", r.image_type + (r.image_type_source !== "model"
    ? "  (corrected from '" + r.image_type_model + "' via " + r.image_type_source + ")" : ""));
  add("scene", (r.scene_type || "") + " / " + (r.setting || ""));
  add("objects", (r.objects || []).join(", ") || "–");
  add("activities", (r.activities || []).join(", ") || "–");
  add("people", r.people ? (r.people.count_bucket + " — " + (r.people.description || "")) : "–");
  add("text", r.visible_text && r.visible_text.has_text ? r.visible_text.text : "none");
  add("when", (r.when_phrase || "–") + "   [" + r.date_source + ", confidence "
    + r.date_confidence + (r.date_suspect ? ", SUSPECT" : "") + "]");
  add("where", r.place ? r.place + " (" + r.place_km + " km)" : (r.gps ? "GPS only" : "–"));
  add("camera", r.camera || "–");
  add("cost", (r.secs ? r.secs.toFixed(1) + "s" : "–") + ", " + (r.out_tokens || "–") + " tok"
    + (r.reasoned ? "  REASONING LEAKED" : "") + ", " + r.attempts + " attempt(s)");
  add("status", r.status + (r.issues && r.issues.length ? " — " + r.issues.join("; ") : ""));
  box.append(dl);
  const det = el("details"); det.style.marginTop = "10px";
  det.append(el("summary", null, "Raw model JSON"));
  const pre = el("pre");
  pre.textContent = JSON.stringify(r.raw_model_json, null, 1);
  det.append(pre); box.append(det);
  host.append(box);
}

/* ================= scan buttons ================= */
$("#btnPlan").onclick = async () => {
  if (!(await ensureIndexConnected())) return;
  if (!(await ensureConnected("the plan"))) return;
  await refreshPlan();
};
/* The buttons are only ever ENABLED by renderPlan, but refreshPlan's catch
   never disabled them again -- so after a failed refresh they stayed live
   pointing at a stale plan full of dead file handles. */
function planOrRefuse(){
  if (!S.plan){ toast("Press Refresh plan first."); return null; }
  if (S.planStale){
    toast("The plan is out of date — refreshing it first.");
    refreshPlan();
    return null;
  }
  return S.plan;
}
$("#btnScan").onclick = () => { const p = planOrRefuse(); if (!p) return;
  runScan([...p.new, ...p.changed, ...p.failed], "new-and-changed"); };
$("#btnStale").onclick = () => { const p = planOrRefuse(); if (!p) return;
  runScan(p.stale, "refresh-stale"); };
$("#btnFull").onclick = () => { const p = planOrRefuse(); if (!p) return;
  runScan([...p.new, ...p.changed, ...p.failed, ...p.stale, ...p.ok], "full-rescan"); };
$("#btnRetry").onclick = () => { const p = planOrRefuse(); if (!p) return;
  runScan(p.failed, "retry-failed"); };
$("#btnMissing").onclick = async () => {
  try { const n = await markMissing(S.plan); toast(n + " records marked missing."); await refreshPlan(); }
  catch (e){ toast(humanError(e)); }
};
$("#btnCompact").onclick = async () => {
  if (!(await ensureIndexConnected()) || !(await ensureConnected("compaction"))) return;
  if (RUN.active){ toast("Stop the scan before compacting."); return; }
  try { await ensureIndex(); const r = await compactRecords();
    toast("Compacted records.jsonl: " + r.before + " lines to " + r.after + ".");
    rebuildDerived(); await refreshPlan(); }
  catch (e){ toast(humanError(e)); }
};
$("#btnThumbs").onclick = async () => {
  if (!(await ensureIndexConnected()) || !(await ensureConnected("the rebuild"))) return;
  if (RUN.active){ toast("Stop the scan first."); return; }
  const host = $("#errBox"); resetChecks(host);
  $("#progCard").hidden = false;
  const st = step(host, "Rebuild thumbnails");
  let p;
  try {
    loadModule("maintenance");
    p = await planThumbnails(async m => { await st.note(m); });
  } catch (e){ st.err(humanError(e)); toast(humanError(e)); return; }

  if (!p.missing){
    st.ok(p.have + " thumbnails for " + p.total + " photos — none are missing."
      + (p.orphans ? "  " + p.orphans + " belong to photos no longer in the index." : ""));
    return;
  }
  if (!p.files.length){
    st.warn(p.missing + " thumbnails are missing, but none of those photos are in the "
      + "folder you have open. Open the folder they live in and try again.");
    return;
  }
  const extra = p.unresolved.length
    ? "\n\n" + p.unresolved.length + " more are missing but their photos are not in this "
      + "folder; open that folder afterwards to finish them."
    : "";
  if (!confirm("Rebuild " + p.files.length + " missing thumbnail"
      + (p.files.length === 1 ? "" : "s") + "?\n\nThis re-reads the original photos and "
      + "costs no model time. Nothing already in the index is changed." + extra)) return;

  st.note("Rebuilding " + p.files.length + "…");
  try {
    const r = await runThumbnailRebuild(p.files);
    if (!r) return;
    const parts = [r.built + " rebuilt"];
    if (r.failed) parts.push(r.failed + " could not be read");
    if (r.stopped) parts.push("stopped early");
    if (p.unresolved.length) parts.push(p.unresolved.length + " await another folder");
    (r.failed || r.stopped ? st.warn : st.ok)(parts.join(", ") + ".");
    toast(r.built + " thumbnails rebuilt.");
  } catch (e){ st.err(humanError(e)); toast(humanError(e)); }
};

$("#btnPause").onclick = () => {
  RUN.paused = !RUN.paused;
  $("#btnPause").textContent = RUN.paused ? "Resume" : "Pause";
  if (RUN.paused) releaseWakeLock(); else acquireWakeLock();
};
$("#btnStop").onclick = () => {
  RUN.stop = true; RUN.paused = false;
  if (RUN.abort) RUN.abort.abort();      // cancels the in-flight request at once
  toast("Stopping… progress is saved and resumable.");
};

/* ---- move the index ---- */
$("#btnIndexMove").onclick = async () => {
  if (RUN.active){ toast("Wait for the scan to finish before moving the index."); return; }
  if (!(await ensureIndexConnected()) || !(await ensureConnected("the move"))) return;
  let dest;
  try { await ensureIndex(null, { write:false }); dest = await pickDirectory(); }
  catch (e){
    if (e.name === "AbortError") return;
    if (isPickerStuck(e)){ offerPickerReset(); return; }
    toast(humanError(e)); return;
  }
  const host = $("#fsOut"); resetChecks(host);
  let cur = null;
  try { cur = await indexParent(); } catch {}
  try { if (cur && await cur.isSameEntry(dest)){ toast("The index is already in " + dest.name + "."); return; } } catch {}
  const rec = IDX.records.size;
  if (!confirm("Move the index to '" + dest.name + "/.photoindex'?\n\n"
      + "From: " + (cur ? cur.name : "?") + "/.photoindex  (" + rec + " photos recorded)\n"
      + "To:   " + dest.name + "/.photoindex\n\n"
      + "The index is copied, checked, and only then switched over. The old copy is left where it is, "
      + "so nothing is lost; delete it yourself once you are happy. Your photos are not touched.\n\n"
      + "If '" + dest.name + "' is not the folder you meant (the macOS picker returns a highlighted "
      + "subfolder), press Cancel and choose again.")) return;
  const btn = $("#btnIndexMove"); btn.disabled = true;
  const st = step(host, "Moving the index to " + dest.name);
  try {
    const r = await withLibraryMaintenance(() => moveIndexTo(dest, m => st.note(m), { thumbs:true }));
    st.ok(r.records + " photos recorded, " + (r.bytes / 1048576).toFixed(1) + " MB of index files copied. "
      + "The old copy in " + (cur ? cur.name : "the old folder") + " is untouched.");
    renderIndexWhere();
    toast("Index moved to " + dest.name + "/.photoindex");
    await refreshPlan();
  } catch (e){
    st.err(humanError(e) + " Nothing was switched: the index is still where it was.");
  }
  btn.disabled = false;
};
$("#btnIndexReveal").onclick = async () => {
  if (!(await ensureIndexConnected()) || !(await ensureConnected("the index listing"))) return;
  const host = $("#fsOut"); resetChecks(host);
  const st = step(host, "Index contents");
  try {
    await ensureIndex();
    let total = 0, thumbs = 0, rows = [];
    async function walkIdx(dir, prefix){
      for await (const [name, h] of dir.entries()){
        if (h.kind === "directory"){ await walkIdx(h, prefix + name + "/"); continue; }
        const b = (await h.getFile()).size;
        total += b;
        if (prefix.startsWith("thumbs/")) thumbs += b;
        else rows.push({ path: prefix + name, bytes: b });
      }
    }
    await walkIdx(IDX.dir, "");
    rows.sort((a,b) => b.bytes - a.bytes);
    const mb = n => (n / 1048576).toFixed(n > 1048576 ? 1 : 2) + " MB";
    st.ok(mb(total) + " total · " + IDX.records.size + " records");
    const pre = el("pre");
    pre.textContent = rows.map(r => r.bytes.toString().padStart(12) + "  " + r.path).join("\n")
      + (thumbs ? "\n" + String(thumbs).padStart(12) + "  thumbs/ (" + IDX.records.size + " files)" : "")
      + "\n\nSaved in:   " + (S.indexMode === "custom"
          ? (S.indexDirHandle ? S.indexDirHandle.name : "(none chosen)")
          : (S.dirHandle ? S.dirHandle.name : "?"))
      + "/.photoindex/"
      + "\nMode:       " + (S.indexMode === "custom"
          ? "a folder you chose" : "beside the photos")
      + "\n\nNote: the leading dot makes .photoindex HIDDEN in Finder."
      + "\nPress Cmd+Shift+.  in Finder to show hidden folders.";
    host.append(pre);
  } catch (e){ st.err(humanError(e)); }
};

