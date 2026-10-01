
/* ================= faces =================
   Grouping by resemblance, named only by the user.

   WHAT THIS DOES: finds face rectangles, turns each into a vector, and groups
   vectors that are close together. WHAT IT NEVER DOES: decide who anyone is.
   A group has no name until you type one. Later matches can suggest one of
   those user-supplied names for review; no external identity is looked up.

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
  separations: [],             // user decisions: faces on opposite sides must stay apart
  review: [],                  // plausible, ambiguous matches; never searchable as a name
  undo: null,
  clusteredAt: null
};

async function facesDir(){
  if (!FACES.dir) FACES.dir = await IDX.dir.getDirectoryHandle("faces", { create:true });
  return FACES.dir;
}

function resetFaceState(){
  FACES.dir = null; FACES.loaded = false; faceNamesLoaded = false;
  FACES.faces = new Map(); FACES.byPhoto = new Map(); FACES.namesByPhoto = new Map();
  FACES.vec = { dim:0, ids:[], rows:null, index:new Map() };
  FACES.people = []; FACES.clusters = []; FACES.separations = []; FACES.review = [];
  FACES.undo = null; FACES.clusteredAt = null;
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
function faceEngineId(){
  return S.faces.embedder === "faceres"
    ? "human@3.3.6-faceres+aligned"
    : "arcface-buffalo_s+5pt";
}
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
        /* faceres' own descriptor, kept so the two embedders can be compared
           on the same detections without a second pass over the photos. */
        vec: Float32Array.from(f.embedding),
        /* Transient, for alignment only. NEVER stored: it is a detailed map of
           someone's face, and nothing downstream needs it once the 112x112
           crop exists. */
        mesh: f.mesh
      });
    }
    return out;
  }, "human@3.3.6-detect");
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

/* ---- alignment ----
   ArcFace is trained on faces warped onto a fixed five-point template, and it
   is not robust to anything else: handing it a raw box crop is the mistake that
   makes a recognition model behave like a texture matcher. These are the
   canonical destination points for a 112x112 crop, as used by InsightFace. */
const ARC_TEMPLATE = [[38.2946,51.6963],[73.5318,51.5014],[56.0252,71.7366],
                      [41.5493,92.3655],[70.7299,92.2041]];
const ARC_SIZE = 112;

/* MediaPipe's 468-point mesh reduced to the five ArcFace needs. Order matters:
   the template expects the IMAGE-left eye first, so the pairs are sorted by x
   rather than trusted to arrive in a particular orientation. */
function faceFivePoints(mesh){
  if (!mesh || mesh.length < 400) return null;
  const at = i => mesh[i];
  const mid = (a, b) => [(at(a)[0] + at(b)[0]) / 2, (at(a)[1] + at(b)[1]) / 2];
  let eyeA = mid(33, 133), eyeB = mid(362, 263);
  let mouthA = at(61).slice(0, 2), mouthB = at(291).slice(0, 2);
  if (eyeA[0] > eyeB[0]){ const t = eyeA; eyeA = eyeB; eyeB = t; }
  if (mouthA[0] > mouthB[0]){ const t = mouthA; mouthA = mouthB; mouthB = t; }
  return [eyeA, eyeB, at(1).slice(0, 2), mouthA, mouthB];
}

/* Least-squares similarity transform (Procrustes): rotation, uniform scale and
   translation, no shear -- the same family InsightFace uses, so a face arrives
   at the template upright and at the right size whatever the head was doing. */
function faceSimTransform(src, dst){
  const n = src.length;
  const mean = pts => pts.reduce((a, q) => [a[0] + q[0], a[1] + q[1]], [0, 0])
                          .map(v => v / n);
  const [sx0, sy0] = mean(src), [dx0, dy0] = mean(dst);
  let a = 0, b = 0, d = 0;
  for (let i = 0; i < n; i++){
    const sx = src[i][0] - sx0, sy = src[i][1] - sy0;
    const dx = dst[i][0] - dx0, dy = dst[i][1] - dy0;
    a += sx * dx + sy * dy;
    b += sx * dy - sy * dx;
    d += sx * sx + sy * sy;
  }
  if (!d) return null;
  const sa = a / d, sb = b / d;
  return { a:sa, b:sb, c:-sb, d:sa,
           e: dx0 - (sa * sx0 - sb * sy0),
           f: dy0 - (sb * sx0 + sa * sy0) };
}

