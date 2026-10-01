
/* ================= connection test ================= */
$("#btnTest").onclick = async () => {
  const btn = $("#btnTest"); btn.disabled = true; btn.textContent = "Testing…";
  setConn("busy","Testing…");
  S.baseUrl = $("#baseUrl").value.trim() || "http://localhost:1234";
  saveSettings();
  const checks = [], isFile = location.protocol === "file:";
  checks.push({ status:"ok", title:"Page origin",
    detail: isFile ? "file:// — requests carry Origin: null, which the server must allow"
                   : location.origin });
  if ($("#mock").checked)
    checks.push({ status:"warn", title:"Mock mode is ON", detail:"No server is contacted." });
  const r = await detectModels();
  if (!r.ok){
    S.connected = false; setConn("off","Not connected");
    const netErr = /Failed to fetch|NetworkError|load failed/i.test(r.error || "");
    checks.push({ status:"err", title:"Server reachable at " + S.baseUrl, detail:r.error });
    checks.push({ status:"err", title:"What to switch on", detail: netErr
      ? corsHint() + "   — any OpenAI-compatible server works; the default URL is "
        + "LM Studio's 1234, Ollama's is 11434."
      : "Check the URL and that the server is running." });
    if (!/^https?:\/\/(localhost|127\.0\.0\.1)/.test(S.baseUrl))
      checks.push({ status:"warn", title:"Server is not local",
        detail:"Allow connections from the network as well as CORS. Chrome may prompt "
          + "for local-network access." });
    renderChecks($("#diag"), checks);
    btn.disabled = false; btn.textContent = "Test connection"; return;
  }
  S.connected = true; setConn("on","Connected");
  checks.push({ status:"ok", title:"Server reachable",
    detail:(S.provider ? S.provider + " at " : "") + S.baseUrl });
  checks.push({ status:"ok", title:"CORS allows this page",
    detail:"Model list fetched from " + (isFile ? "file://" : location.origin) });
  checks.push({ status:S.nativeApi ? "ok" : "warn", title:"Loaded-model detection",
    detail:S.nativeApi ? "Using " + S.nativeApi + " — reports type and load state."
                       : "Fell back to /v1/models — only model ids, so types are "
                         + "guessed from the name. Correct them under Model roles." });
  const vlm = S.models.filter(m => m.type === "vlm");
  checks.push({ status:vlm.length ? "ok" : "err", title:"Vision model for scanning",
    detail:vlm.length ? vlm.map(m => m.id + " (" + m.state + ")").join(", ")
                      : "No vision model found. Load one that can read images — "
                        + "Qwen3.5-VL, Gemma 3, llava, minicpm-v, moondream. If one IS "
                        + "loaded but not listed here, pick it by hand under Model roles." });
  const emb = S.models.filter(m => m.type === "embeddings");
  checks.push({ status:emb.length ? "ok" : "warn", title:"Embedding model",
    detail:emb.length ? emb.map(m => m.id).join(", ") : "None — search falls back to keywords." });
  /* Ask the server whether it can actually enforce a schema. Everything about
     scan cost depends on it, and a server that ignores the field looks fine
     until every photo comes back as prose. */
  const scanModel = S.roles.scan
    || (vlm[0] && vlm[0].id)
    || (S.models[0] && S.models[0].id);
  if (scanModel && !$("#mock").checked){
    const pr = await probeStructured(scanModel);
    S.structuredMode = pr.ok ? pr.mode : "none";
    saveSettings();
    checks.push(pr.mode === "json_schema"
      ? { status:"ok", title:"Structured output",
          detail:"Schema enforced. This is what keeps a reasoning model from "
            + "spending its whole budget thinking — 13 tokens instead of 799." }
      : pr.mode === "json_object"
      ? { status:"warn", title:"Structured output",
          detail:"This server does not enforce a schema, only \u201cJSON only\u201d. "
            + "Scanning works but costs more tokens and needs more repair. (" + pr.why + ")" }
      : { status:"warn", title:"Structured output",
          detail:"This server enforces neither a schema nor JSON-only, so answers are "
            + "parsed from prose and some photos will fail. (" + pr.why + ")" });
  }
  renderChecks($("#diag"), checks);
  renderModels();
  btn.disabled = false; btn.textContent = "Test connection";
};

