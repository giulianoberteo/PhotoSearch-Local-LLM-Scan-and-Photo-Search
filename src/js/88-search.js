/* ================= header search =================
   A search field in the toolbar, as in the Photos app. Typing offers grouped
   suggestions (people, places, dates, kinds of picture, things in the picture)
   worked out locally and instantly; choosing one adds a removable chip, and
   pressing Enter on the first row searches the words themselves by keyword and
   meaning. Results are shown in the Library grid, so the viewer, Select,
   rotate and remove all work on them.

   Nothing here calls a model except the ordinary text search, which embeds the
   query when an embedding model is selected, exactly as chat does. */

const SG = { open:false, items:[], sel:0, facts:null, key:"", run:0 };

const sgLive = r => !!r && !r.deleted && !r.hidden && r.status !== "error" && !r.probe;

/* Everything a suggestion needs, rebuilt only when the index or the people
   changed. A photo set per person is what a person chip filters by, so it is
   exact even when two people share a name. */
function sgFacts(){
  const key = [IDX.records.size, FACES.people.length, FACES.clusters.length, FACES.faces.size,
               DERIVED.entities.size].join(":");
  if (SG.facts && SG.key === key) return SG.facts;
  const years = new Map(), occasions = new Map();
  for (const r of IDX.records.values()){
    if (!sgLive(r)) continue;
    const y = r.date_taken && r.date_taken.slice(0, 4);
    if (y && /^\d{4}$/.test(y)) years.set(y, (years.get(y) || 0) + 1);
    for (const o of (r.when && r.when.occasions) || []) occasions.set(o, (occasions.get(o) || 0) + 1);
  }
  const people = [];
  [...FACES.people, ...FACES.clusters].forEach((g, i) => {
    const ids = new Set();
    for (const fid of g.face_ids){
      const f = FACES.faces.get(fid);
      if (f && sgLive(IDX.records.get(f.photo_id))) ids.add(f.photo_id);
    }
    people.push({ id:g.id, named:!!g.name, label:groupLabel(g, i), ids, group:g });
  });
  const withFaces = new Set();
  for (const pid of FACES.byPhoto.keys()) if (sgLive(IDX.records.get(pid))) withFaces.add(pid);
  const places = new Map(), types = new Map(), things = new Map();
  for (const e of DERIVED.entities.values()){
    if (e.type === "place") places.set(e.value, e.count);
    else if (e.type === "image_type") types.set(e.value, e.count);
    else if (["object", "activity", "keyword", "animal", "setting"].includes(e.type)){
      const k = e.value.toLowerCase(), cur = things.get(k);
      if (cur) cur.count += e.count; else things.set(k, { value:e.value, count:e.count });
    }
  }
  SG.key = key;
  return SG.facts = { years, occasions, people, withFaces, places, types, things };
}

const sgTop = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

/* "mum + dad", "mum & dad", "mum, dad", "mum and dad": several people at once.
   Every part but the last must name exactly one person (exact name first, then
   a unique prefix); the last may still be partial. Returns the people for the
   finished parts and the candidates for the last, or null if this is not that. */
const SG_JOIN = /\s*(?:\+|&|,|\band\b)\s*/i;
function sgPeopleParts(raw){
  if (!/[+&,]|\band\b/i.test(raw)) return null;
  const parts = raw.split(SG_JOIN).map(s => s.trim().toLowerCase()).filter(Boolean);
  if (parts.length < 2) return null;
  const people = sgFacts().people.filter(p => p.ids.size);
  const used = new Set(), done = [];
  for (const w of parts.slice(0, -1)){
    let m = people.filter(p => !used.has(p.id) && p.label.toLowerCase() === w);
    if (m.length !== 1) m = people.filter(p => !used.has(p.id) && p.label.toLowerCase().startsWith(w));
    if (m.length !== 1) return null;
    used.add(m[0].id); done.push(m[0]);
  }
  const last = parts[parts.length - 1];
  const cand = people.filter(p => !used.has(p.id) && p.label.toLowerCase().includes(last))
    .sort((a, b) => (b.label.toLowerCase() === last) - (a.label.toLowerCase() === last)
                    || b.label.toLowerCase().startsWith(last) - a.label.toLowerCase().startsWith(last)
                    || b.ids.size - a.ids.size);
  return { done, last, cand };
}
function sgPeopleItem(list){
  const ids = list.map(p => p.ids);
  const both = [...ids[0]].filter(id => ids.every(s => s.has(id))).length;
  return { kind:"people", icon:"\uD83D\uDC65", label:list.map(p => p.label).join(" + "),
           sub:both.toLocaleString(), chips:list.map(p => ({ kind:"person", id:p.id, label:p.label })) };
}

