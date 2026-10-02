/* ================= survive a refresh =================
   A refresh empties the page, and Chrome also drops the folder permission, so
   the index cannot be read until the folder is reconnected. What the person
   was doing is kept here (in this browser's localStorage, never in the index):
   the chat, the Library's search chips and sort order, and the open photo.
   The view is put back once the index is readable; the chat text comes back at
   once and its photo grids fill in then. */
const RESTORE = { key:"ps.view", chatKey:"ps.chat", pending:false, saved:null, last:"", grids:[] };
function lsRead(k){ try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } }
function lsWrite(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

function restoreSnapshot(){
  return { chips:GAL.chips, texts:GAL.texts, desc:GAL.desc, removed:GAL.view === "removed",
           open: VW.open && GAL.list[VW.i] ? GAL.list[VW.i].r.id : null };
}
function restoreSave(force){
  if (window.__selftestActive || (RESTORE.pending && !force)) return;   // nothing is on screen to save yet
  const chat = CHAT.turns.slice(-40).map(t => ({ q:t.q, answer:t.answer, ids:t.ids, at:t.at }));
  const s = JSON.stringify([restoreSnapshot(), chat]);
  if (s === RESTORE.last) return;
  RESTORE.last = s;
  lsWrite(RESTORE.key, restoreSnapshot()); lsWrite(RESTORE.chatKey, chat);
}
setInterval(restoreSave, 1000);
window.addEventListener("pagehide", () => restoreSave());

/* ---- chat ---- */
function chatRestoreTurns(turns){
  CHAT.turns = turns.slice();
  CHAT.messages = turns.length ? [{ role:"system", content:"" }] : [];
  for (const t of turns){
    CHAT.messages.push({ role:"user", content:t.q }, { role:"assistant", content:t.answer || "" });
    const u = bubble("user"); u.body.textContent = t.q;
    const a = bubble("assistant");
    const text = el("div"); a.body.append(text);
    renderMarkdown(deIdify(t.answer) || "(no answer)", text);
    const extras = el("div"); a.body.append(extras);
    if (t.ids && t.ids.length) RESTORE.grids.push({ host:extras, ids:t.ids });
  }
  chatFillGrids();
}
/* Photo grids need the index, which is empty until the folder is reconnected. */
function chatFillGrids() {
  if (!IDX.records.size || !RESTORE.grids.length) return;
  for (const g of RESTORE.grids.splice(0)){
    const recs = g.ids.map(id => IDX.records.get(id)).filter(r => r && !r.hidden);
    if (recs.length) renderGrid(g.host, recs, recs.length + " photo(s) from this answer");
  }
}

/* ---- Library ---- */
function restoreView(){
  const s = RESTORE.saved;
  RESTORE.pending = false; RESTORE.saved = null;
  chatFillGrids();
  if (!s) return;
  // Run after the Library load that called us has finished.
  setTimeout(async () => {
    try {
      const searching = GAL.chips.length || GAL.texts.length;
      if (searching && curTab !== "library"){            // another tab is up; leave the search behind
        GAL.chips = []; GAL.texts = []; sgRenderChips();
      } else if (searching) await runSearch(true);
      else if (s.removed && curTab === "library") await galSetView("removed");
      if (s.open && curTab !== "chat"){
        const i = GAL.list.findIndex(x => x.r.id === s.open);
        if (i >= 0 && !VW.open && !$("#tab-library").hidden) openViewer(i);
      }
    } catch {}
    RESTORE.last = "";
    restoreSave(true);
  }, 0);
}

{
  const s = lsRead(RESTORE.key), chat = lsRead(RESTORE.chatKey);
  if (s){
    RESTORE.saved = s;
    GAL.chips = Array.isArray(s.chips) ? s.chips : [];
    GAL.texts = Array.isArray(s.texts) ? s.texts : [];
    if (typeof s.desc === "boolean") GAL.desc = s.desc;
    RESTORE.pending = true;
    try { sgRenderChips(); } catch {}
  }
  if (Array.isArray(chat) && chat.length){
    try { chatRestoreTurns(chat.filter(t => t && typeof t.q === "string")); } catch {}
  }
}