/* ================= thinking probe ================= */
$("#btnThink").onclick = async () => {
  const btn = $("#btnThink"); btn.disabled = true; btn.textContent = "Probing…";
  const host = $("#thinkOut"); resetChecks(host);
  const model = $("#mScan").value || (S.models[0] && S.models[0].id);
  if (!model){
    checksBox(host).append(checkRow({ status:"err", title:"No model selected",
      detail:"Run Test connection first." }));
    btn.disabled = false; btn.textContent = "Probe thinking-off"; return;
  }
  const msg = [{ role:"user", content:"Describe a clear midday sky: colour and the sun's shape." }];
  const schema = { type:"object", additionalProperties:false, required:["color","shape"],
    properties:{ color:{type:"string"}, shape:{type:"string"} } };
  const runs = [];
  for (const mode of ["on","off"]){
    const st = step(host, mode === "on" ? "Thinking ON (default)" : "Thinking OFF (json_schema)");
    await st.paint();
    const body = { model, messages:msg, temperature:0.1, max_tokens:800 };
    if (mode === "off") body.response_format =
      { type:"json_schema", json_schema:{ name:"probe", strict:true, schema } };
    const t0 = performance.now();
    try {
      const d = await chat(body);
      const m = d.choices[0].message;
      const payload = stripThink((m.content || "").trim() || (m.reasoning_content || "").trim());
      const leaked = detectReasoning(payload, (m.content||"").trim(), (m.reasoning_content||"").trim());
      const secs = (performance.now()-t0)/1000, tok = d.usage && d.usage.completion_tokens;
      runs.push({ mode, secs, tok, leaked, out:payload });
      st[mode === "off" && !leaked ? "ok" : "warn"](
        tok + " output tokens, " + secs.toFixed(1) + "s, reasoning "
        + (leaked ? "present" : "absent"));
    } catch (e){ st.err(errText(e)); }
  }
  const on = runs.find(r => r.mode === "on"), off = runs.find(r => r.mode === "off");
  if (on && off && on.tok && off.tok)
    checksBox(host).append(checkRow({ status:"ok", title:"Verdict",
      detail:"Thinking off uses " + (on.tok/off.tok).toFixed(1) + "x fewer tokens and is "
        + (on.secs/off.secs).toFixed(1) + "x faster. Every scan call sends the JSON schema." }));
  btn.disabled = false; btn.textContent = "Probe thinking-off";
};

/* ================= folder ================= */
async function useDirectory(handle){
  S.dirHandle = handle;
  $("#btnWriteTest").disabled = false;
  $("#sFolder").textContent = handle.name;
  const host = $("#fsOut"); resetChecks(host);
  checksBox(host).append(checkRow({ status:"ok", title:"Folder selected", detail:handle.name }));
  const st = step(host, "Read/write permission");
  try {
    let p = await handle.queryPermission({ mode:"readwrite" });
    if (p !== "granted") p = await handle.requestPermission({ mode:"readwrite" });
    p === "granted" ? st.ok("granted") : st.warn(p);
  } catch (e){ st.warn(errText(e)); }
  try { await idbSet("lastDir", handle); $("#btnReconnect").disabled = false; } catch {}
  renderIndexWhere();
  /* Measure this storage once, on connect, and say what was found. Every
     deadline afterwards is sized from it rather than from a guessed constant,
     and the user gets told plainly when their share is the slow part. */
  const sp = step(host, "Storage speed");
  try {
    await ensureIndex(null, { write:false });
    await probeStorage(IDX.dir);
    const unit = storageUnitMs();
    (unit != null && unit > 3000 ? sp.warn : sp.ok)(describeStorage());
    renderIndexWhere();
  } catch (e){ sp.warn(errText(e)); }
  await fillScopes();
  IDX.loaded = false;
  await refreshPlan();
  refreshActiveTab();
}
function renderIndexWhere(){
  const n = $("#indexWhere");
  const where = S.indexMode === "custom"
    ? (S.indexDirHandle ? S.indexDirHandle.name : null)
    : (S.dirHandle ? S.dirHandle.name : null);
  const base = where
    ? "Saving the index to " + where + "/.photoindex/ — hidden in Finder, "
      + "press Cmd+Shift+. to see it."
    : (S.indexMode === "custom" ? "Choose where to save the DB."
                                : "The index will sit beside the photos.");
  n.textContent = where && storageUnitMs() != null
    ? base + "  " + describeStorage() + "."
    : base;
}
$("#sIndexMode").onchange = async () => {
  S.indexMode = $("#sIndexMode").value;
  S.indexChosen = true;
  saveSettings(); renderIndexWhere();
  if (S.indexMode === "custom" && !S.indexDirHandle){
    toast("Now choose where to save the DB.");
    return;
  }
  IDX.loaded = false;
  await refreshPlan();
  refreshActiveTab();
};
$("#sOrder").onchange = () => { S.scanOrder = $("#sOrder").value; saveSettings();
  if (S.plan) renderPlan(S.plan); };
