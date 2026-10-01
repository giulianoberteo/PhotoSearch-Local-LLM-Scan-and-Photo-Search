
/* ================= hybrid search =================
   BM25 over the inverted index, cosine over the embeddings, merged with
   reciprocal rank fusion. Filters are applied first so both halves rank the
   same candidate set. All of it runs locally over the in-memory index. */
const BM25 = { k1:1.4, b:0.75 };

/* Text stored from an image, as one searchable blob. */
function textOf(r){
  const a = (r.visible_text && r.visible_text.text) || "";
  const b = (r.text_lines || []).join("\n");
  return b.length > a.length ? b : a;
}
/* "quoted runs" must match exactly, which word-level BM25 cannot do. */
function phrasesIn(q){
  const out = [];
  for (const m of String(q || "").matchAll(/"([^"]{2,})"/g)) out.push(m[1].toLowerCase());
  return out;
}
const stripPhrases = q => String(q || "").replace(/"[^"]*"/g, " ").trim();

function candidateSet(f){
  const out = [];
  const from = f.date_from ? String(f.date_from) : null;
  const to   = f.date_to   ? String(f.date_to)   : null;
  const place = f.place ? String(f.place).toLowerCase() : null;
  const types = f.image_type ? [].concat(f.image_type).map(s => String(s).toLowerCase()) : null;
  const ents  = f.entities ? [].concat(f.entities).map(s => singular(String(s).toLowerCase())) : null;
  const occ   = f.occasion ? [].concat(f.occasion).map(s => String(s).toLowerCase()) : null;
  const who   = f.person ? [].concat(f.person).map(s => String(s).toLowerCase()) : null;
  const month = f.month ? String(f.month).padStart(2, "0") : null;
  const sets  = f.photo_sets && f.photo_sets.length ? f.photo_sets : null;   // every set must contain the photo
  for (const r of IDX.records.values()){
    if (r.deleted || r.hidden || r.status === "error" || r.probe) continue;
    if (from && (!r.date_taken || r.date_taken.slice(0,10) < from)) continue;
    if (to   && (!r.date_taken || r.date_taken.slice(0,10) > to)) continue;
    if (month && !(r.date_taken && r.date_taken.slice(5, 7) === month)) continue;
    if (sets && !sets.every(s => s.has(r.id))) continue;
    if (place && !(r.place || "").toLowerCase().includes(place)) continue;
    if (types && !types.includes(String(r.image_type || "").toLowerCase())) continue;
    if (occ && !((r.when && r.when.occasions) || []).some(o => occ.includes(o))) continue;
    /* EVERY named person must appear, so "Anna and Ben" means both of them. */
    if (who){
      const names = faceNamesFor(r.id).map(n => n.toLowerCase());
      if (!who.every(w => names.some(n => n.includes(w)))) continue;
    }
    if (f.text){
      const needle = String(f.text).toLowerCase();
      if (!textOf(r).toLowerCase().includes(needle)) continue;
    }
    if (f.has_text === true && !(r.text_chars > 0)) continue;
    if (ents){
      const bag = new Set([...(r.objects||[]), ...(r.activities||[]),
        ...(r.search_keywords||[]), ...(r.animals||[]).map(a => a.type),
        r.setting, r.image_type].filter(Boolean).map(x => singular(String(x).toLowerCase())));
      if (!ents.every(e => bag.has(e))) continue;
    }
    out.push(r);
  }
  return out;
}

function bm25Scores(queryTerms, allowed){
  const N = DERIVED.docLen.size || 1;
  const avgdl = DERIVED.avgdl || 1;
  const scores = new Map();
  for (const t of new Set(queryTerms)){
    const posting = DERIVED.postings.get(t);
    if (!posting) continue;
    const df = posting.length;
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    for (const [id, tf] of posting){
      if (allowed && !allowed.has(id)) continue;
      const dl = DERIVED.docLen.get(id) || avgdl;
      const denom = tf + BM25.k1 * (1 - BM25.b + BM25.b * dl / avgdl);
      scores.set(id, (scores.get(id) || 0) + idf * (tf * (BM25.k1 + 1)) / denom);
    }
  }
  return scores;
}

