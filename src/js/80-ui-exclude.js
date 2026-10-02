/* ---- folders to leave out ---- */
async function exclHandle(path){
  let h = S.dirHandle;
  for (const part of path.split("/").filter(Boolean)) h = await h.getDirectoryHandle(part);
  return h;
}
async function exclChildren(path){
  const out = [];
  const h = path ? await exclHandle(path) : S.dirHandle;
  for await (const [name, ent] of h.entries()){
    if (ent.kind !== "directory" || SKIP_DIR.has(name) || name.startsWith(".")) continue;
    out.push(name);
  }
  return out.sort((a, b) => a.localeCompare(b));
}
function exclSummary(){
  const n = S.scanExclude.length;
  $("#exclSummary").textContent = n
    ? n + " folder" + (n === 1 ? "" : "s") + " left out: " + S.scanExclude.map(x => x.replace(/\/$/, "")).join(", ")
    : "Every folder is scanned.";
}
let exclTimer = null;
function exclChanged(){
  S.scanExclude.sort();
  saveSettings(); exclSummary();
  clearTimeout(exclTimer);
  exclTimer = setTimeout(() => refreshPlan(), 600);   // several ticks in a row make one refresh
}
function exclSet(path, include){
  const p = path + "/";
  if (include){
    S.scanExclude = S.scanExclude.filter(e => e !== p && !e.startsWith(p));
  } else if (!isExcludedPath(p)){
    S.scanExclude = S.scanExclude.filter(e => !e.startsWith(p));   // the parent now covers them
    S.scanExclude.push(p);
  }
  exclChanged();
}
async function exclNode(host, path, name, parentOff){
  const full = path ? path + "/" + name : name;
  const off = isExcludedPath(full + "/");
  const wrap = el("div");
  const row = el("div", "exclRow" + (off ? " off" : ""));
  const tw = el("button", "tw", "\u25B8"); tw.title = "Look inside";
  const cb = document.createElement("input"); cb.type = "checkbox";
  cb.checked = !off; cb.disabled = parentOff; cb.id = "excl-" + full;
  cb.title = parentOff ? "Its parent folder is left out" : "";
  const lab = el("label", null, name); lab.htmlFor = cb.id;
  row.append(tw, cb, lab); wrap.append(row);
  const kids = el("div", "exclKids"); kids.hidden = true; wrap.append(kids);
  let loaded = false;
  const open = async () => {
    kids.hidden = !kids.hidden;
    tw.textContent = kids.hidden ? "\u25B8" : "\u25BE";
    if (kids.hidden || loaded) return;
    loaded = true;
    kids.textContent = "Reading\u2026";
    try {
      const names = await exclChildren(full);
      kids.textContent = "";
      if (!names.length) kids.append(el("div", "hint", "No subfolders."));
      for (const n of names) kids.append(await exclNode(kids, full, n, !cb.checked));
    } catch (e){ kids.textContent = humanError(e); }
  };
  tw.onclick = open;
  cb.onchange = () => {
    exclSet(full, cb.checked);
    row.classList.toggle("off", !cb.checked);
    for (const c of kids.querySelectorAll("input[type=checkbox]")){
      c.disabled = !cb.checked;
      c.checked = !isExcludedPath(c.id.slice(5) + "/");
      c.closest(".exclRow").classList.toggle("off", !c.checked);
    }
  };
  return wrap;
}
async function exclRender(){
  const host = $("#exclTree"); host.textContent = "";
  if (!S.dirHandle){ host.append(el("div", "hint", "Choose or reconnect a folder first.")); return; }
  try {
    for (const n of await exclChildren("")) host.append(await exclNode(host, "", n, false));
    if (!host.firstChild) host.append(el("div", "hint", "This folder has no subfolders."));
  } catch (e){ host.textContent = humanError(e); }
}
$("#btnExcl").onclick = async () => {
  const p = $("#exclPanel");
  p.hidden = !p.hidden;
  if (!p.hidden) await exclRender();
};
$("#exclAll").onclick = () => { S.scanExclude = []; exclChanged(); exclRender(); };
/* Deselect all leaves out every folder, so a few can then be ticked back in. Photos sitting
   directly in the library root belong to no folder and are still scanned. */
