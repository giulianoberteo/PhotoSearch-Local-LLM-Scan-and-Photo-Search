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
