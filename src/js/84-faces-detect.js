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
