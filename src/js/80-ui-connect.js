
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
    } catch (e){ st.err(humanError(e)); }
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
  } catch (e){ st.warn(humanError(e)); }
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
  } catch (e){ sp.warn(humanError(e)); }
  await fillScopes();
  IDX.loaded = false;
  await refreshPlan();
  refreshActiveTab();
}
/* Says, in one place, where the index is RIGHT NOW. The browser only hands over folder
   names, never full paths, so this is the name of the folder that holds .photoindex. */
async function renderIndexNow(){
  const box = $("#idxNow");
  if (!box) return;
  box.textContent = "";
  let parent = null;
  try { parent = await indexParent(); } catch {}
  if (!parent){
    box.append(el("b", null, "No index location yet. "),
      document.createTextNode(S.indexMode === "custom"
        ? "Choose where to save the DB, or reconnect the index folder."
        : "Choose a photo folder; the index will sit inside it."));
    return;
  }
  const custom = S.indexMode === "custom";
  box.append(el("b", null, "Index right now: "), document.createTextNode(parent.name + "/.photoindex"));
  box.append(el("div", "hint", (custom ? "A folder you chose for the index" : "Beside the photos, inside the connected photo folder '"
    + (S.dirHandle ? S.dirHandle.name : "?") + "'")
    + (IDX.records.size ? " \u00b7 " + IDX.records.size + " photos recorded" : "")
    + ". Chrome shares folder names, not full paths: to find it in Finder, search for the name above, then press Cmd+Shift+. to show hidden folders."));
}
function renderIndexWhere(){
  renderIndexNow();
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
