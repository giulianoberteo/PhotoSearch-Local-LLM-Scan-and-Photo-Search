
/* ================= derived data (no model calls) =================
   Rebuilt from the stored records alone, so changing thresholds is instant. */
const DERIVED = { entities:new Map(), postings:new Map(), docLen:new Map(),
  avgdl:0, events:[], stats:null };

/* Inverted index over the normalised text fields, for BM25 in Phase 4. */
const STOP = new Set(["the","a","an","and","or","of","in","on","at","to","with","is","are",
  "was","were","for","by","from","as","it","its","this","that","there","their","his","her"]);
function tokenise(s){
  return (s || "").toLowerCase().replace(/[^a-z0-9' ]+/g," ").split(/\s+/)
    .filter(w => w.length > 1 && !STOP.has(w)).map(singular);
}
function recordTerms(r){
  const t = [];
  t.push(...tokenise(r.caption), ...tokenise(r.description), ...tokenise(r.setting));
  for (const o of r.objects || []) t.push(...tokenise(o));
  for (const a of r.activities || []) t.push(...tokenise(a));
  for (const k of r.search_keywords || []) t.push(...tokenise(k));
  if (r.visible_text && r.visible_text.has_text) t.push(...tokenise(r.visible_text.text));
  for (const ln of r.text_lines || []) t.push(...tokenise(ln));
  if (r.place) t.push(...tokenise(r.place));
  if (r.when && r.when.occasions) for (const o of r.when.occasions) t.push(...tokenise(o));
  return t;
}
function addEntity(type, value, id){
  if (!value) return;
  const key = type + ":" + value;
  let e = DERIVED.entities.get(key);
  if (!e){ e = { type, value, count:0, ids:[] }; DERIVED.entities.set(key, e); }
  e.count++;
  if (e.ids.length < 5000) e.ids.push(id);
}

/* Events: consecutive photos in time, split on a gap or a jump in distance. */
function buildEvents(records, gapHours, km){
  const dated = records.filter(r => r.date_taken && !r.deleted && r.status !== "error")
    .sort((a,b) => a.date_taken < b.date_taken ? -1 : 1);
  const events = [];
  let cur = null;
  for (const r of dated){
    const t = new Date(r.date_taken).getTime();
    let split = !cur;
    if (cur){
      const gap = (t - cur.lastT) / 3600000;
      if (gap > gapHours) split = true;
      else if (cur.lastGps && r.gps){
        if (haversineKm(cur.lastGps.lat, cur.lastGps.lon, r.gps.lat, r.gps.lon) > km) split = true;
      }
    }
    if (split){
      cur = { id:"ev-" + events.length, from:r.date_taken, to:r.date_taken,
        ids:[], places:new Map(), occasions:new Map(), lastT:t, lastGps:r.gps || null };
      events.push(cur);
    }
    cur.ids.push(r.id);
    cur.to = r.date_taken; cur.lastT = t;
    if (r.gps) cur.lastGps = r.gps;
    if (r.place) cur.places.set(r.place, (cur.places.get(r.place) || 0) + 1);
    for (const o of (r.when && r.when.occasions) || [])
      cur.occasions.set(o, (cur.occasions.get(o) || 0) + 1);
  }
  const top = m => { let b = null, n = 0;
    for (const [k, v] of m) if (v > n){ n = v; b = k; } return b; };
  return events.map(e => {
    const place = top(e.places), occ = top(e.occasions);
    const d = new Date(e.from);
    const label = [occ, place, MONTHS[d.getMonth()] + " " + d.getFullYear()]
      .filter(Boolean).join(" · ");
    return { id:e.id, from:e.from, to:e.to, count:e.ids.length, ids:e.ids,
      place: place || null, occasion: occ || null, label };
  });
}

function rebuildDerived(){
  DERIVED.entities = new Map();
  DERIVED.postings = new Map();
  DERIVED.docLen = new Map();
  const recs = [...IDX.records.values()].filter(r => !r.deleted && r.status !== "error");
  for (const r of recs){
    for (const o of r.objects || []) addEntity("object", o, r.id);
    for (const a of r.activities || []) addEntity("activity", a, r.id);
    for (const k of r.search_keywords || []) addEntity("keyword", k, r.id);
    for (const c of r.dominant_colors || []) addEntity("color", c, r.id);
    for (const a of r.animals || []) addEntity("animal", a.type, r.id);
    if (r.place) addEntity("place", r.place, r.id);
    if (r.camera) addEntity("camera", r.camera, r.id);
    if (r.setting) addEntity("setting", r.setting, r.id);
    if (r.image_type) addEntity("image_type", r.image_type, r.id);
    if (r.text_chars > 0) addEntity("has_text", "yes", r.id);
    for (const o of (r.when && r.when.occasions) || []) addEntity("occasion", o, r.id);
    if (r.when && r.when.year) addEntity("year", String(r.when.year), r.id);
    const terms = recordTerms(r);
    DERIVED.docLen.set(r.id, terms.length);
    const seen = new Map();
    for (const t of terms) seen.set(t, (seen.get(t) || 0) + 1);
    for (const [t, tf] of seen){
      let p = DERIVED.postings.get(t);
      if (!p){ p = []; DERIVED.postings.set(t, p); }
      p.push([r.id, tf]);
    }
  }
  let total = 0;
  for (const n of DERIVED.docLen.values()) total += n;
  DERIVED.avgdl = DERIVED.docLen.size ? total / DERIVED.docLen.size : 1;
  DERIVED.events = buildEvents(recs, S.events.gapHours, S.events.km);
  DERIVED.stats = {
    photos: recs.length,
    errors: [...IDX.records.values()].filter(r => r.status === "error").length,
    deleted: [...IDX.records.values()].filter(r => r.deleted).length,
    entities: DERIVED.entities.size,
    terms: DERIVED.postings.size,
    events: DERIVED.events.length,
    embedded: IDX.vec.ids.length,
    withText: recs.filter(r => (r.text_chars || 0) > 0).length,
    textChars: recs.reduce((a,r) => a + (r.text_chars || 0), 0),
    withGps: recs.filter(r => r.gps).length,
    dateSuspect: recs.filter(r => r.date_suspect).length,
    range: recs.length ? [recs.reduce((a,r) => r.date_taken < a ? r.date_taken : a, "9999"),
                          recs.reduce((a,r) => r.date_taken > a ? r.date_taken : a, "0")] : null
  };
  return DERIVED.stats;
}
