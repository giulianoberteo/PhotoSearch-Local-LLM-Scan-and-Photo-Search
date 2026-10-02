/* ---- storage ----
   Same discipline as records.jsonl and vectors.bin: append-only, last line
   wins, and the bin is reconciled to its id list in both directions on load. */
async function loadFaces(){
  const dir = await facesDir();
  FACES.faces = new Map();
  FACES.byPhoto = new Map();
  const text = await readTextIfAny(dir, "faces.jsonl");
  if (text){
    for (const ln of text.split("\n")){
      if (!ln.trim()) continue;
      try {
        const f = JSON.parse(ln);
        if (f && f.id) FACES.faces.set(f.id, f);
      } catch {}
    }
  }
  for (const f of [...FACES.faces.values()]){
    if (f.removed) { FACES.faces.delete(f.id); continue; }
    if (!FACES.byPhoto.has(f.photo_id)) FACES.byPhoto.set(f.photo_id, []);
    FACES.byPhoto.get(f.photo_id).push(f.id);
  }
  await loadFaceVectors();
  await loadPeople();
  FACES.loaded = true;
  faceNamesLoaded = true;
  return FACES.faces.size;
}

async function loadFaceVectors(){
  const dir = await facesDir();
  FACES.vec = { dim:0, ids:[], rows:null, index:new Map() };
  const metaText = await readTextIfAny(dir, "facevecs.json");
  if (!metaText) return 0;
  let meta;
  try { meta = JSON.parse(metaText); } catch { return 0; }
  if (!meta.dim || !Array.isArray(meta.ids)) return 0;
  let buf;
  try { buf = await (await (await dir.getFileHandle("facevecs.bin")).getFile()).arrayBuffer(); }
  catch { return 0; }
  if (buf.byteLength % 4 !== 0) buf = buf.slice(0, buf.byteLength - (buf.byteLength % 4));
  let rows = new Float32Array(buf);
  const onDisk = Math.floor(rows.length / meta.dim);
  if (rows.length % meta.dim !== 0) rows = rows.subarray(0, onDisk * meta.dim);
  if (onDisk !== meta.ids.length){
    const keep = Math.min(onDisk, meta.ids.length);
    meta.ids = meta.ids.slice(0, keep);
    rows = rows.subarray(0, keep * meta.dim);
  }
  FACES.vec.dim = meta.dim;
  FACES.vec.ids = meta.ids;
  FACES.vec.rows = new Float32Array(rows);
  meta.ids.forEach((id, i) => FACES.vec.index.set(id, i));
  return meta.ids.length;
}

async function appendFaceVectors(pairs){
  if (!pairs.length) return;
  const dim = pairs[0].vec.length;
  if (FACES.vec.dim && FACES.vec.dim !== dim)
    throw new Error("face embedding dim changed (" + FACES.vec.dim + " -> " + dim
      + "). Keep your face data: a complete model migration is needed before scanning with this model.");
  const fresh = pairs.filter(p => !FACES.vec.index.has(p.id));
  if (!fresh.length) return;

  /* Build the new state LOCALLY and publish it only after the bytes are on
     disk. Mutating FACES.vec first meant a failed write left memory claiming
     rows the file did not have -- and because the next call then wrote an even
     longer buffer, one failure poisoned every subsequent one. That is how 2,951
     face crops came to exist beside no vectors at all. */
  const old = FACES.vec.rows || new Float32Array(0);
  const rows = new Float32Array(old.length + fresh.length * dim);
  rows.set(old, 0);
  const ids = FACES.vec.ids.slice();
  for (const p of fresh){
    rows.set(faceNormalise(p.vec), ids.length * dim);  // normalised: cosine is a dot
    ids.push(p.id);
  }

  await exclusive(async () => {
    const dir = await facesDir();
    const fh = await dir.getFileHandle("facevecs.bin", { create:true });
    const onDisk = (await fh.getFile()).size;
    const wanted = ids.length * dim * 4;
    /* APPEND the new rows. Rewriting the whole file per face is quadratic: at
       5,247 faces that is ~5 MB written per face, which on a 430 KB/s share is
       about 17 hours of pure vector writing -- longer than reading the photos.
       A file longer than expected is the one case that needs a full rewrite. */
    if (onDisk > wanted){
      const w = await fh.createWritable();
      await w.write(rows.buffer); await w.close();
    } else if (onDisk < wanted){
      const w = await fh.createWritable({ keepExistingData:true });
      await w.seek(onDisk);
      await w.write(rows.buffer.slice(onDisk, wanted));
      await w.close();
    }
    const size = (await fh.getFile()).size;
    if (size !== wanted)
      throw new Error("facevecs.bin is " + size + " bytes, expected " + wanted
        + " — not recording ids the file does not contain");
    await writeFile(await dir.getFileHandle("facevecs.json", { create:true }),
      JSON.stringify({ dim, engine: FACE_ENGINE_NAME, ids }));
  });

  /* Committed. Now it is safe to say so. */
  FACES.vec.rows = rows;
  FACES.vec.ids = ids;
  FACES.vec.dim = dim;
  FACES.vec.index = new Map();
  ids.forEach((id, i) => FACES.vec.index.set(id, i));
}

