
/* ================= faces =================
   Grouping by resemblance, named only by the user.

   WHAT THIS DOES: finds face rectangles, turns each into a vector, and groups
   vectors that are close together. WHAT IT NEVER DOES: decide who anyone is.
   A group has no name until you type one, and nothing is ever looked up,
   inferred or suggested.

   Age, gender, emotion, ethnicity: not stored, not displayed, not used for
   anything. The emotion, iris, antispoof and liveness models are switched off
   outright. One caveat stated plainly rather than glossed: `human`'s descriptor
   model computes age and a gender guess as a side effect of producing the
   embedding -- they cannot be requested separately. They are discarded at the
   adapter boundary below and never reach a record, and a test asserts that. If
   that is not good enough, the ArcFace path has no demographic head at all.

   Face vectors are biometric data. They live only in .photoindex/faces/, are
   never transmitted anywhere, and deleteAllFaceData() removes every trace. */

const FACES = {
  dir: null,
  loaded: false,
  faces: new Map(),            // face_id -> { id, photo_id, box, score, engine }
  vec: { dim:0, ids:[], rows:null, index:new Map() },
  people: [],                  // [{ id, name, face_ids:[] }]  -- user-named
  clusters: [],                // [{ id, face_ids }]           -- unnamed
  byPhoto: new Map(),          // photo_id -> [face_id]
  namesByPhoto: new Map(),     // photo_id -> [name]
  clusteredAt: null
};

async function facesDir(){
  if (!FACES.dir) FACES.dir = await IDX.dir.getDirectoryHandle("faces", { create:true });
  return FACES.dir;
}

/* ---- the engine adapter ----
   The contract is one function: given an image, return zero or more
   { box:[x,y,w,h] normalised 0..1, score, vec:Float32Array }. Everything below
   this line is arithmetic and storage, so the detector can be swapped -- or
   replaced by a stub in tests -- without touching any of it. */
let FACE_ENGINE = null;
let FACE_ENGINE_NAME = null;
function setFaceEngine(fn, name){ FACE_ENGINE = fn; FACE_ENGINE_NAME = name || "custom"; }

/* One version, used for BOTH the library and its weights: the models ship
   inside the package itself, and pointing modelBasePath at a separate package
   was a 404. TensorFlow.js does not report a missing model -- it parses the
   error page as a graph and later dies on "Cannot read properties of undefined
   (reading 'inputNodes')", which says nothing about what actually went wrong. */
const HUMAN_VERSION = "3.3.6";
/* Recorded on every face. Vectors from a different configuration are NOT
   comparable -- unaligned ones encode pose -- so a change here has to be
   visible rather than silently mixed into the same clusters. */
const FACE_ENGINE_ID = "human@3.3.6+aligned";
const HUMAN_BASE = "https://cdn.jsdelivr.net/npm/@vladmandic/human@" + HUMAN_VERSION;
const HUMAN_URL = HUMAN_BASE + "/dist/human.esm.js";
const HUMAN_MODELS = HUMAN_BASE + "/models/";

/* So a bad path fails with a sentence instead of a TensorFlow internal. */
async function checkFaceModels(base, fetcher){
  const f = fetcher || fetch;
  const url = base + "blazeface.json";
  let res;
  try { res = await f(url); }
  catch (e){
    throw new Error("could not reach the face model at " + url + " (" + errText(e)
      + "). It is downloaded once and then cached; a connection is needed the "
      + "first time only.");
  }
  if (!res.ok)
    throw new Error("the face model is not at " + url + " (HTTP " + res.status
      + "). The CDN path has moved; nothing was downloaded.");
  let meta;
  try { meta = JSON.parse(await res.text()); }
  catch { throw new Error("the face model at " + url + " is not a model file — "
    + "the CDN returned something else, probably an error page."); }
  if (!meta || !meta.format)
    throw new Error("the file at " + url + " is not a TensorFlow graph model.");
  return true;
}