async function fillScopes(){
  const sel = $("#sScope");
  const cur = S.scanScope;
  sel.innerHTML = "";
  sel.append(new Option("Whole library", ""));
  try {
    S.subfolders = await listSubfolders();
    for (const n of S.subfolders) sel.append(new Option(n, n + "/"));
  } catch {}
  if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
  else { S.scanScope = ""; sel.value = ""; }
}
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
    toast(errText(e));
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
      detail:errText(e) }]);
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
    st.ok(files.length + " scannable images · " + counts.raw + " RAW, " + counts.video + " video, "
      + counts.vector + " vector skipped · " + fmtDur((performance.now()-t0)/1000));
    checksBox(host).append(checkRow({ status:"ok", title:"Index is writable",
      detail:"Open the Scan tab to see the plan." }));
  } catch (e){
    checksBox(host).append(checkRow({ status:"err", title:"Write test failed",
      detail:errText(e) }));
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

/* ================= plan UI ================= */
let planAbort = null;
async function refreshPlan(){
  if (!S.dirHandle){
    /* This used to be a silent no-op, while six callers toasted success first
       and left the old numbers on screen. */
    const host = $("#planBox");
    if (host){
      resetChecks(host);
      checksBox(host).append(checkRow({ status:"warn", title:"No folder connected",
        detail:"Press Choose folder, or Reconnect, in Settings." }));
    }
    return;
  }
  const host = $("#planBox");
  if (planAbort) planAbort.abort();
  planAbort = new AbortController();
  const sig = planAbort.signal;
  resetChecks(host);
  const st = step(host, "Building plan");
  try {
    if (!S.models.length && !$("#mock").checked){
      await st.note("Detecting models…");
      await autoConnect();
    }
    await ensureIndex(null, { write:false });
    await st.note("Waking the drive…");
    await wakeStorage(m => st.note(m));
    if (!IDX.loaded){
      await loadRecords((pct, n) => st.note("Loading index… " + pct + "% (" + n + " records)"));
      await loadVectors();
      await loadCheckpoint();
      if (GEO.state === "none" && await geoCached()) { /* place names ready */ }
    }
    const p = await buildPlan(m => st.note(m), sig);
    if (p.moved.length){
      const n = await applyMoves(p.moved);
      st.note(n + " file(s) re-linked without re-scanning…");
      p.moved = [];          // they keep whatever category they were classified into
    }
    rebuildDerived();
    S.planStale = false;
    await ensureFaceNames();        // so names are searchable without opening People
    st.ok(p.total + " images · " + IDX.records.size + " records");
    /* This used to say "everything will look new -- use a separate index per
       library", which was true only before photos were matched by content.
       They are now, so adding a second folder to one index is a supported
       thing to do and anything already scanned is recognised wherever it sits.
       What is worth saying is which folder the index was last built from. */
    if (IDX.rootMismatch && !S.scanScope)
      checksBox($("#planBox")).append(checkRow({ status:"ok",
        title:"Adding a second folder to this index",
        detail:"This index was last built from '" + IDX.rootMismatch.was
          + "'; you have opened '" + IDX.rootMismatch.now + "'. Photos are matched "
          + "by content, so anything already scanned is recognised and only genuinely "
          + "new photos are queued. Nothing in the existing index is touched." }));
    renderPlan(p);
  } catch (e){
    if (e.name === "AbortError") return;
    st.err(errText(e));
    /* A failed refresh must invalidate the plan, not leave live buttons
       pointing at dead file handles. */
    S.planStale = true;
    ["btnScan","btnStale","btnFull","btnRetry","btnMissing"]
      .forEach(id => { const n = $("#" + id); if (n) n.disabled = true; });
  }
}
function renderPlan(p){
  const host = $("#planBox");
  const box = el("div");
  const stat = el("div","stat");
  const cell = (n, label) => { const d = el("div");
    d.append(el("b", null, String(n))); d.append(el("span", null, label)); return d; };
  stat.append(cell(p.total, p.scope ? "images in scope" : "images"));
  stat.append(cell(p.new.length, "new"));
  stat.append(cell(p.changed.length, "changed"));
  stat.append(cell(p.stale.length, "stale"));
  stat.append(cell(p.failed.length, "failed"));
  stat.append(cell(p.missing.length, "missing"));
  stat.append(cell(p.ok.length, "up to date"));
  box.append(stat);
  const c = p.counts;
  const bits = [];
  if (c.raw) bits.push(c.raw + " RAW counted, skipped");
  if (c.video) bits.push(c.video + " video skipped");
  if (c.vector) bits.push(c.vector + " vector/PDF skipped");
  if (p.unreadable.length) bits.push(p.unreadable.length + " unreadable");
  if (c.skippedDirs) bits.push(c.skippedDirs + " hidden folders skipped");
  bits.push(p.scope ? ("scope: " + p.scope + " — index holds " + p.indexTotal
    + " photos from the whole library") : "scope: whole library");
  if (RUN.vecError)
    box.append(Object.assign(el("div","note"), { textContent:
      "Some embeddings could not be saved (" + RUN.vecError + "). Those photos are "
      + "searchable by keyword only until you run Re-embed." }));
  if (IDX.vecRealigned)
    box.append(Object.assign(el("div","note"), { textContent:
      "The vector index was realigned on load (" + IDX.vecRealigned.rows + " rows vs "
      + IDX.vecRealigned.ids + " ids), which means an interrupted write. Run Re-embed "
      + "to be certain every photo has the right embedding." }));
  if (S.rolesUnavailable && Object.keys(S.rolesUnavailable).length)
    box.append(Object.assign(el("div","note"), { textContent:
      "LM Studio is not currently offering: "
      + Object.values(S.rolesUnavailable).join(", ")
      + ". Your choice has been kept — load the model, then press Test connection." }));
  if (DERIVED.stats && DERIVED.stats.photos && !DERIVED.stats.embedded)
    box.append(Object.assign(el("div","note"), { textContent:
      "No embeddings yet: search will be keyword-only. Pick an embedding model under "
      + "Model roles, then run Re-embed or Refresh stale." }));
  if (DERIVED.stats && DERIVED.stats.withGps && GEO.state !== "ready")
    box.append(Object.assign(el("div","note"), { textContent:
      "Photos have GPS but no place names. Press 'Get place names' in Settings." }));
  if (DERIVED.stats) bits.push(DERIVED.stats.embedded + " embedded · "
    + DERIVED.stats.events + " events · " + DERIVED.stats.entities + " entities · "
    + DERIVED.stats.withText + " with text ("
    + Math.round((DERIVED.stats.textChars || 0) / 1000) + "k chars)");
  box.append(Object.assign(el("div","hint"), { textContent: bits.join(" · ") }));
  const todo = p.new.length + p.changed.length + p.failed.length;
  const avg = avgSecs(), conc = Math.max(1, Math.min(4, S.scan.concurrency));
  /* "Everything is up to date" is true but useless when you have just pointed
     at a NEW folder and the Scan button is greyed out: it does not say whether
     nothing was found, or everything found was already known. Say which. */
  const recognised = p.ok.length + p.moved.length;
  const why = p.total === 0
    ? "No images found in this folder, so there is nothing to scan."
      + (c.raw || c.video || c.vector
         ? "  It does contain files this app skips ("
           + [c.raw && c.raw + " RAW", c.video && c.video + " video",
              c.vector && c.vector + " vector/PDF"].filter(Boolean).join(", ") + ")."
         : "  Check you picked the right folder — subfolders are included, "
           + "but hidden folders are skipped.")
    : recognised >= p.total
      ? "All " + p.total + " images here are already in the index, so there is "
        + "nothing new to scan. Photos are matched by their content, so copies and "
        + "photos that have moved are recognised rather than scanned again."
        + (p.moved.length ? "  " + p.moved.length + " were found at a new path." : "")
      : "Everything is up to date.";
  box.append(Object.assign(el("div","hint"), { textContent: todo
    ? "Scan new & changed: " + todo + " images, about " + fmtDur(todo*avg/conc)
      + " at " + avg.toFixed(0) + "s each."
      + (p.stale.length ? "  " + p.stale.length + " stale (schema/prompt/model changed)." : "")
    : why }));
  /* A greyed-out button with no reason is the actual complaint. Name the one
     action that still does something. */
  if (!todo && p.total > 0)
    box.append(Object.assign(el("div","hint"), { textContent:
      "\u201cFull rescan\u201d would re-scan all " + p.total + " from scratch, at model "
      + "cost. \u201cRefresh stale\u201d re-does only what the schema or model changed."
      }));
  if (DERIVED.stats && DERIVED.stats.dateSuspect)
    box.append(Object.assign(el("div","hint"), { textContent:
      DERIVED.stats.dateSuspect + " photos have a date but no camera tags — the date may be an "
      + "export time rather than when it was taken. Use a date override in Settings to correct a folder." }));
  host.append(box);
  if (IDX.checkpoint){
    const w = el("div","note");
    w.append(el("b", null, "Interrupted scan found. "));
    w.append(document.createTextNode(IDX.checkpoint.pending.length + " images were still queued from "
      + (IDX.checkpoint.updated_at || "").slice(0,19).replace("T"," ") + "."));
    const b = el("button","btn"); b.textContent = "Resume"; b.style.marginLeft = "10px";
    b.onclick = () => resumeScan();
    w.append(b);
    host.append(w);
  }
  $("#btnScan").disabled   = todo === 0;
  $("#btnStale").disabled  = p.stale.length === 0;
  $("#btnFull").disabled   = p.total === 0;
  $("#btnRetry").disabled  = p.failed.length === 0;
  $("#btnMissing").disabled = p.missing.length === 0;
  $("#sCount").textContent = p.total + " photos";
}
function avgSecs(){
  const done = [...IDX.records.values()].filter(r => r.secs).map(r => r.secs);
  const pool = RUN.times.length ? RUN.times : done;
  if (!pool.length) return S.scan.estSecs;
  return pool.slice(-40).reduce((a,b) => a+b, 0) / Math.min(pool.length, 40);
}

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
  catch (e){ toast(errText(e)); }
};
$("#btnCompact").onclick = async () => {
  if (!(await ensureIndexConnected()) || !(await ensureConnected("compaction"))) return;
  if (RUN.active){ toast("Stop the scan before compacting."); return; }
  try { await ensureIndex(); const r = await compactRecords();
    toast("Compacted records.jsonl: " + r.before + " lines to " + r.after + ".");
    rebuildDerived(); await refreshPlan(); }
  catch (e){ toast(errText(e)); }
};
$("#btnThumbs").onclick = async () => {
  if (!(await ensureIndexConnected()) || !(await ensureConnected("the rebuild"))) return;
  if (RUN.active){ toast("Stop the scan first."); return; }
  const host = $("#errBox"); resetChecks(host);
  $("#progCard").hidden = false;
  const st = step(host, "Rebuild thumbnails");
  let p;
  try {
    p = await planThumbnails(async m => { await st.note(m); });
  } catch (e){ st.err(errText(e)); toast(errText(e)); return; }

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
  } catch (e){ st.err(errText(e)); toast(errText(e)); }
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
  } catch (e){ st.err(errText(e)); }
};