async function appendFaces(list){
  if (!list.length) return;
  const dir = await facesDir();
  await exclusive(async () => {
    const fh = await dir.getFileHandle("faces.jsonl", { create:true });
    const size = (await fh.getFile()).size;
    const text = list.map(o => JSON.stringify(o)).join("\n") + "\n";
    const w = await fh.createWritable({ keepExistingData:true });
    await w.seek(size); await w.write(text); await w.close();
    const after = (await fh.getFile()).size;
    if (after !== size + new Blob([text]).size)
      throw new Error("faces.jsonl did not land in full");
  });
  for (const f of list){
    FACES.faces.set(f.id, f);
    if (!FACES.byPhoto.has(f.photo_id)) FACES.byPhoto.set(f.photo_id, []);
    if (!FACES.byPhoto.get(f.photo_id).includes(f.id))
      FACES.byPhoto.get(f.photo_id).push(f.id);
  }
}

async function loadPeople(){
  const dir = await facesDir();
  let t;
  try { t = await (await (await dir.getFileHandle("people.json")).getFile()).text(); }
  catch (e){ if (!isNotFound(e)) throw e; }
  const d = t == null ? { people:[], clusters:[] } : parsePeople(t);
  applyPeopleState(d);
  rebuildFaceNames();
}

function parsePeople(text){
  const d = JSON.parse(text);
  const strings = a => Array.isArray(a) && a.every(id => typeof id === "string");
  if (!d || !Array.isArray(d.people) || !Array.isArray(d.clusters)
      || [...d.people, ...d.clusters].some(g => !g || typeof g.id !== "string" || !strings(g.face_ids)
        || (g.confirmed_ids && !strings(g.confirmed_ids)) || (g.rejected_ids && !strings(g.rejected_ids)))
      || (d.separations && (!Array.isArray(d.separations)
        || d.separations.some(s => !s || !strings(s.a) || !strings(s.b))))
      || (d.review && (!Array.isArray(d.review)
        || d.review.some(r => !r || typeof r.face_id !== "string" || typeof r.person_id !== "string"))))
    throw new Error("People data is damaged. Restore a verified backup before editing names.");
  if (d.version && d.version > 2) throw new Error("People data needs a newer PhotoSearch app.");
  return d;
}
function peopleState(){
  return JSON.parse(JSON.stringify({ version:2, clustered_at:FACES.clusteredAt,
    people:FACES.people, clusters:FACES.clusters, separations:FACES.separations,
    review:FACES.review }));
}
function applyPeopleState(d){
  FACES.people = d.people || []; FACES.clusters = d.clusters || [];
  FACES.separations = d.separations || []; FACES.review = d.review || [];
  FACES.clusteredAt = d.clustered_at || null; FACES.undo = d.undo || null;
}
async function savePeople(){
  const dir = await facesDir();
  const next = JSON.stringify({ ...peopleState(), undo:FACES.undo });
  await exclusive(async () => {
    let previous = null;
    try { previous = await (await (await dir.getFileHandle("people.json")).getFile()).text(); }
    catch (e){ if (!isNotFound(e)) throw e; }
    // Never replace an unreadable file with an apparently successful empty state.
    if (previous != null){
      parsePeople(previous);
      await writeVerifiedText(dir, "people.previous.json", previous);
    }
    await writeVerifiedText(dir, "people.json", next);
  });
  rebuildFaceNames();
}