async function loadHumanEngine(onPhase){
  if (FACE_ENGINE) return FACE_ENGINE;
  const say = async m => { if (onPhase) await onPhase(m); };
  await say("Checking the face model…");
  await checkFaceModels(HUMAN_MODELS);
  await say("Loading the face model…");
  const mod = await import(/* @vite-ignore */ HUMAN_URL);
  const Human = mod.default || mod.Human;
  const human = new Human({
    modelBasePath: HUMAN_MODELS,
    cacheSensitivity: 0,
    filter: { enabled:false },
    /* Everything that is not detection or the embedding is off. */
    face: {
      enabled: true,
      /* mesh and rotation are REQUIRED for usable embeddings, not optional
         quality settings. The descriptor runs on the crop it is handed, so
         without landmark alignment it encodes pose rather than identity.
         Measured on the same face across rotations and scales:

             mesh+rotation off:  self 0.527  cross 0.393  separability 0.134
             mesh+rotation on:   self 0.925  cross 0.586  separability 0.339

         Shipping this off was why groups mixed different people together. */
      detector: { enabled:true, rotation:true, maxDetected:20, minConfidence:0.4 },
      mesh:      { enabled:true },         // landmarks -> alignment
      iris:      { enabled:false },
      emotion:   { enabled:false },
      antispoof: { enabled:false },
      liveness:  { enabled:false },
      description: { enabled:true }        // the embedding lives here
    },
    body: { enabled:false }, hand: { enabled:false },
    object: { enabled:false }, gesture: { enabled:false }, segmentation: { enabled:false }
  });
  await say("Downloading the face model (first run only)…");
  await human.load();
  /* A warmup failure must not stop the real work: it runs the models over a
     sample image and is a smoke test, not a requirement. */
  await say("Warming up…");
  try { await human.warmup(); } catch (e){ console.warn("face warmup:", errText(e)); }

  setFaceEngine(async bitmap => {
    const res = await human.detect(bitmap);
    const W = bitmap.width || 1, H = bitmap.height || 1;
    const out = [];
    for (const f of (res.face || [])){
      if (!f.embedding || !f.embedding.length) continue;
      const [x, y, w, h] = f.box || [0, 0, 0, 0];
      /* Only the geometry and the vector are carried forward. f.age,
         f.gender and f.genderScore are deliberately dropped here. */
      out.push({
        box: [x / W, y / H, w / W, h / H].map(v => Math.max(0, Math.min(1, v))),
        score: faceScoreOf(f),
        vec: Float32Array.from(f.embedding)
      });
    }
    return out;
  }, FACE_ENGINE_ID);
  return FACE_ENGINE;
}

/* The detector's confidence, whichever field carries it.
   `faceScore` is ALWAYS 0 here because it comes from the mesh model, which is
   deliberately disabled -- preferring it silently scored every face 0 and the
   minimum-score filter then discarded the lot. Verified against the real
   engine: score and boxScore both read 0.53 where faceScore read 0. */
function faceScoreOf(f){
  for (const v of [f.boxScore, f.score, f.faceScore])
    if (typeof v === "number" && v > 0) return v;
  return 0;
}

/* ---- vector maths ---- */
function faceNormalise(v){
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}
/* Both sides are unit length, so the dot product IS the cosine. */
function faceDot(a, ao, b, bo, dim){
  let s = 0;
  for (let i = 0; i < dim; i++) s += a[ao + i] * b[bo + i];
  return s;
}
function faceVectorOf(faceId){
  const i = FACES.vec.index.get(faceId);
  if (i == null || !FACES.vec.rows) return null;
  return FACES.vec.rows.subarray(i * FACES.vec.dim, (i + 1) * FACES.vec.dim);
}

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
  for (const f of FACES.faces.values()){
    if (f.removed) { FACES.faces.delete(f.id); continue; }
    if (!FACES.byPhoto.has(f.photo_id)) FACES.byPhoto.set(f.photo_id, []);
    FACES.byPhoto.get(f.photo_id).push(f.id);
  }
  await loadFaceVectors();
  await loadPeople();
  FACES.loaded = true;
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
      + "); delete the face data and re-run");
  const fresh = pairs.filter(p => !FACES.vec.index.has(p.id));
  if (!fresh.length) return;
  const old = FACES.vec.rows || new Float32Array(0);
  const next = new Float32Array(old.length + fresh.length * dim);
  next.set(old, 0);
  for (const p of fresh){
    const row = FACES.vec.ids.length;
    next.set(faceNormalise(p.vec), row * dim);   // stored normalised: cosine is a dot
    FACES.vec.index.set(p.id, row);
    FACES.vec.ids.push(p.id);
  }
  FACES.vec.rows = next;
  FACES.vec.dim = dim;
  await exclusive(async () => {
    const dir = await facesDir();
    const fh = await dir.getFileHandle("facevecs.bin", { create:true });
    const wanted = FACES.vec.ids.length * dim * 4;
    const w = await fh.createWritable();
    await w.write(FACES.vec.rows.buffer);
    await w.close();
    const size = (await fh.getFile()).size;
    if (size !== wanted)
      throw new Error("facevecs.bin is " + size + " bytes, expected " + wanted);
    await writeFile(await dir.getFileHandle("facevecs.json", { create:true }),
      JSON.stringify({ dim, engine: FACE_ENGINE_NAME, ids: FACES.vec.ids }));
  });
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
  FACES.people = []; FACES.clusters = []; FACES.clusteredAt = null;
  const t = await readTextIfAny(dir, "people.json");
  if (!t) return;
  try {
    const d = JSON.parse(t);
    FACES.people = (d.people || []).filter(p => p && p.id);
    FACES.clusters = (d.clusters || []).filter(c => c && c.id);
    FACES.clusteredAt = d.clustered_at || null;
  } catch {}
  rebuildFaceNames();
}