/* ================= backups ================= */
$("#sBackup").onchange = () => { S.backup.enabled = $("#sBackup").checked; saveSettings(); };
$("#sKeep").onchange = () => {
  const v = parseInt($("#sKeep").value, 10);
  S.backup.keep = isFinite(v) ? Math.min(20, Math.max(1, v)) : 3;
  $("#sKeep").value = S.backup.keep; saveSettings();
};
$("#btnBackup").onclick = async () => {
  if (RUN.active){ toast("A scan is running — back up when it finishes."); return; }
  const host = $("#backupOut"); resetChecks(host);
  host.scrollIntoView({ block:"nearest" });
  const btn = $("#btnBackup"); btn.disabled = true; btn.textContent = "Backing up…";
  try {
    if (!(await ensureIndexConnected()) || !(await ensureConnected("the backup"))){
      checksBox(host).append(checkRow({ status:"err", title:"Could not open the index",
        detail:"Access to the folder was not granted." }));
      btn.disabled = false; btn.textContent = "Back up now";
      return;
    }
  } catch (e){
    checksBox(host).append(checkRow({ status:"err", title:"Could not open the index",
      detail:errText(e) }));
    btn.disabled = false; btn.textContent = "Back up now";
    return;
  }
  const st = step(host, "Backup");
  try {
    const b = await backupIndex("manual", m => st.note(m));
    const r = b.manifest.records;
    st.ok((b.bytes/1048576).toFixed(1) + " MB copied"
      + (r ? " · " + r.lines + " records, " + r.unique + " unique"
             + (r.bad ? ", " + r.bad + " UNREADABLE" : ", all readable") : "")
      + (b.pruned ? " · " + b.pruned + " older backup(s) removed" : ""));
    toast("Backup complete: " + (b.bytes/1048576).toFixed(1) + " MB");
    await showBackups();
  } catch (e){
    st.err(errText(e));
    toast("Backup failed: " + errText(e));
  } finally {
    btn.disabled = false; btn.textContent = "Back up now";
  }
};
$("#btnBackups").onclick = async () => {
  if (!(await ensureIndexConnected())) return;
  if (!(await ensureConnected("the backup list"))) return;
  resetChecks($("#backupOut"));
  await showBackups();
};
async function showBackups(){
  const host = $("#backupOut");
  try {
    await ensureIndex();
    const list = await listBackups();
    const box = el("div"); box.style.marginTop = "12px";
    if (!list.length){ box.append(el("span","dim","No backups yet.")); host.append(box); return; }
    const t = el("table");
    t.innerHTML = "<thead><tr><th>When</th><th>Reason</th><th>Records</th>"
      + "<th>Size</th><th></th></tr></thead>";
    const tb = el("tbody");
    for (const b of list){
      const tr = el("tr");
      tr.append(el("td","mono", (b.meta && b.meta.created_at || b.name).slice(0,19).replace("T"," ")));
      tr.append(el("td", null, (b.meta && b.meta.reason) || "—"));
      const rec = b.meta && b.meta.records;
      tr.append(el("td", rec && rec.bad ? "err" : null,
        rec ? rec.unique + (rec.bad ? "  (" + rec.bad + " bad)" : "") : "—"));
      tr.append(el("td","mono", (b.bytes/1048576).toFixed(1) + " MB"));
      const td = el("td");
      const btn = el("button","btn sec"); btn.textContent = "Restore";
      btn.style.padding = "2px 8px"; btn.style.fontSize = "12px";
      btn.onclick = async () => {
        if (RUN.active){ toast("Stop the scan before restoring."); return; }
        if (!confirm("Replace the current index with the backup from "
          + b.name.slice(0,19).replace("T"," ") + "?\n\n"
          + "The current index is copied to a new backup first.")) return;
        const st2 = step(host, "Restore");
        try {
          const r2 = await restoreBackup(b.name, m => st2.note(m));
          st2.ok("Restored " + r2.records + " records, " + r2.vectors + " vectors.");
          await refreshPlan();
        } catch (e){ st2.err(errText(e)); }
      };
      td.append(btn); tr.append(td);
      tb.append(tr);
    }
    t.append(tb); box.append(t);
    host.append(box);
  } catch (e){ renderChecks(host, [{ status:"err", title:"Could not list backups",
    detail:errText(e) }]); }
}