/* Suggestions for what has been typed so far: [{ title, items:[...] }]. An
   item carries the chips it would add, so choosing it needs no further work. */
function sgSuggest(raw){
  const F = sgFacts(), q = raw.trim().toLowerCase(), out = [];
  const pass = str => !q || String(str).toLowerCase().includes(q);
  const starts = str => String(str).toLowerCase().startsWith(q);

  const multi = sgPeopleParts(raw);
  const combos = multi ? multi.cand.slice(0, 6).map(c => sgPeopleItem([...multi.done, c])) : [];
  /* A phrase that is entirely people is a people search first, a text search second. */
  const exact = multi && multi.cand.length && multi.cand[0].label.toLowerCase() === multi.last;
  if (combos.length && exact) out.push({ title:"People together", items:[combos[0]] });
  if (q) out.push({ title:"", items:[{ kind:"text", icon:"🔎", label:"Search for “" + raw.trim() + "”",
                                         sub:"words and meaning" }] });

  if (combos.length) out.push({ title:exact ? "" : "People together", items:exact ? combos.slice(1) : combos });
  const ppl = (multi ? [] : F.people).filter(p => p.ids.size && pass(p.label))
    .sort((a, b) => (b.named - a.named) || (b.ids.size - a.ids.size)).slice(0, q ? 6 : 8);
  const faceItems = ppl.map(p => ({ kind:"person", face:bestFaceOf(p.group), label:p.label,
    sub:p.ids.size.toLocaleString(), chips:[{ kind:"person", id:p.id, label:p.label }] }));
  if (F.withFaces.size && (!q || (q.length >= 2 && ("faces".startsWith(q) || "people".startsWith(q)))))
    faceItems.push({ kind:"faces", icon:"☺", label:"Photos with faces",
      sub:F.withFaces.size.toLocaleString(), chips:[{ kind:"faces", label:"Faces" }] });
  if (faceItems.length) out.push({ title:"People", items:faceItems });

  /* Dates: "june", "2021" and "june 2021" all work, in any order. */
  const dates = [];
  const words = q.split(/\s+/).filter(Boolean);
  const mi = words.map(w => w.length >= 3 ? TL_MONTHS.findIndex(m => m.toLowerCase().startsWith(w)) : -1)
                  .find(i => i >= 0);
  const yr = words.find(w => /^(19|20)\d{2}$/.test(w));
  if (mi != null && yr)
    dates.push({ kind:"date", icon:"📅", label:TL_MONTHS[mi] + " " + yr,
      chips:[{ kind:"month", value:mi + 1, label:TL_MONTHS[mi] }, { kind:"year", value:yr, label:yr }] });
  else if (mi != null)
    dates.push({ kind:"date", icon:"📅", label:TL_MONTHS[mi], sub:"any year",
      chips:[{ kind:"month", value:mi + 1, label:TL_MONTHS[mi] }] });
  else if (/^\d{1,4}$/.test(q) || !q){
    for (const [y, n] of sgTop(new Map([...F.years].filter(([y]) => !q || y.startsWith(q))), q ? 5 : 6)
                           .sort((a, b) => b[0].localeCompare(a[0])))
      dates.push({ kind:"date", icon:"📅", label:y, sub:n.toLocaleString(),
        chips:[{ kind:"year", value:y, label:y }] });
  }
  for (const [o, n] of sgTop(F.occasions, 50).filter(([o]) => q && pass(o)).slice(0, 3))
    dates.push({ kind:"occasion", icon:"🎉", label:o[0].toUpperCase() + o.slice(1), sub:n.toLocaleString(),
      chips:[{ kind:"occasion", value:o, label:o[0].toUpperCase() + o.slice(1) }] });
  if (dates.length) out.push({ title:"Dates", items:dates });

  const places = sgTop(F.places, 400).filter(([p]) => pass(p)).slice(0, q ? 5 : 5)
    .map(([p, n]) => ({ kind:"place", icon:"📍", label:p, sub:n.toLocaleString(),
                        chips:[{ kind:"place", value:p, label:p }] }));
  if (places.length) out.push({ title:"Places", items:places });

  if (q){
    const types = sgTop(F.types, 30).filter(([t]) => pass(t)).slice(0, 4)
      .map(([t, n]) => ({ kind:"type", icon:"🏷", label:t[0].toUpperCase() + t.slice(1), sub:n.toLocaleString(),
                          chips:[{ kind:"type", value:t, label:t[0].toUpperCase() + t.slice(1) }] }));
    if (types.length) out.push({ title:"Kinds of picture", items:types });

    const things = [...F.things.values()].filter(t => pass(t.value))
      .sort((a, b) => (starts(b.value) - starts(a.value)) || (b.count - a.count)).slice(0, 6)
      .map(t => ({ kind:"thing", icon:"✦", label:t.value, sub:t.count.toLocaleString(),
                   chips:[{ kind:"thing", value:t.value, label:t.value }] }));
    if (things.length) out.push({ title:"In the picture", items:things });
  }
  return out;
}