async function savePeople(){
  const dir = await facesDir();
  await writeFile(await dir.getFileHandle("people.json", { create:true }),
    JSON.stringify({ version:1, clustered_at: FACES.clusteredAt,
      people: FACES.people, clusters: FACES.clusters }, null, 1));
  rebuildFaceNames();
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
/* Faces described by a different engine configuration cannot be compared with
   the current ones, so say so rather than clustering nonsense together. */
function staleFaceEngines(){
  const seen = new Set();
  for (const f of FACES.faces.values())
    if (f.engine && f.engine !== FACE_ENGINE_ID) seen.add(f.engine);
  return [...seen];
}

/* Read by recordTerms() so a name is searchable, and by candidateSet(). */
function faceNamesFor(photoId){ return FACES.namesByPhoto.get(photoId) || []; }

/* ---- clustering ----
   Greedy against centroids rather than all-pairs. All-pairs on ~8,000 faces is
   32M comparisons of 1,024 floats, which is minutes; against a few hundred
   centroids it is seconds, and the result is the same in practice because
   faces of one person are tight in this space.

   A NAMED person is authoritative and is never re-clustered away: naming is
   the user's work and re-running this must not destroy it. Unnamed faces are
   matched against named people first, so new photos join "Anna" by themselves. */
function faceCentroid(faceIds){
  const dim = FACES.vec.dim;
  if (!dim) return null;
  const c = new Float32Array(dim);
  let n = 0;
  for (const id of faceIds){
    const v = faceVectorOf(id);
    if (!v) continue;
    for (let i = 0; i < dim; i++) c[i] += v[i];
    n++;
  }
  if (!n) return null;
  for (let i = 0; i < dim; i++) c[i] /= n;
  return faceNormalise(c);
}

function clusterFaces(threshold){
  const th = threshold != null ? threshold : S.faces.threshold;
  const dim = FACES.vec.dim;
  if (!dim || !FACES.vec.ids.length){ FACES.clusters = []; return FACES; }

  const assigned = new Set();
  const seeds = [];
  for (const p of FACES.people){
    p.face_ids = p.face_ids.filter(id => FACES.faces.has(id));
    for (const id of p.face_ids) assigned.add(id);
    const c = faceCentroid(p.face_ids);
    if (c) seeds.push({ person:p, centroid:c, n:p.face_ids.length });
  }

  /* Confident faces first, so a clear photo seeds a group rather than a blur. */
  const rest = FACES.vec.ids.filter(id => !assigned.has(id) && FACES.faces.has(id))
    .sort((a, b) => (FACES.faces.get(b).score || 0) - (FACES.faces.get(a).score || 0));

  const groups = [];
  for (const id of rest){
    const v = faceVectorOf(id);
    if (!v) continue;
    let best = null, bestSim = th;
    for (const s of seeds){
      const sim = faceDot(v, 0, s.centroid, 0, dim);
      if (sim < bestSim) continue;
      let near = -1;
      for (const mid of s.person.face_ids){
        const mv = faceVectorOf(mid);
        if (!mv) continue;
        const d2 = faceDot(v, 0, mv, 0, dim);
        if (d2 > near) near = d2;
        if (near >= th) break;
      }
      if (near < th) continue;        // never auto-join a person on drift alone
      bestSim = sim; best = s;
    }
    if (best){                                   // joins an existing named person
      best.person.face_ids.push(id);
      const c = faceCentroid(best.person.face_ids);
      if (c) best.centroid = c;
      continue;
    }
    /* Match the CENTROID and the nearest MEMBER. Centroid-only merging drifts:
       one wrong face moves the centre, which pulls in more wrong faces, and a
       group ends up as a blur of several people. Requiring a close individual
       neighbour as well stops that cascade. */
    let bg = null; bestSim = th;
    for (const g of groups){
      const sim = faceDot(v, 0, g.centroid, 0, dim);
      if (sim < bestSim) continue;
      let near = -1;
      for (const mid of g.face_ids){
        const mv = faceVectorOf(mid);
        if (!mv) continue;
        const d2 = faceDot(v, 0, mv, 0, dim);
        if (d2 > near) near = d2;
        if (near >= th) break;                  // close enough, stop looking
      }
      if (near < th) continue;
      bestSim = sim; bg = g;
    }
    if (bg){
      bg.face_ids.push(id);
      const c = faceCentroid(bg.face_ids);
      if (c) bg.centroid = c;
    } else {
      groups.push({ id:"c-" + (groups.length + 1) + "-" + Date.now().toString(36),
                    face_ids:[id], centroid: faceNormalise(v) });
    }
  }
  /* Biggest groups first: those are the people worth naming. */
  FACES.clusters = groups
    .map(g => ({ id:g.id, face_ids:g.face_ids }))
    .sort((a, b) => b.face_ids.length - a.face_ids.length);
  FACES.clusteredAt = new Date().toISOString();
  rebuildFaceNames();
  return FACES;
}

/* ---- naming, merging, splitting ---- */
function findPerson(id){ return FACES.people.find(p => p.id === id) || null; }
function findCluster(id){ return FACES.clusters.find(c => c.id === id) || null; }

/* Names a cluster (promoting it to a person) or renames an existing person. */
async function namePerson(id, name){
  name = String(name || "").trim();
  const existing = findPerson(id);
  if (existing){
    if (!name){                       // clearing a name returns it to unnamed
      FACES.people = FACES.people.filter(p => p !== existing);
      FACES.clusters.unshift({ id: existing.id, face_ids: existing.face_ids });
    } else existing.name = name;
    await savePeople();
    return existing;
  }
  const c = findCluster(id);
  if (!c) throw new Error("no such group: " + id);
  if (!name) return null;
  FACES.clusters = FACES.clusters.filter(x => x !== c);
  const person = { id: c.id, name, face_ids: c.face_ids.slice(),
                   named_at: new Date().toISOString() };
  FACES.people.push(person);
  await savePeople();
  return person;
}

/* Clustering will split one person across two groups; this is the fix. */
async function mergeGroups(intoId, fromId){
  if (intoId === fromId) return null;
  const into = findPerson(intoId) || findCluster(intoId);
  const from = findPerson(fromId) || findCluster(fromId);
  if (!into || !from) throw new Error("no such group");
  for (const id of from.face_ids)
    if (!into.face_ids.includes(id)) into.face_ids.push(id);
  FACES.people = FACES.people.filter(p => p !== from);
  FACES.clusters = FACES.clusters.filter(c => c !== from);
  await savePeople();
  return into;
}

/* And it will merge two people into one group; this is that fix. */
async function splitOut(groupId, faceIds){
  const g = findPerson(groupId) || findCluster(groupId);
  if (!g) throw new Error("no such group");
  const moving = faceIds.filter(id => g.face_ids.includes(id));
  if (!moving.length) return null;
  g.face_ids = g.face_ids.filter(id => !moving.includes(id));
  const fresh = { id: "c-split-" + Date.now().toString(36), face_ids: moving };
  FACES.clusters.unshift(fresh);
  /* A group emptied by the split disappears rather than lingering as a ghost. */
  if (!g.face_ids.length){
    FACES.people = FACES.people.filter(p => p !== g);
    FACES.clusters = FACES.clusters.filter(c => c !== g);
  }
  await savePeople();
  return fresh;
}

/* Everything, in one action, leaving the rest of the index untouched. */
async function deleteAllFaceData(){
  /* Drop the cached handle FIRST so nothing re-creates the folder behind the
     removal, then take the whole directory in one call. */
  FACES.dir = null;
  try { await IDX.dir.removeEntry("faces", { recursive:true }); } catch {}
  FACES.faces = new Map(); FACES.byPhoto = new Map(); FACES.namesByPhoto = new Map();
  FACES.vec = { dim:0, ids:[], rows:null, index:new Map() };
  FACES.people = []; FACES.clusters = []; FACES.clusteredAt = null;
  FACES.loaded = false;
  return true;
}

/* ---- detecting ---- */
function faceIdFor(photoId, box){
  return photoId + "-f" + box.map(v => Math.round(v * 1000)).join("_");
}

/* One photo, already decoded. Returns the face rows written. */
async function detectFacesIn(photoId, bitmap){
  if (!FACE_ENGINE) throw new Error("no face engine loaded");
  const found = await FACE_ENGINE(bitmap);
  /* A face 30 pixels across carries no identity: the descriptor returns
     something, it just is not about this person, and one such face poisons a
     whole group. Judged on the longer side of the box relative to the image. */
  const keep = found
    .filter(f => (f.score || 0) >= S.faces.minScore)
    .filter(f => Math.max(f.box[2], f.box[3]) >= S.faces.minRelSize)
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, S.faces.maxPerPhoto);
  if (!keep.length) return [];
  const rows = [], pairs = [];
  for (const f of keep){
    const id = faceIdFor(photoId, f.box);
    if (FACES.faces.has(id)) continue;
    rows.push({ id, photo_id: photoId, box: f.box.map(v => +v.toFixed(4)),
                score: +(f.score || 0).toFixed(4),
                engine: FACE_ENGINE_NAME, detected_at: new Date().toISOString() });
    pairs.push({ id, vec: f.vec });
  }
  if (!rows.length) return [];
  await appendFaceVectors(pairs);      // vectors first: a face row with no vector is useless
  await appendFaces(rows);
  return rows;
}