/* ================= geonames button ================= */
$("#btnGeo").onclick = async () => {
  if (!(await ensureIndexConnected()) || !(await ensureConnected("place names"))) return;
  const host = $("#geoOut"); resetChecks(host);
  const st = step(host, "Place names");
  try {
    await st.note("Opening the index…");
    await ensureIndex();
    await st.note("Checking for a cached copy…");
    if (await geoCached()){ st.ok(GEO.count.toLocaleString() + " places loaded from the cached copy."); return; }
    await st.note("Fetching the cities dataset once (~17 MB)…");
    await geoFetchAndCache((phase, detail) =>
      st.note(phase + (detail ? "  " + detail : "")));
    st.ok(GEO.count.toLocaleString() + " places cached in .photoindex/geo/ — this is now offline.");
  } catch (e){ st.err(errText(e) + " — photos will store coordinates only."); }
};

/* ================= settings wiring ================= */
["mScan","mEmbed","mChat"].forEach(id => $("#" + id).onchange = syncRoles);
function syncScan(){
  const beforeEvents = { ...S.events }, beforeHemi = S.date.hemisphere;
  const num = (id, def, lo, hi) => {
    const v = parseFloat($("#" + id).value);
    return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def;
  };
  S.scan.concurrency     = num("sConc", 1, 1, 4);
  S.scan.statConcurrency = num("sStat", 12, 1, 32);
  S.scan.maxTokens       = num("sMaxTok", 2000, 200, 12000);
  S.scan.temp            = num("sTemp", 0.1, 0, 1);
  S.events.gapHours      = num("sGap", 6, 0.25, 168);
  S.events.km            = num("sKm", 25, 1, 5000);
  S.search.minCosine     = num("sMinCos", 0.30, 0, 1);
  S.date.hemisphere      = $("#sHemi").value;
  S.ocr.enabled          = $("#sOcr").checked;
  saveSettings();
  /* Only these three change derived data. Rebuilding the whole inverted index
     because concurrency moved from 1 to 2 freezes the tab for seconds. */
  if (IDX.records.size && (S.events.gapHours !== beforeEvents.gapHours
      || S.events.km !== beforeEvents.km || S.date.hemisphere !== beforeHemi))
    rebuildDerived();
}
["sConc","sStat","sMaxTok","sTemp","sGap","sKm","sHemi","sMinCos","sOcr"]
  .forEach(id => $("#" + id).onchange = syncScan);

/* Date overrides: one per line, "path/prefix = YYYY-MM-DD". */
function loadOverrideBox(){
  $("#sOverrides").value = (S.date.overrides || [])
    .map(o => o.prefix + " = " + o.date.slice(0,10)).join("\n");
}
$("#sOverrides").onchange = () => {
  const list = [];
  for (const line of $("#sOverrides").value.split("\n")){
    const m = line.match(/^(.*?)\s*=\s*(\d{4}-\d{2}-\d{2})\s*$/);
    if (m) list.push({ prefix:m[1].trim(), date:new Date(m[2] + "T12:00:00").toISOString() });
  }
  S.date.overrides = list;
  saveSettings();
  toast(list.length + " date override(s) saved. Re-scan those files to apply.");
};
