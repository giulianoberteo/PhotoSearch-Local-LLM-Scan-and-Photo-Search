
/* ================= chat UI =================
   Model output is NEVER inserted as HTML. A tiny markdown subset is turned into
   DOM nodes, so anything a caption or a model says stays inert text. */
function mdInline(text, parent){
  const rx = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let last = 0, m;
  while ((m = rx.exec(text))){
    if (m.index > last) parent.append(document.createTextNode(text.slice(last, m.index)));
    const tok = m[0];
    if (tok.startsWith("**")) parent.append(el("strong", null, tok.slice(2,-2)));
    else if (tok.startsWith("`")) parent.append(el("code", null, tok.slice(1,-1)));
    else parent.append(el("em", null, tok.slice(1,-1)));
    last = m.index + tok.length;
  }
  if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
}
function renderMarkdown(text, host){
  host.innerHTML = "";
  const lines = String(text || "").split("\n");
  let list = null;
  for (const raw of lines){
    const line = raw.replace(/\s+$/,"");
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered){
      const want = bullet ? "ul" : "ol";
      if (!list || list.tagName.toLowerCase() !== want){ list = el(want); host.append(list); }
      const li = el("li"); mdInline((bullet || numbered)[1], li); list.append(li);
      continue;
    }
    list = null;
    if (!line.trim()){ continue; }
    const h = line.match(/^#{1,4}\s+(.*)$/);
    const p = el(h ? "h4" : "p");
    p.style.margin = h ? "10px 0 4px" : "0 0 8px";
    mdInline(h ? h[1] : line, p);
    host.append(p);
  }
  if (!host.childNodes.length) host.append(el("p", null, ""));
}

function bubble(role){
  const b = el("div", "msg " + role);
  const who = el("div","who", role === "user" ? "You" : "PhotoSearch");
  b.append(who);
  const body = el("div","body");
  b.append(body);
  $("#chatLog").append(b);
  $("#chatLog").scrollTop = $("#chatLog").scrollHeight;
  return { box:b, body };
}

function renderGrid(host, recs, title){
  for (const r of recs) thumbPin(r.id);      // keep these alive while displayed
  if (!recs.length) return;
  const wrap = el("div");
  wrap.append(Object.assign(el("div","hint"),
    { textContent: title || (recs.length + " matching photo" + (recs.length===1?"":"s")) }));
  const g = el("div","grid");
  for (const r of recs){
    const fig = el("figure");
    const im = el("img"); im.alt = r.caption || r.name || ""; im.loading = "lazy";
    applyRotation(im, r);
    thumbUrl(r.id).then(u => { if (u) im.src = u; });
    fig.append(im);
    const cap = el("figcaption", null,
      [(r.date_taken || "").slice(0,10), r.place].filter(Boolean).join(" · ") || r.name);
    fig.append(cap);
    fig.title = r.caption || r.name || "";
    fig.onclick = () => openLightbox(r);
    g.append(fig);
  }
  wrap.append(g);
  host.append(wrap);
}

function renderTrace(host, trace){
  if (!trace.length) return;
  let d = host.querySelector("details.trace");
  if (!d){
    d = el("details","trace"); d.style.marginTop = "10px";
    d.append(el("summary", null, "What I searched"));
    host.append(d);
  }
  while (d.childNodes.length > 1) d.removeChild(d.lastChild);
  for (const t of trace){
    const box = el("div"); box.style.margin = "8px 0";
    box.append(el("div","hint", t.name + "(" + JSON.stringify(t.args) + ")"));
    const how = (t.result && t.result.how) || [];
    if (how.length) box.append(el("div","hint", "→ " + how.join(" · ")));
    if (t.result && t.result.error){
      box.append(el("div","err", "→ failed: " + t.result.error));
    } else {
      const n = t.result && (t.result.count != null ? t.result.count
        : (t.result.entities || t.result.events || t.result.answers || []).length);
      box.append(el("div","hint", "→ " + (n != null ? n + " result(s)" : "done")));
    }
    d.append(box);
  }
}