/* ---- the dropdown ---- */
function sgRender(){
  const box = $("#sgBox"), input = $("#gSearch");
  const secs = sgSuggest(input.value);
  SG.items = secs.flatMap(s => s.items);
  SG.sel = Math.min(Math.max(SG.sel, 0), Math.max(0, SG.items.length - 1));
  box.textContent = "";
  if (!SG.items.length){
    box.append(el("div", "sgEmpty", IDX.records.size
      ? "Nothing to suggest. Press Enter to search the words."
      : "Connect a folder in Settings to search your photos."));
  }
  let n = 0;
  for (const s of secs){
    if (s.title) box.append(el("div", "sgHead", s.title));
    for (const it of s.items){
      const row = el("div", "sgItem" + (n === SG.sel ? " on" : ""));
      row.setAttribute("role", "option");
      row.dataset.n = String(n++);
      if (it.face) row.append(faceTile(it.face));
      else row.append(el("span", "ic", it.icon || "•"));
      row.append(el("span", "lbl", it.label));
      if (it.sub) row.append(el("span", "sub", it.sub));
      row.onmousedown = e => { e.preventDefault(); sgPick(it); };
      row.onmousemove = () => { if (SG.sel !== +row.dataset.n) sgMove(+row.dataset.n, false); };
      box.append(row);
    }
  }
}
function sgMove(to, scroll){
  const rows = $("#sgBox").querySelectorAll(".sgItem");
  if (!rows.length) return;
  SG.sel = (to + rows.length) % rows.length;
  rows.forEach((r, i) => r.classList.toggle("on", i === SG.sel));
  if (scroll) rows[SG.sel].scrollIntoView({ block:"nearest" });
}
function sgOpen(){
  SG.open = true;
  $("#sgBox").hidden = false;
  $("#gSearch").setAttribute("aria-expanded", "true");
  sgRender();
}
function sgClose(){
  SG.open = false;
  $("#sgBox").hidden = true;
  $("#gSearch").setAttribute("aria-expanded", "false");
}

/* ---- chips ---- */
const SG_SINGLE = ["place", "year", "month"];          // a second one replaces the first
function sgAddChip(c){
  if (SG_SINGLE.includes(c.kind)) GAL.chips = GAL.chips.filter(x => x.kind !== c.kind);
  if (!GAL.chips.some(x => x.kind === c.kind && x.id === c.id && x.value === c.value))
    GAL.chips.push(c);
}
/* Tokens live inside the field, as in the Photos app: pick Mum, it becomes a
   token, keep typing Dad. Picking leaves the field focused and the list open
   for the next one, and the results update behind it. */
function sgPick(it){
  const input = $("#gSearch");
  if (it.kind === "text"){
    const w = input.value.trim();
    if (w && !GAL.texts.includes(w)) GAL.texts.push(w);
  } else for (const c of it.chips) sgAddChip(c);
  input.value = "";
  sgRenderChips();
  if (document.activeElement === input){ SG.sel = 0; sgRender(); } else sgClose();
  runSearch();
}

/* Everything in the search, as tokens in the field: chips first, then words. */
function sgRenderChips(){
  const host = $("#sgChips");
  if (!host) return;
  host.textContent = "";
  const tok = (label, drop, title) => {
    const t = el("span", "sgChip");
    t.append(document.createTextNode(label));
    const x = el("button", "x", "\u2715");
    x.title = title; x.setAttribute("aria-label", title);
    x.onmousedown = e => { e.preventDefault(); drop(); };
    t.append(x);
    host.append(t);
  };
  GAL.chips.forEach((c, i) => tok(c.label, () => galDropChip(i), "Remove " + c.label));
  GAL.texts.forEach((w, i) => tok("\u201c" + w + "\u201d", () => galDropText(i), "Remove \u201c" + w + "\u201d"));
  const has = GAL.chips.length + GAL.texts.length > 0;
  $("#sgField").classList.toggle("has", has);
  $(".sgWrap").classList.toggle("has", has);
  const f = $("#sgField"); f.scrollLeft = f.scrollWidth;
}
/* Backspace on an empty field removes the last token. */
function sgPop(){
  if (GAL.texts.length) GAL.texts.pop();
  else if (GAL.chips.length) GAL.chips.pop();
  else return false;
  sgRenderChips();
  return true;
}