/* Document norms never change, so computing them on every query doubled the
   inner loop for nothing: at 100k x 768 that is ~150M redundant operations per
   search, on the UI thread. */
function vectorNorms(){
  const n = IDX.vec.ids.length, dim = IDX.vec.dim;
  if (IDX.vec.norms && IDX.vec.norms.length === n) return IDX.vec.norms;
  const norms = new Float32Array(n);
  for (let r = 0; r < n; r++){
    const off = r * dim;
    let dn = 0;
    for (let i = 0; i < dim; i++){ const v = IDX.vec.rows[off + i]; dn += v * v; }
    norms[r] = Math.sqrt(dn) || 1;
  }
  IDX.vec.norms = norms;
  return norms;
}
function cosineScores(vec, allowed){
  const out = new Map();
  if (!vec || !IDX.vec.rows || !IDX.vec.dim) return out;
  const dim = IDX.vec.dim;
  let qn = 0;
  for (let i = 0; i < dim; i++) qn += vec[i] * vec[i];
  qn = Math.sqrt(qn) || 1;
  const norms = vectorNorms();
  for (let r = 0; r < IDX.vec.ids.length; r++){
    const id = IDX.vec.ids[r];
    if (allowed && !allowed.has(id)) continue;
    const off = r * dim;
    let dot = 0;
    for (let i = 0; i < dim; i++) dot += IDX.vec.rows[off + i] * vec[i];
    out.set(id, dot / (norms[r] * qn));
  }
  return out;
}

const rankOf = m => {
  const arr = [...m.entries()].sort((a,b) => b[1] - a[1]);
  const r = new Map();
  arr.forEach(([id], i) => r.set(id, i + 1));
  return r;
};
/* Reciprocal rank fusion: robust when the two score scales are unrelated. */
function rrf(maps, k = 60){
  const fused = new Map();
  for (const m of maps){
    const ranks = rankOf(m);
    for (const [id, rank] of ranks)
      fused.set(id, (fused.get(id) || 0) + 1 / (k + rank));
  }
  return fused;
}