/* ---- lightbox: the original file, read from the folder ---- */
async function fileByPath(path){
  if (!S.dirHandle) return null;
  const parts = path.split("/");
  let dir = S.dirHandle;
  for (let i = 0; i < parts.length - 1; i++) dir = await dir.getDirectoryHandle(parts[i]);
  return (await dir.getFileHandle(parts[parts.length - 1])).getFile();
}
/* The key/value block describing one photo; shared by the lightbox and the Library viewer. */
function metaList(r){
  const dl = el("dl","kv");
  const add = (k, v) => { if (v == null || v === "") return;
    dl.append(el("dt", null, k)); dl.append(el("dd", null, String(v))); };
  add("caption", r.caption);
  add("description", r.description);
  add("when", (r.when_phrase || "") + (r.date_suspect
    ? "  — date is suspect (no camera tags; probably an export time)" : ""));
  add("date source", r.date_source
    ? r.date_source + ", confidence " + (r.date_confidence || "unknown") : null);
  add("where", r.place ? r.place + " (" + r.place_km + " km)" : (r.gps ? "GPS only" : null));
  add("camera", r.camera);
  add("type", r.image_type + (r.image_type_source && r.image_type_source !== "model"
    ? " (corrected via " + r.image_type_source + ")" : ""));
  add("scene", [r.scene_type, r.setting].filter(Boolean).join(" / "));
  add("objects", (r.objects || []).join(", "));
  add("activities", (r.activities || []).join(", "));
  add("people", r.people && r.people.count_bucket
    ? r.people.count_bucket + (r.people.description ? " — " + r.people.description : "") : null);
  add("text in image", r.visible_text && r.visible_text.has_text ? r.visible_text.text : null);
  add("colours", (r.dominant_colors || []).join(", "));
  add("rotation", r.rotation ? r.rotation + "° clockwise (view only; the file is unchanged)" : null);
  add("file", r.path + (r.width && r.height ? "  ·  " + r.width + "x" + r.height : ""));
  return dl;
}
let lbUrl = null;
async function openLightbox(r){
  const lb = $("#lightbox");
  lb.hidden = false;
  const img = $("#lbImg");
  img.removeAttribute("src");
  $("#lbTitle").textContent = r.name || r.path;
  const meta = $("#lbMeta"); meta.innerHTML = "";
  meta.append(metaList(r));

  const more = $("#lbMore");
  more.onclick = () => {
    lb.hidden = true;
    const sim = findSimilar(r.id, 12);
    const { body } = bubble("assistant");
    const t = el("div"); renderMarkdown("More like **" + (r.caption || r.name) + "**", t);
    body.append(t);
    renderGrid(body, sim.map(x => x.rec), sim.length + " similar photo(s)");
    $("#chatLog").scrollTop = $("#chatLog").scrollHeight;
  };

  if (lbUrl){ URL.revokeObjectURL(lbUrl); lbUrl = null; }
  try {
    const f = await fileByPath(r.path);
    if (f && /\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(r.path)){
      lbUrl = URL.createObjectURL(f); img.src = lbUrl;
    } else if (f && isScannable(r.path)){
      const u = await thumbUrl(r.id);
      if (u) img.src = u;
      const big = await processImage(f, classifyFile(r.path), { bigPx:6000 });
      lbUrl = URL.createObjectURL(big.big); img.src = lbUrl;
    } else {
      // HEIC/TIFF cannot be shown directly by the browser: use the stored thumbnail.
      const u = await thumbUrl(r.id);
      if (u) img.src = u;
      meta.prepend(Object.assign(el("div","hint"), { textContent: f
        ? "Showing the stored thumbnail — the browser cannot display this format directly."
        : "The original is not reachable (the folder is not connected), so this is the "
          + "stored thumbnail." + (u ? "" : " No thumbnail is stored either.") }));
    }
  } catch (e){
    const u = await thumbUrl(r.id);
    if (u) img.src = u;
    meta.prepend(Object.assign(el("div","hint"),
      { textContent:"Original not reachable (" + (e.message || e) + ") — showing the thumbnail." }));
  }
}
$("#lbClose").onclick = () => { $("#lightbox").hidden = true; };
$("#lightbox").addEventListener("click", e => { if (e.target.id === "lightbox") $("#lightbox").hidden = true; });
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && !$("#lightbox").hidden) $("#lightbox").hidden = true;
});

/* The model is told not to print ids, but if it does they are the most precise
   signal of which photos it actually meant. Parse them, use them for the grid,
   and display the file name in their place. */
const ID_RX = /\b[0-9a-f]{16}(?:-\d+)?\b/g;
function mentionedIds(text){
  const out = [];
  for (const m of String(text || "").matchAll(ID_RX))
    if (IDX.records.has(m[0]) && !out.includes(m[0])) out.push(m[0]);
  return out;
}
function deIdify(text){
  return String(text || "").replace(ID_RX, id => {
    const r = IDX.records.get(id);
    return r ? (r.name || id) : id;
  });
}
/* Choose what to show: what the answer named, else this turn's results, else
   the previous turn's set so a follow-up keeps its pictures. */