function faceAlignedCrop(bitmap, mesh){
  const five = faceFivePoints(mesh);
  if (!five) return null;
  const m = faceSimTransform(five, ARC_TEMPLATE);
  if (!m) return null;
  const c = new OffscreenCanvas(ARC_SIZE, ARC_SIZE);
  const x = c.getContext("2d");
  x.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
  x.drawImage(bitmap, 0, 0);
  x.setTransform(1, 0, 0, 1, 0, 0);
  return c;
}

/* ---- the ArcFace embedder ----
   A purpose-built recognition model, where `human`'s faceres produces a
   descriptor as a by-product of estimating age and gender. buffalo_s is the
   13 MB MobileFaceNet variant InsightFace ships and Immich uses. */
const ORT_BASE = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/";
const ARC_MODEL =
  "https://huggingface.co/immich-app/buffalo_s/resolve/main/recognition/model.onnx";
let ARC = null;

async function loadArcFace(onPhase){
  if (ARC) return ARC;
  const say = async m => { if (onPhase) await onPhase(m); };
  await say("Loading the recognition runtime…");
  const ort = await import(/* @vite-ignore */ ORT_BASE + "ort.min.mjs");
  ort.env.wasm.wasmPaths = ORT_BASE;
  /* No SharedArrayBuffer from a file:// page, so threads are not available.
     Asking for them makes session creation fail outright. */
  ort.env.wasm.numThreads = 1;
  ort.env.logLevel = "error";
  await say("Downloading the recognition model (13 MB, first run only)…");
  const res = await fetch(ARC_MODEL);
  if (!res.ok)
    throw new Error("could not download the recognition model (HTTP " + res.status
      + "). It is fetched once and then cached by the browser.");
  const buf = await res.arrayBuffer();
  await say("Starting the recognition model…");
  const sess = await ort.InferenceSession.create(buf, { executionProviders:["wasm"] });
  ARC = { ort, sess, dim: 512,
          input: sess.inputNames[0], output: sess.outputNames[0] };
  return ARC;
}