/* The filters a set of chips stands for, in the form searchPhotos takes. */
function sgArgs(){
  const F = sgFacts(), a = { limit:100000, max:100000, photo_sets:[] };
  const types = [], things = [], occ = [];
  for (const c of GAL.chips){
    if (c.kind === "person") a.photo_sets.push((F.people.find(p => p.id === c.id) || { ids:new Set() }).ids);
    else if (c.kind === "faces") a.photo_sets.push(F.withFaces);
    else if (c.kind === "place") a.place = c.value;
    else if (c.kind === "year"){ a.date_from = c.value + "-01-01"; a.date_to = c.value + "-12-31"; }
    else if (c.kind === "month") a.month = c.value;
    else if (c.kind === "type") types.push(c.value);
    else if (c.kind === "thing") things.push(c.value);
    else if (c.kind === "occasion") occ.push(c.value);
  }
  if (types.length) a.image_type = types;
  if (things.length) a.entities = things;
  if (occ.length) a.occasion = occ;
  if (GAL.texts.length) a.query = GAL.texts.join(" ");
  return a;
}

async function runSearch(){
  const tok = ++SG.run;
  if (!GAL.chips.length && !GAL.texts.length){ clearSearch(); return; }
  if (tabFromHash() !== "library") location.hash = "library";
  showTab("library");
  await onLibraryShown();
  if (!IDX.records.size){ toast("Connect a folder in Settings first."); return; }
  try {
    await ensureFaceNames();
    if (!IDX.vec.ids.length) await loadVectors().catch(() => {});
    if (!DERIVED.postings.size) rebuildDerived();
    const res = await searchPhotos(sgArgs());
    if (tok !== SG.run) return;                       // a newer search superseded this one
    GAL.view = "search";
    GAL.results = res.results.map(x => x.rec.id);
    GAL.sel.clear(); GAL.last = -1;
    galBuild(); galBar(); galClear(); galLayout();
    galMessage(GAL.list.length ? "" : "No photos match this search.");
    window.scrollTo(0, 0);
  } catch (e){
    toast("Search failed: " + humanError(e));
  }
}
function clearSearch(){
  SG.run++;
  GAL.chips = []; GAL.texts = []; GAL.results = [];
  if (GAL.view === "search") GAL.view = "all";
  galBuild(); galBar(); galClear(); galLayout();
  galMessage(GAL.list.length ? "" : "Nothing indexed yet — run a scan first.");
}
function galDropChip(i){ GAL.chips.splice(i, 1); sgRenderChips(); runSearch(); }
function galDropText(i){ GAL.texts.splice(i, 1); sgRenderChips(); runSearch(); }
$("#galClearSearch").onclick = clearSearch;

/* ---- the field ---- */
{
  const input = $("#gSearch");
  input.addEventListener("focus", () => {
    sgOpen();
    ensureFaceNames().then(() => { if (SG.open) sgRender(); });
  });
  input.addEventListener("input", () => { SG.sel = 0; if (!SG.open) sgOpen(); else sgRender(); });
  input.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== input) sgClose(); }, 120));
  input.addEventListener("keydown", e => {
    if (e.key === "ArrowDown"){ e.preventDefault(); if (!SG.open) sgOpen(); else sgMove(SG.sel + 1, true); }
    else if (e.key === "ArrowUp"){ e.preventDefault(); sgMove(SG.sel - 1, true); }
    else if (e.key === "Backspace" && !input.value){ if (sgPop()){ e.preventDefault(); runSearch(); } }
    else if ((e.key === "," || e.key === "+") && input.value.trim()){
      /* a separator finishes the word: the exact match if there is one, else the words */
      e.preventDefault();
      const w = input.value.trim().toLowerCase();
      const it = SG.items.find(i => i.kind !== "text" && i.kind !== "people" && String(i.label).toLowerCase() === w)
              || SG.items.find(i => i.kind === "text");
      if (it) sgPick(it);
    }
    else if (e.key === "Enter"){
      e.preventDefault();
      const it = SG.items[SG.sel];
      if (it) sgPick(it);
      else if (!input.value && (GAL.chips.length || GAL.texts.length)) sgClose();
    } else if (e.key === "Escape"){
      if (SG.open) sgClose();
      else if (input.value) input.value = "";
      else input.blur();
    }
  });
  document.addEventListener("mousedown", e => {
    if (SG.open && !e.target.closest(".sgWrap")) sgClose();
  });
  /* "/" and Ctrl/Cmd+K jump to the field, unless you are already typing. */
  document.addEventListener("keydown", e => {
    const typing = e.target.closest && e.target.closest("input,textarea,select,[contenteditable]");
    const slash = e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey;
    const k = (e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey);
    if ((slash || k) && !VW.open){ e.preventDefault(); input.focus(); input.select(); }
  });
}

sgRenderChips();