async function searchPhotos(args){
  const limit = Math.min(args.max || 60, Math.max(1, args.limit || 12));   // `max` lifts the chat cap for the Library's search results
  const cands = candidateSet(args);
  const allowed = new Set(cands.map(r => r.id));
  const q = (args.query || "").trim();
  let fused;
  const used = [];
  if (!q){
    // No text: newest first within the filters.
    const sorted = cands.sort((a,b) => (b.date_taken || "").localeCompare(a.date_taken || ""));
    used.push("filters only, newest first");
    return { used, results: sorted.slice(0, limit).map(r => ({ rec:r, score:null })) };
  }
  /* Exact phrases first: they are a filter, not a ranking signal. */
  const phrases = phrasesIn(q);
  let pool = allowed;
  if (phrases.length){
    pool = new Set();
    for (const id of allowed){
      const hay = textOf(IDX.records.get(id)).toLowerCase()
        + " " + (IDX.records.get(id).caption || "").toLowerCase();
      if (phrases.every(ph => hay.includes(ph))) pool.add(id);
    }
    used.push(phrases.length + " exact phrase(s) matched " + pool.size + " photo(s)");
    if (!pool.size) return { used, results: [] };
  }
  const bare = phrases.length ? stripPhrases(q) : q;
  if (!bare){
    const recs = [...pool].map(id => IDX.records.get(id)).filter(Boolean)
      .sort((a,b) => (b.date_taken || "").localeCompare(a.date_taken || ""));
    return { used, results: recs.slice(0, limit).map(r => ({ rec:r, score:null })) };
  }
  const terms = tokenise(bare);
  let kw = bm25Scores(terms, pool);
  /* The cosine half got a floor with a comment about exactly this hazard; the
     keyword half had none. BM25 is OR-semantics, so one incidental word match
     put a photo in a confidently ranked list. Require a real share of the
     query's terms, and drop the long tail of one-weak-term matches. */
  if (kw.size && terms.length){
    const need = terms.length >= 4 ? 2 : 1;
    const df = new Map();
    for (const t of new Set(terms)){
      const post = DERIVED.postings.get(t);
      if (post) for (const [id] of post) df.set(id, (df.get(id) || 0) + 1);
    }
    const best = Math.max(...kw.values());
    const cut = best * S.search.minKeywordShare;
    const kept = new Map();
    for (const [id, sc] of kw)
      if ((df.get(id) || 0) >= need && sc >= cut) kept.set(id, sc);
    used.push("BM25: " + kw.size + " matched, " + kept.size + " met "
      + need + "+ query term(s) and " + Math.round(S.search.minKeywordShare * 100)
      + "% of the top score");
    kw = kept;
  } else used.push("BM25 over " + pool.size + " candidates");
  let vecMap = new Map();
  if (S.roles.embed && IDX.vec.ids.length){
    try {
      /* Vectors made by a different model are meaningless against this query,
         and a different dimension silently produces NaN scores that read as
         "nothing was similar enough". Say which it is. */
      if (IDX.vec.model && S.roles.embed && IDX.vec.model !== S.roles.embed){
        used.push("embeddings were built with " + IDX.vec.model + " but "
          + S.roles.embed + " is selected — skipping semantic search until you re-embed");
        throw new Error("embedding model mismatch");
      }
      const qv = Float32Array.from(await embed(S.roles.embed, bare, args.signal, 45000));
      if (IDX.vec.dim && qv.length !== IDX.vec.dim)
        throw new Error("this model returns " + qv.length + "-dim vectors but the index "
          + "holds " + IDX.vec.dim + "-dim — re-embed before searching");
      const raw = cosineScores(qv, pool);
      /* Cosine similarity is never zero, so without a floor a nonsense query
         still returns a confidently ranked list of irrelevant photos. Anything
         below the floor is treated as "no semantic match". */
      const floor = S.search.minCosine;
      for (const [id, sc] of raw) if (sc >= floor) vecMap.set(id, sc);
      used.push("cosine over " + raw.size + " embeddings, " + vecMap.size
        + " above the " + floor + " relevance floor");
    } catch (e){ used.push("embeddings unavailable (" + (e.message || e) + "), keywords only"); }
  } else used.push("no embedding model — keyword matching only");

  if (!kw.size && !vecMap.size)
    return { used: used.concat("nothing passed either matcher"), results: [] };

  const maps = [kw];
  if (vecMap.size) maps.push(vecMap);
  fused = maps.length > 1 ? rrf(maps) : kw;
  if (maps.length > 1) used.push("merged with reciprocal rank fusion");

  const ranked = [...fused.entries()].sort((a,b) => b[1] - a[1]).slice(0, limit);
  return { used, results: ranked.map(([id, score]) => ({ rec: IDX.records.get(id), score }))
    .filter(x => x.rec) };
}

function findSimilar(id, limit){
  const v = vectorOf(id);
  const allowed = new Set([...IDX.records.values()]
    .filter(r => !r.deleted && !r.hidden && r.status !== "error" && !r.probe && r.id !== id).map(r => r.id));
  if (v){
    const m = cosineScores(v, allowed);
    return [...m.entries()].sort((a,b) => b[1]-a[1]).slice(0, limit)
      .map(([i, s]) => ({ rec: IDX.records.get(i), score: s })).filter(x => x.rec);
  }
  const src = IDX.records.get(id);
  if (!src) return [];
  const m = bm25Scores(recordTerms(src), allowed);
  return [...m.entries()].sort((a,b) => b[1]-a[1]).slice(0, limit)
    .map(([i, s]) => ({ rec: IDX.records.get(i), score: s })).filter(x => x.rec);
}

/* Tool results stay compact: the agent never needs the whole record. */
function compact(r, score){
  return {
    id: r.id,
    date: (r.date_taken || "").slice(0,10),
    when: r.when_phrase || null,
    place: r.place || null,
    type: r.image_type,
    caption: (r.caption || "").slice(0,150),
    text: r.text_chars ? textOf(r).slice(0,180) : null,
    score: score == null ? null : +score.toFixed(4)
  };
}