/* Expects the 112x112 aligned crop, NCHW, scaled to [-1,1]. */
async function arcEmbedCrop(canvas){
  const a = ARC;
  if (!a) throw new Error("the recognition model is not loaded");
  const px = canvas.getContext("2d").getImageData(0, 0, ARC_SIZE, ARC_SIZE).data;
  const n = ARC_SIZE * ARC_SIZE;
  const data = new Float32Array(3 * n);
  for (let i = 0; i < n; i++){
    data[i]         = (px[i * 4]     - 127.5) / 127.5;
    data[n + i]     = (px[i * 4 + 1] - 127.5) / 127.5;
    data[2 * n + i] = (px[i * 4 + 2] - 127.5) / 127.5;
  }
  const out = await a.sess.run({
    [a.input]: new a.ort.Tensor("float32", data, [1, 3, ARC_SIZE, ARC_SIZE]) });
  return Float32Array.from(out[a.output].data);
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

/* The two embedders live in different spaces, so a single number cannot serve
   both: ArcFace cosines for one person sit far lower than faceres'. */
function faceThreshold(){
  return S.faces.embedder === "faceres"
    ? S.faces.faceresThreshold : S.faces.threshold;
}

function clusterFaces(threshold){
  const th = threshold != null ? threshold : faceThreshold();
  const dim = FACES.vec.dim;
  if (!dim || !FACES.vec.ids.length){ FACES.clusters = []; return FACES; }
  if (staleFaceEngines().length)
    throw new Error("These face measurements use a different model. A complete set of stored crops or a staged migration from originals is needed before regrouping. Your names are kept.");

  FACES.review = [];
  const constraints = FACES.separations.map(s => ({ a:new Set(s.a), b:new Set(s.b) }));
  const compatible = (id, members) => {
    const photo = FACES.faces.get(id).photo_id;
    if (members.some(mid => FACES.faces.get(mid)?.photo_id === photo)) return false;
    return !constraints.some(s => (s.a.has(id) && members.some(m => s.b.has(m)))
      || (s.b.has(id) && members.some(m => s.a.has(m))));
  };

  const assigned = new Set();
  const seeds = [];
  for (const p of FACES.people){
    p.face_ids = p.face_ids.filter(id => FACES.faces.has(id));
    for (const id of p.face_ids) assigned.add(id);
    const anchors = (p.confirmed_ids || p.face_ids).filter(id => FACES.faces.has(id));
    p.confirmed_ids = anchors.slice();
    // Conflicting history must not become training evidence for more matches.
    const photos = anchors.map(id => FACES.faces.get(id).photo_id);
    if (new Set(photos).size !== photos.length) continue;
    const c = faceCentroid(anchors);
    if (c) seeds.push({ person:p, centroid:c, anchors });
  }

  /* Confident faces first, so a clear photo seeds a group rather than a blur. */
  const rest = FACES.vec.ids.filter(id => !assigned.has(id) && FACES.faces.has(id))
    .sort((a, b) => (FACES.faces.get(b).score || 0) - (FACES.faces.get(a).score || 0));

  const groups = [];
  for (const id of rest){
    const v = faceVectorOf(id);
    if (!v) continue;
    let best = null, bestSim = th;
    const matches = [];
    for (const s of seeds){
      if (!compatible(id, s.person.face_ids) || (s.person.rejected_ids || []).includes(id)) continue;
      const sim = faceDot(v, 0, s.centroid, 0, dim);
      if (sim < th) continue;
      let near = -1;
      for (const mid of s.anchors){
        const mv = faceVectorOf(mid);
        if (!mv) continue;
        const d2 = faceDot(v, 0, mv, 0, dim);
        if (d2 > near) near = d2;
        if (near >= th) break;
      }
      if (near < th) continue;        // never auto-join a person on drift alone
      matches.push({ seed:s, sim });
    }
    matches.sort((a,b) => b.sim - a.sim);
    const lead = matches[0], margin = 0.06;
    if (lead && lead.sim >= Math.min(0.99, th + margin)
        && (!matches[1] || lead.sim - matches[1].sim >= margin)) best = lead.seed;
    else if (lead) FACES.review.push({ face_id:id, person_id:lead.seed.person.id,
      score:lead.sim, reason:matches.length > 1 ? "Looks like more than one person" : "Needs your confirmation" });
    if (best){                                   // joins an existing named person
      best.person.face_ids.push(id);
      continue;
    }
    /* Match the CENTROID and the nearest MEMBER. Centroid-only merging drifts:
       one wrong face moves the centre, which pulls in more wrong faces, and a
       group ends up as a blur of several people. Requiring a close individual
       neighbour as well stops that cascade. */
    let bg = null; bestSim = th;
    for (const g of groups){
      if (!compatible(id, g.face_ids)) continue;
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
      groups.push({ id:"c-" + id,
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
  return editPeople(() => {
  name = String(name || "").trim();
  const existing = findPerson(id);
  if (existing){
    if (!name){                       // clearing a name returns it to unnamed
      FACES.people = FACES.people.filter(p => p !== existing);
      FACES.clusters.unshift({ id: existing.id, face_ids: existing.face_ids });
    } else existing.name = name;
    return existing;
  }
  const c = findCluster(id);
  if (!c) throw new Error("no such group: " + id);
  if (!name) return null;
  FACES.clusters = FACES.clusters.filter(x => x !== c);
  const person = { id: c.id, name, face_ids: c.face_ids.slice(),
                   confirmed_ids:c.face_ids.slice(), rejected_ids:[],
                   named_at: new Date().toISOString() };
  FACES.people.push(person);
  return person;
  });
}

/* Clustering will split one person across two groups; this is the fix. */
async function mergeGroups(intoId, fromId){
  return editPeople(() => {
  if (intoId === fromId) return null;
  const into = findPerson(intoId) || findCluster(intoId);
  const from = findPerson(fromId) || findCluster(fromId);
  if (!into || !from) throw new Error("no such group");
  for (const id of from.face_ids)
    if (!into.face_ids.includes(id)) into.face_ids.push(id);
  // An explicit merge overrides earlier separation decisions for these faces.
  const joined = new Set(into.face_ids);
  FACES.separations = FACES.separations.filter(s =>
    !(s.a.some(id => joined.has(id)) && s.b.some(id => joined.has(id))));
  if (into.name){
    into.confirmed_ids = [...new Set([...(into.confirmed_ids || into.face_ids), ...from.face_ids])];
    into.rejected_ids = (into.rejected_ids || []).filter(id => !joined.has(id));
  }
  FACES.review = FACES.review.filter(r => !joined.has(r.face_id) && r.person_id !== fromId);
  FACES.people = FACES.people.filter(p => p !== from);
  FACES.clusters = FACES.clusters.filter(c => c !== from);
  return into;
  });
}

/* And it will merge two people into one group; this is that fix. */
async function splitOut(groupId, faceIds){
  return editPeople(() => {
  const g = findPerson(groupId) || findCluster(groupId);
  if (!g) throw new Error("no such group");
  const moving = faceIds.filter(id => g.face_ids.includes(id));
  if (!moving.length) return null;
  g.face_ids = g.face_ids.filter(id => !moving.includes(id));
  if (g.face_ids.length) FACES.separations.push({ a:moving.slice(), b:g.face_ids.slice() });
  if (g.name){
    g.rejected_ids = [...new Set([...(g.rejected_ids || []), ...moving])];
    g.confirmed_ids = (g.confirmed_ids || g.face_ids).filter(id => !moving.includes(id));
  }
  FACES.review = FACES.review.filter(r => !moving.includes(r.face_id));
  const fresh = { id: "c-split-" + crypto.randomUUID(), face_ids: moving };
  FACES.clusters.unshift(fresh);
  /* A group emptied by the split disappears rather than lingering as a ghost. */
  if (!g.face_ids.length){
    FACES.people = FACES.people.filter(p => p !== g);
    FACES.clusters = FACES.clusters.filter(c => c !== g);
  }
  return fresh;
  });
}

async function reviewFace(faceId, personId, accept){
  return editPeople(() => {
    const p = findPerson(personId);
    if (!p || !FACES.faces.has(faceId)) throw new Error("That face or person is no longer available.");
    p.confirmed_ids = (p.confirmed_ids || p.face_ids).slice();
    if (accept){
      for (const g of [...FACES.people, ...FACES.clusters]){
        g.face_ids = g.face_ids.filter(id => id !== faceId);
        if (g !== p && g.confirmed_ids) g.confirmed_ids = g.confirmed_ids.filter(id => id !== faceId);
      }
      p.face_ids.push(faceId); p.confirmed_ids.push(faceId);
      p.rejected_ids = (p.rejected_ids || []).filter(id => id !== faceId);
      const joined = new Set(p.face_ids);
      FACES.separations = FACES.separations.filter(s =>
        !(s.a.some(id => joined.has(id)) && s.b.some(id => joined.has(id))));
    } else p.rejected_ids = [...new Set([...(p.rejected_ids || []), faceId])];
    FACES.clusters = FACES.clusters.filter(g => g.face_ids.length);
    FACES.review = FACES.review.filter(r => r.face_id !== faceId);
  });
}

/* Everything, in one action, leaving the rest of the index untouched. */
async function deleteAllFaceData(){
  if (libraryMaintenance) throw new Error("Wait for the backup or restore before deleting face data.");
  /* Drop the cached handle FIRST so nothing re-creates the folder behind the
     removal, then take the whole directory in one call. */
  FACES.dir = null;
  try { await IDX.dir.removeEntry("faces", { recursive:true }); } catch {}
  FACES.faces = new Map(); FACES.byPhoto = new Map(); FACES.namesByPhoto = new Map();
  FACES.vec = { dim:0, ids:[], rows:null, index:new Map() };
  FACES.people = []; FACES.clusters = []; FACES.clusteredAt = null;
  FACES.separations = []; FACES.review = []; FACES.undo = null;
  FACES.loaded = false;
  faceNamesLoaded = false;
  return true;
}

/* ---- detecting ---- */
function faceIdFor(photoId, box){
  return photoId + "-f" + box.map(v => Math.round(v * 1000)).join("_");
}

async function cropsDir(){
  return (await facesDir()).getDirectoryHandle("crops", { create:true });
}
/* The aligned 112x112 crop is the costly part of the whole pipeline: getting
   it required reading a multi-megabyte photo off the share and running a
   detector. Storing it (about 5 KB) means trying a different embedder later
   never touches a photo again -- which is the difference between "re-measure
   the library" being minutes and being hours. */
async function saveFaceCrop(id, canvas){
  const blob = await canvas.convertToBlob({ type:"image/jpeg", quality:0.92 });
  const dir = await cropsDir();
  await writeBinary(await dir.getFileHandle(id + ".jpg", { create:true }),
    await blob.arrayBuffer());
  return blob.size;
}
async function faceCropCanvas(id){
  try {
    const dir = await cropsDir();
    const blob = await (await dir.getFileHandle(id + ".jpg")).getFile();
    if (!blob.size) return null;
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(ARC_SIZE, ARC_SIZE);
    c.getContext("2d").drawImage(bmp, 0, 0, ARC_SIZE, ARC_SIZE);
    bmp.close();
    return c;
  } catch { return null; }
}

/* Reads run in parallel because they are latency-bound on a share; detection
   does NOT, because one Human instance is not re-entrant. Parallel readers
   feeding a serialised detector is the shape that fits both. */
let faceDetectChain = Promise.resolve();
/* Anything that runs the detector must go through the same queue, refinement
   included, or two detections overlap on a non-re-entrant instance. */
function faceDetectChainRun(fn){
  const run = faceDetectChain.then(fn, fn);
  faceDetectChain = run.then(() => {}, () => {});
  return run;
}
function detectFacesSerial(photoId, bitmap){
  const run = faceDetectChain.then(
    () => detectAndEmbed(photoId, bitmap),
    () => detectAndEmbed(photoId, bitmap));
  faceDetectChain = run.then(() => {}, () => {});
  return run;
}

/* Storage path: takes an already-detected set and writes it. The production
   pipeline is detectAndEmbed below, which aligns and embeds first; this stays
   as the narrow seam the suite drives, so storage, grouping and naming can be
   exercised without a 13 MB model download or a drawable bitmap. */
async function detectFacesIn(photoId, bitmap, src){
  if (!FACE_ENGINE) throw new Error("no face engine loaded");
  const found = await FACE_ENGINE(bitmap);
  /* A face 30 pixels across carries no identity: the descriptor returns
     something, it just is not about this person, and one such face poisons a
     whole group. Measured in PIXELS, not as a fraction, because the same photo
     is read at 384px from a thumbnail or 1024px from the original and "are
     there enough pixels here" has one answer either way. */
  const W = bitmap.width || 1, H = bitmap.height || 1;
  const facePx = f => Math.max(f.box[2] * W, f.box[3] * H);
  const keep = found
    .filter(f => (f.score || 0) >= S.faces.minScore)
    .filter(f => facePx(f) >= S.faces.minFacePx)
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, S.faces.maxPerPhoto);
  if (!keep.length) return [];
  const rows = [], pairs = [];
  for (const f of keep){
    const id = faceIdFor(photoId, f.box);
    if (FACES.faces.has(id)) continue;
    rows.push({ id, photo_id: photoId, box: f.box.map(v => +v.toFixed(4)),
                score: +(f.score || 0).toFixed(4), px: Math.round(facePx(f)),
                src: src || "thumb",
                engine: FACE_ENGINE_NAME, detected_at: new Date().toISOString() });
    pairs.push({ id, vec: f.vec });
  }
  if (!rows.length) return [];
  await appendFaceVectors(pairs);      // vectors first: a face row with no vector is useless
  await appendFaces(rows);
  return rows;
}

/* Detect, align, store the crop, and embed with whichever embedder is chosen.
   Replaces the old path that embedded a raw box crop. */
async function detectAndEmbed(photoId, bitmap, src){
  if (!FACE_ENGINE) throw new Error("no face detector loaded");
  const W = bitmap.width || 1, H = bitmap.height || 1;
  const facePx = f => Math.max(f.box[2] * W, f.box[3] * H);
  const found = (await FACE_ENGINE(bitmap))
    .filter(f => (f.score || 0) >= S.faces.minScore)
    .filter(f => facePx(f) >= S.faces.minFacePx)
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, S.faces.maxPerPhoto);

  const engine = faceEngineId();
  const rows = [], pairs = [];
  for (const f of found){
    const id = faceIdFor(photoId, f.box);
    if (FACES.faces.has(id)) continue;
    const crop = faceAlignedCrop(bitmap, f.mesh);
    /* No landmarks means no alignment, and an unaligned crop is exactly the
       input that made this useless. Skip rather than store a bad vector. */
    if (!crop) continue;
    let vec;
    if (S.faces.embedder === "faceres") vec = f.vec;
    else vec = await arcEmbedCrop(crop);
    if (!vec || !vec.length) continue;
    try { await saveFaceCrop(id, crop); } catch {}
    rows.push({ id, photo_id: photoId, box: f.box.map(v => +v.toFixed(4)),
                score: +(f.score || 0).toFixed(4), px: Math.round(facePx(f)),
                src: src || "thumb",
                engine, detected_at: new Date().toISOString() });
    pairs.push({ id, vec });
  }
  if (!rows.length) return [];
  await appendFaceVectors(pairs);
  await appendFaces(rows);
  return rows;
}

/* ---- re-measuring one photo at full resolution ----
   A face read from a 384px thumbnail is usually smaller than the 112px the
   model consumes, so it was upscaled and the detail is simply not there. This
   replaces that photo's faces with ones taken from the original.

   The names the user assigned must survive it, so old faces are matched to new
   ones by overlap and every reference is rewritten. Losing someone's naming
   work to a quality improvement would not be a trade worth making. */
function boxIoU(a, b){
  const ax2 = a[0] + a[2], ay2 = a[1] + a[3];
  const bx2 = b[0] + b[2], by2 = b[1] + b[3];
  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const uni = a[2]*a[3] + b[2]*b[3] - inter;
  return uni > 0 ? inter / uni : 0;
}

async function refinePhotoFaces(photoId, bitmap){
  if (FACES.separations.length || FACES.people.some(p => p.confirmed_ids || p.rejected_ids))
    throw new Error("Improving faces with saved corrections needs the staged migration described in the roadmap. Your face data has been kept.");
  const olds = (FACES.byPhoto.get(photoId) || [])
    .map(id => FACES.faces.get(id)).filter(Boolean);
  /* Detect fresh on the full-resolution image. */
  const before = new Set(olds.map(f => f.id));
  for (const f of olds) FACES.faces.delete(f.id);
  FACES.byPhoto.delete(photoId);
  let fresh = [];
  try {
    fresh = await detectAndEmbed(photoId, bitmap, "original");
  } catch (e){
    for (const f of olds){                      // put it back on failure
      FACES.faces.set(f.id, f);
      if (!FACES.byPhoto.has(photoId)) FACES.byPhoto.set(photoId, []);
      FACES.byPhoto.get(photoId).push(f.id);
    }
    throw e;
  }
  /* Carry every name across by overlap, then retire the old rows. */
  let remapped = 0;
  for (const group of [...FACES.people, ...FACES.clusters]){
    for (let i = 0; i < group.face_ids.length; i++){
      const oldId = group.face_ids[i];
      if (!before.has(oldId)) continue;
      const oldFace = olds.find(f => f.id === oldId);
      let best = null, bestIoU = 0.25;
      for (const nf of fresh){
        const v = boxIoU(oldFace.box, nf.box);
        if (v > bestIoU){ bestIoU = v; best = nf; }
      }
      group.face_ids[i] = best ? best.id : null;
      if (best) remapped++;
    }
    group.face_ids = group.face_ids.filter(Boolean);
  }
  const retired = olds.map(f => ({ id:f.id, photo_id:photoId, removed:true }));
  if (retired.length) await appendFaces(retired);
  for (const r of retired) FACES.faces.delete(r.id);
  FACES.people = FACES.people.filter(p => p.face_ids.length);
  FACES.clusters = FACES.clusters.filter(c => c.face_ids.length);
  return { replaced: olds.length, found: fresh.length, remapped };
}


/* ---- re-embedding without touching a photo ----
   The aligned crops are on disk, so changing embedder -- or trying a different
   one to see if it groups better -- costs a pass over a few hundred kilobytes
   instead of 14 GB. This is the whole reason the crops are stored. */
async function reembedFromCrops(onProgress){
  if (S.faces.embedder === "faceres")
    throw new Error("Stored-crop re-measuring supports ArcFace. Select ArcFace first; no face data has been changed.");
  if (S.faces.embedder !== "faceres") await loadArcFace(onProgress);
  const engine = faceEngineId();
  const ids = [...FACES.faces.keys()];
  const pairs = [];
  let missing = 0, done = 0;
  for (const id of ids){
    const crop = await faceCropCanvas(id);
    if (!crop){ missing++; continue; }
    try {
      pairs.push({ id, vec: await arcEmbedCrop(crop) });
    } catch { missing++; }
    if (++done % 50 === 0 && onProgress)
      await onProgress("Re-measuring " + done + " of " + ids.length + " faces…");
  }
  if (!pairs.length)
    throw new Error("no stored face crops to re-measure — run Find faces first");
  if (missing)
    throw new Error(missing + " crops are unavailable. No vectors were replaced; a complete migration from originals is needed.");
  /* Replace rather than append: these are the same faces, measured again. */
  FACES.vec = { dim:0, ids:[], rows:null, index:new Map() };
  await appendFaceVectors(pairs);
  for (const id of FACES.vec.ids){
    const f = FACES.faces.get(id);
    if (f) f.engine = engine;
  }
  await appendFaces([...FACES.faces.values()]);
  clusterFaces();
  await savePeople();
  return { measured: pairs.length, missing };
}

/* ---- settling it on real faces ----
   A synthetic benchmark can prove alignment works, because that is geometry.
   It CANNOT rank recognition models: two drawn faces look identical to one and
   it scores them 0.77. The only valid labels available are the groups the user
   has named, so use those: for each embedder, how alike are two faces of the
   same person, and how alike are faces of different people. */
async function compareEmbedders(onProgress){
  const say = async m => { if (onProgress) await onProgress(m); };
  const named = FACES.people.filter(p => p.name && p.face_ids.length >= 2);
  if (named.length < 2)
    throw new Error("name at least two groups first — with two or more faces each. "
      + "Those names are the only ground truth available, and without them there is "
      + "nothing to measure against.");

  await say("Loading the recognition model…");
  await loadArcFace(async m => await say(m));

  const byPerson = new Map();
  let crops = 0, gone = 0;
  for (const person of named){
    const rows = [];
    for (const fid of person.face_ids.slice(0, 40)){
      const crop = await faceCropCanvas(fid);
      if (!crop){ gone++; continue; }
      const arc = await arcEmbedCrop(crop);
      const old = faceVectorOf(fid);
      rows.push({ arc, old: old ? Float32Array.from(old) : null });
      if (++crops % 25 === 0) await say("Measured " + crops + " faces…");
    }
    if (rows.length >= 2) byPerson.set(person.name, rows);
  }
  if (byPerson.size < 2)
    throw new Error("not enough stored crops to compare (" + gone + " missing). "
      + "Run Find faces again so the crops are written.");

  const cos = (a, b) => {
    let d = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++){ d += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
    return d / (Math.sqrt(na) * Math.sqrt(nb) || 1);
  };
  const score = key => {
    const self = [], cross = [];
    const names = [...byPerson.keys()];
    for (const n of names){
      const rows = byPerson.get(n).filter(r => r[key]);
      for (let i = 0; i < rows.length; i++)
        for (let j = i + 1; j < rows.length; j++) self.push(cos(rows[i][key], rows[j][key]));
    }
    for (let a = 0; a < names.length; a++)
      for (let b = a + 1; b < names.length; b++){
        const A = byPerson.get(names[a]).filter(r => r[key]);
        const B = byPerson.get(names[b]).filter(r => r[key]);
        for (const x of A) for (const y of B) cross.push(cos(x[key], y[key]));
      }
    if (!self.length || !cross.length) return null;
    const mean = v => v.reduce((p, q) => p + q, 0) / v.length;
    const s = mean(self), c = mean(cross);
    /* A threshold between the two means, biased towards not merging people. */
    const suggest = c + (s - c) * 0.45;
    return { samePerson: +s.toFixed(3), differentPeople: +c.toFixed(3),
             separability: +(s - c).toFixed(3),
             suggestedThreshold: +suggest.toFixed(2),
             pairs: self.length + " same, " + cross.length + " different" };
  };
  return { people: byPerson.size, faces: crops, missingCrops: gone,
           arcface: score("arc"), current: score("old") };
}


/* How big the faces in this library actually are. ArcFace consumes 112x112, so
   anything below that was upscaled and is costing accuracy -- this says how
   much of the library is in that position, from the real stored sizes. */
function faceSizeReport(){
  const px = [...FACES.faces.values()].map(f => f.px || 0).filter(v => v > 0).sort((a,b) => a-b);
  if (!px.length) return null;
  const at = q => px[Math.min(px.length-1, Math.floor(px.length*q))];
  const below = px.filter(v => v < ARC_SIZE).length;
  const fromThumb = [...FACES.faces.values()].filter(f => f.src !== "original").length;
  return { faces: px.length, median: at(0.5), p10: at(0.1), p90: at(0.9),
           belowModelInput: below,
           belowPct: Math.round(below / px.length * 100),
           fromThumbnails: fromThumb };
}