let peopleEditChain = Promise.resolve();
function editPeople(change, keepUndo = true){
  const run = peopleEditChain.then(async () => {
    if (RUN.active || libraryMaintenance) throw new Error("Wait for the current scan, backup or restore before changing people.");
    const before = peopleState(), oldUndo = FACES.undo;
    try {
      const result = change();
      FACES.undo = keepUndo ? before : null;
      await savePeople();
      return result;
    } catch (e){ applyPeopleState({ ...before, undo:oldUndo }); rebuildFaceNames(); throw e; }
  });
  peopleEditChain = run.catch(() => {});
  return run;
}
async function undoPeopleEdit(){
  return editPeople(() => {
    if (!FACES.undo) throw new Error("There is no people edit to undo.");
    applyPeopleState(FACES.undo);
  }, false);
}

/* photo -> the names of people appearing in it, for search and captions. */
function rebuildFaceNames(){
  const m = new Map();
  for (const p of FACES.people){
    if (!p.name) continue;
    for (const fid of p.face_ids){
      const f = FACES.faces.get(fid);
      if (!f) continue;
      if (!m.has(f.photo_id)) m.set(f.photo_id, []);
      const arr = m.get(f.photo_id);
      if (!arr.includes(p.name)) arr.push(p.name);
    }
  }
  FACES.namesByPhoto = m;
  return m;
}
/* Names must work everywhere -- chat, the search box, the timeline -- not only
   after the People tab has been opened. This reads the two SMALL files and
   deliberately not the vectors, which can be tens of megabytes and are needed
   only for grouping. */
let faceNamesLoaded = false;
async function ensureFaceNames(){
  if (faceNamesLoaded || FACES.loaded) return FACES.namesByPhoto;
  try {
    const dir = await facesDir();
    const text = await readTextIfAny(dir, "faces.jsonl");
    if (text){
      FACES.faces = new Map();
      for (const ln of text.split("\n")){
        if (!ln.trim()) continue;
        try { const f = JSON.parse(ln); if (f && f.id){
          if (f.removed) FACES.faces.delete(f.id); else FACES.faces.set(f.id, f);
        } }
        catch {}
      }
      FACES.byPhoto = new Map();
      for (const f of FACES.faces.values()){
        if (!FACES.byPhoto.has(f.photo_id)) FACES.byPhoto.set(f.photo_id, []);
        FACES.byPhoto.get(f.photo_id).push(f.id);
      }
    }
    await loadPeople();
    faceNamesLoaded = true;
  } catch (e){ faceNamesLoaded = false; throw e; }
  return FACES.namesByPhoto;
}

/* Faces described by a different engine configuration cannot be compared with
   the current ones, so say so rather than clustering nonsense together. */
function staleFaceEngines(){
  const want = faceEngineId();
  const seen = new Set();
  for (const f of FACES.faces.values())
    if (f.engine && f.engine !== want) seen.add(f.engine);
  return [...seen];
}

/* Read by recordTerms() so a name is searchable, and by candidateSet(). */
function faceNamesFor(photoId){ return FACES.namesByPhoto.get(photoId) || []; }

