
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