function gridFor(answer, turnPhotos, searchedThisTurn){
  const named = mentionedIds(answer).map(id => IDX.records.get(id)).filter(Boolean);
  if (named.length) return { recs: named, why: "the " + named.length + " photo(s) in this answer" };
  if (turnPhotos.length) return { recs: turnPhotos.slice(0, 24), why: null };
  /* Never show the previous question's photos under an answer that searched
     and found nothing -- users read the pictures, not the caption above them. */
  if (searchedThisTurn) return { recs: [], why: null };
  if (CHAT.lastPhotos && CHAT.lastPhotos.length)
    return { recs: CHAT.lastPhotos.slice(0, 24), why: "still showing the previous results" };
  return { recs: [], why: null };
}

/* ---- send ---- */
function setModeBadge(mode){
  const b = $("#modeBadge");
  b.hidden = false;
  b.textContent = mode === "tools" ? "tool calling"
    : mode === "none" ? "retrieve-then-answer" : "detecting…";
  b.className = "pill" + (mode === "tools" ? " loaded" : "");
}
async function sendChat(){
  const inp = $("#chatInput");
  const q = inp.value.trim();
  if (!q || CHAT.busy) return;
  /* Chat is the front door and was the only major action that did not
     reconnect. After a reload the index is simply not open -- telling the user
     to "scan first" was both a dead end and untrue. */
  if (!IDX.records.size){
    const u0 = bubble("assistant");
    renderMarkdown("Opening your index…", u0.body);
    try {
      if (await ensureIndexConnected() && await ensureConnected("your question")){
        await ensureIndex(null, { write:false });
        await loadRecords(); await loadVectors(); rebuildDerived();
      }
    } catch (e){ renderMarkdown("**Could not open the index:** " + humanError(e), u0.body); return; }
    u0.box.remove();
    if (!IDX.records.size){
      const u1 = bubble("assistant");
      renderMarkdown("That index has no photos in it yet. Scan a folder first, "
        + "or check you opened the right one in Settings.", u1.body);
      return;
    }
  }
  inp.value = "";
  CHAT.busy = true;
  CHAT.abort = new AbortController();
  $("#chatSend").disabled = true; $("#chatStop").hidden = false;

  const u = bubble("user"); u.body.textContent = q;
  const a = bubble("assistant");
  const textHost = el("div"); a.body.append(textHost);
  const extras = el("div"); a.body.append(extras);
  let acc = "";
  const ui = {
    onDelta: d => { acc += d; renderMarkdown(deIdify(acc), textHost);
      $("#chatLog").scrollTop = $("#chatLog").scrollHeight; },
    onTrace: t => renderTrace(extras, t),
    onMode: m => setModeBadge(m)
  };
  try {
    const { answer, trace, photos } = await askAgent(q, ui);
    renderMarkdown(deIdify(answer) || "(no answer)", textHost);
    renderTrace(extras, trace);
    const searched = trace.some(t => /search_photos|filter_photos|find_similar/.test(t.name));
    const { recs: shown, why } = gridFor(answer, photos, searched);
    if (shown.length){ renderGrid(extras, shown, why); CHAT.lastPhotos = shown; }
    else if (trace.length) extras.append(el("div","hint","No photos matched."));
    CHAT.turns.push({ q, answer, ids:shown.map(p => p.id), at:new Date().toISOString() });
  } catch (e){
    if (e.name === "AbortError") renderMarkdown(acc + "\n\n_(stopped)_", textHost);
    /* Keep whatever streamed: discarding a partial answer on a late failure
       loses the only useful part. errText because DOMException.message is empty. */
    else renderMarkdown((acc ? deIdify(acc) + "\n\n" : "") + "**Error:** " + humanError(e), textHost);
  } finally {
    CHAT.busy = false;
    $("#chatSend").disabled = false; $("#chatStop").hidden = true;
    $("#chatLog").scrollTop = $("#chatLog").scrollHeight;
  }
}
$("#chatSend").onclick = sendChat;
$("#chatStop").onclick = () => { if (CHAT.abort) CHAT.abort.abort(); };
$("#chatInput").addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey){ e.preventDefault(); sendChat(); }
});
$("#chatClear").onclick = () => {
  CHAT.messages = []; CHAT.turns = []; CHAT.lastPhotos = [];
  $("#chatLog").innerHTML = "";
  toast("Conversation cleared.");
};
$("#chatSave").onclick = async () => {
  if (!CHAT.turns.length){ toast("Nothing to save yet."); return; }
  try {
    await ensureIndex();
    const dir = await IDX.dir.getDirectoryHandle("chats", { create:true });
    const name = new Date().toISOString().replace(/[:.]/g,"-") + ".json";
    await writeFile(await dir.getFileHandle(name, { create:true }),
      JSON.stringify({ saved_at:new Date().toISOString(), turns:CHAT.turns }, null, 1));
    toast("Saved to .photoindex/chats/" + name);
  } catch (e){ toast("Could not save: " + humanError(e)); }
};