$("#exclNone").onclick = async () => {
  if (!S.dirHandle){ toast("Choose or reconnect a folder first."); return; }
  try { S.scanExclude = (await exclChildren("")).map(n => n + "/"); } catch (e){ toast(humanError(e)); return; }
  exclChanged(); exclRender();
};
exclSummary();

$("#sScope").onchange = async () => {
  S.scanScope = $("#sScope").value;
  saveSettings();
  toast(S.scanScope ? "Scope: " + S.scanScope + " — one index still covers everything."
                    : "Scope: whole library.");
  await refreshPlan();
};
$("#btnIndexDir").onclick = async () => {
  let h;
  try { h = await pickDirectory(); }
  catch (e){
    if (e.name === "AbortError") return;
    if (isPickerStuck(e)){ offerPickerReset(); return; }
    toast(humanError(e));
    return;
  }
  if (!h) return;
  S.indexDirHandle = h; S.indexMode = "custom";     // picking one implies using it
  $("#sIndexMode").value = "custom";
  try { await idbSet("lastIndexDir", h); } catch {}
  saveSettings(); renderIndexWhere();
  IDX.loaded = false;
  toast("Index will be written to " + h.name + "/.photoindex/");
  await refreshPlan();
};

$("#btnPick").onclick = async () => {
  let h;
  try { h = await pickDirectory(); }
  catch (e){
    if (e.name === "AbortError") return;
    if (isPickerStuck(e)){ offerPickerReset(); return; }
    renderChecks($("#fsOut"), [{ status:"err", title:"Could not open folder",
      detail:humanError(e) }]);
    return;
  }
  if (h) await useDirectory(h);
};
$("#btnReconnect").onclick = async () => {
  const h = await idbGet("lastDir");
  if (!h){ toast("No remembered folder — pick one."); return; }
  let p = await h.queryPermission({ mode:"readwrite" });
  if (p !== "granted") p = await h.requestPermission({ mode:"readwrite" });
  if (p !== "granted"){ toast("Permission denied — re-pick the folder."); return; }
  await useDirectory(h);
};
$("#btnWriteTest").onclick = async () => {
  const btn = $("#btnWriteTest"); btn.disabled = true; btn.textContent = "Working…";
  const host = $("#fsOut"); resetChecks(host);
  const t0 = performance.now();
  if (!S.dirHandle){
    checksBox(host).append(checkRow({ status:"err", title:"No folder selected", detail:"Pick one first." }));
    btn.disabled = false; btn.textContent = "Test write to .photoindex/"; return;
  }
  try {
    let st = step(host, "Create / open .photoindex/"); await st.paint();
    await ensureIndex(); st.ok("inside " + S.dirHandle.name);
    st = step(host, "Write and read back config.json"); await st.paint();
    const back = JSON.parse(await (await (await IDX.dir.getFileHandle("config.json")).getFile()).text());
    back.app === "PhotoSearch" ? st.ok("schema_hash " + back.schema_hash) : st.err("mismatch");
    st = step(host, "Append to records.jsonl"); await st.paint();
    const probe = { id:"__probe__", path:"__probe__", probe:true, at:new Date().toISOString() };
    await appendLines("records.jsonl", [probe]);
    st.ok("append + seek to end works");
    st = step(host, "Read the folder"); await st.paint();
    const { files, counts } = await walk(S.dirHandle, n => st.note(n + " images so far…"));
    st.ok(files.length + " scannable images · " + counts.rawPaired + " RAW beside a JPEG, " + counts.video + " video, "
      + counts.vector + " vector skipped · " + fmtDur((performance.now()-t0)/1000));
    checksBox(host).append(checkRow({ status:"ok", title:"Index is writable",
      detail:"Open the Scan tab to see the plan." }));
  } catch (e){
    checksBox(host).append(checkRow({ status:"err", title:"Write test failed",
      detail:humanError(e) }));
  }
  btn.disabled = false; btn.textContent = "Test write to .photoindex/";
};

enableFolderDrop("btnPick", h => useDirectory(h));
enableFolderDrop("btnIndexDir", async h => {
  S.indexDirHandle = h; S.indexMode = "custom";
  $("#sIndexMode").value = "custom";
  try { await idbSet("lastIndexDir", h); } catch {}
  saveSettings(); renderIndexWhere();
  IDX.loaded = false;
  toast("Index will be written to " + h.name + "/.photoindex/");
  await refreshPlan();
});

