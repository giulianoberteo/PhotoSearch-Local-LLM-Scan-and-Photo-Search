
/* ================= index store (.photoindex/) ================= */
const IDX = {
  dir:null, thumbs:null,
  records:new Map(),          // light records only: raw JSON + embeddings live on disk
  vec:{ dim:0, ids:[], rows:null, index:new Map() },
  loaded:false, checkpoint:null, lastConfig:null
};
/* Heavy fields are stripped before a record enters memory, so a 50k-photo
   library costs kilobytes per record rather than tens of kilobytes. */
const HEAVY = ["raw_model_json","embedding"];
function lighten(rec){
  const r = { ...rec };
  for (const k of HEAVY) delete r[k];
  return r;
}

/* All index writes go through one queue: appendLines reads the file size and
   then seeks to it, so two concurrent appends would target the same offset. */
let ioChain = Promise.resolve();
/* A stalled write must not wedge the queue permanently. Without a bound, one
   hung SMB operation blocks every later append forever while the UI still
   reports progress. */
const IO_TIMEOUT_MS = 180000;
function exclusive(fn){
  const guarded = async () => {
    let timer;
    try {
      return await Promise.race([
        fn(),
        new Promise((_, rej) => { timer = setTimeout(
          () => rej(new Error("index write did not complete within "
            + (IO_TIMEOUT_MS / 1000) + "s")), IO_TIMEOUT_MS); })
      ]);
    } finally { clearTimeout(timer); }
  };
  const run = ioChain.then(guarded, guarded);
  ioChain = run.then(() => {}, () => {});
  return run;
}

async function writeFile(handle, text){
  const w = await handle.createWritable();
  await w.write(text); await w.close();
}
async function writeBinary(handle, buf){
  const w = await handle.createWritable();
  await w.write(buf); await w.close();
}
async function readTextIfAny(dir, name){
  try { return await (await (await dir.getFileHandle(name)).getFile()).text(); }
  catch { return null; }
}

/* The index is a .photoindex folder either beside the photos or inside a
   separate folder the user picked. One index folder describes one library. */
async function indexParent(){
  if (S.indexMode === "custom"){
    if (!S.indexDirHandle) throw new Error("No index folder chosen. Pick one in Settings.");
    return S.indexDirHandle;
  }
  if (!S.dirHandle) throw new Error("No photo folder selected");
  return S.dirHandle;
}
async function ensureIndex(onPhase, opts){
  /* opts.write === false: open the handles and read config, but never write.
     Backups and plans do not need config.json refreshed, and on a slow or
     flaky share that write is the single most likely thing to stall. */
  opts = opts || {};
  const say = async m => { if (onPhase) await onPhase(m); };
  const parent = await indexParent();
  await say("Opening .photoindex/…");
  /* Time it: this is a real round trip to the storage the index lives on, and
     every deadline in the app is sized from what it costs. Measuring work that
     has to happen anyway keeps the probe free. */
  const tOpen = performance.now();
  IDX.dir = await parent.getDirectoryHandle(".photoindex", { create:true });
  noteStorageTiming("openMs", performance.now() - tOpen);
  IDX.thumbs = null;
  /* thumbs/ is NOT opened here. It holds one file per photo -- 6,568 of them on
     a real library -- and enumerating it over a network share measured 60
     seconds. Nothing at startup needs it, so it is opened on first use. */
  await say("Reading config.json…");
  /* create:true would leave a 0-byte config.json behind on a read-only open,
     which then gets backed up as valid and can overwrite a good one on restore. */
  let cfg = null;
  try { cfg = await IDX.dir.getFileHandle("config.json", { create: opts.write !== false }); }
  catch { if (opts.write !== false) throw new Error("could not open config.json"); }
  if (!cfg){ IDX.configPending = true; return IDX.dir; }
  const tRead = performance.now();
  const f = await cfg.getFile();
  noteStorageTiming("readMs", performance.now() - tRead);
  let conf = {};
  if (f.size){ try { conf = JSON.parse(await f.text()); } catch {} }
  conf.app = "PhotoSearch";
  conf.index_version = 2;
  conf.template_version = TPL.version;
  conf.schema_hash = SCHEMA_HASH();
  conf.prompt_hash = PROMPT_HASH();
  conf.schema = TPL.schema;
  conf.settings = { occasions: S.date.occasions, hemisphere: S.date.hemisphere,
                    event_gap_hours: S.events.gapHours, event_km: S.events.km };
  /* Record which library this index describes, so pointing it at the wrong
     folder is caught rather than silently producing thousands of "new" files. */
  if (S.dirHandle){
    if (conf.photo_root && conf.photo_root !== S.dirHandle.name)
      IDX.rootMismatch = { was: conf.photo_root, now: S.dirHandle.name };
    else IDX.rootMismatch = null;
    conf.photo_root = S.dirHandle.name;
  }
  conf.index_mode = S.indexMode;
  /* Writing config.json is not free: on a slow share a tiny write measured 24
     seconds. It changes only when settings or the schema change, so compare
     before writing and skip the round trip otherwise. */
  const next = JSON.stringify({ ...conf, updated_at:undefined }, null, 2);
  if (opts.write === false){
    IDX.configPending = next !== IDX.lastConfig;
    return IDX.dir;
  }
  if (next !== IDX.lastConfig){
    await say("Writing config.json…");
    conf.updated_at = new Date().toISOString();
    try {
      await writeFile(cfg, JSON.stringify(conf, null, 2));
      IDX.lastConfig = next;
    } catch (e){
      /* Housekeeping, not data. A backup exists to copy records OFF this share;
         refusing to run because a settings file could not be rewritten would be
         exactly backwards. */
      IDX.configWriteError = errText(e);
      await say("config.json could not be written (" + IDX.configWriteError
        + ") — continuing");
    }
  }
  return IDX.dir;
}

/* records.jsonl is append-only; the last line for an id wins. */
async function appendLines(name, lines){
  if (!lines.length) return;
  return exclusive(async () => {
    const fh = await IDX.dir.getFileHandle(name, { create:true });
    const size = (await fh.getFile()).size;
    const text = lines.map(o => JSON.stringify(o)).join("\n") + "\n";
    const w = await fh.createWritable({ keepExistingData:true });
    await w.seek(size);
    await w.write(text);
    await w.close();
    /* close() resolving is not proof the bytes landed: on a share that drops
       mid-write the file can come back short, and the caller would carry on
       believing those records are safe -- then clear them from memory. Confirm
       the length before reporting success, the same way appendVectors does. */
    const after = (await fh.getFile()).size;
    const want = size + new Blob([text]).size;
    if (after !== want)
      throw new Error(name + " is " + after + " bytes after appending "
        + lines.length + " records, expected " + want
        + " — the write did not land in full");
    return { added: lines.length, bytes: after - size };
  });
}
async function loadRecords(onProgress){
  /* Build into a scratch map: a read that fails half way used to leave
     IDX.records holding a PREFIX of the library, which buildPlan then read as
     "the rest of these photos are new" -- a full re-scan of paid-for work. */
  const built = new Map();
  let fh;
  try { fh = await IDX.dir.getFileHandle("records.jsonl"); }
  catch {
    /* No log here means this index is EMPTY, not "keep whatever was loaded
       before". Switching index location used to leave the previous location's
       records in memory, so the new index planned against photos it had never
       seen -- and the next flush wrote those foreign records INTO it. */
    IDX.records = new Map();
    IDX.loaded = true;
    return 0;
  }
  const file = await fh.getFile();
  const total = file.size || 1;
  const rd = file.stream().pipeThrough(new TextDecoderStream()).getReader();
  let buf = "", read = 0, lines = 0, bad = 0;
  IDX.loaded = false;
  const take = ln => {
    if (!ln.trim()) return;
    lines++;
    try { const r = JSON.parse(ln); if (r && r.id) built.set(r.id, lighten(r)); }
    catch { bad++; }
  };
  for(;;){
    const { value, done } = await rd.read();
    if (done) break;
    read += value.length; buf += value;
    const parts = buf.split("\n"); buf = parts.pop();
    for (const ln of parts) take(ln);
    if (onProgress) onProgress(Math.min(99, Math.round(read/total*100)), built.size);
  }
  take(buf);
  IDX.records = built;                 // swap in only on a complete read
  IDX.loaded = true;
  if (onProgress) onProgress(100, IDX.records.size);
  if (bad) console.warn("records.jsonl: " + bad + " unparseable lines skipped");
  return lines;
}
/* Reads many full records in ONE pass. Anything that rewrites records must use
   this, never the lightened in-memory copies. */
async function readFullRecords(ids){
  const out = new Map();
  let fh;
  try { fh = await IDX.dir.getFileHandle("records.jsonl"); } catch { return out; }
  const text = await (await fh.getFile()).text();
  for (const ln of text.split("\n")){
    if (!ln.trim()) continue;
    try {
      const r = JSON.parse(ln);
      if (r && ids.has(r.id)) out.set(r.id, r);     // later lines win
    } catch {}
  }
  return out;
}

/* Reads one full record (including raw model JSON) straight from disk. */
async function readFullRecord(id){
  let fh;
  try { fh = await IDX.dir.getFileHandle("records.jsonl"); } catch { return null; }
  const text = await (await fh.getFile()).text();
  let found = null;
  for (const ln of text.split("\n")){
    if (!ln.trim() || ln.indexOf(id) < 0) continue;
    try { const r = JSON.parse(ln); if (r.id === id) found = r; } catch {}
  }
  return found;
}
/* Rewrites records.jsonl to latest-state-only and drops soft-deleted rows. */
async function compactRecords(){
  /* The only operation that REWRITES records.jsonl rather than appending, so:
     never while a scan is flushing, never outside the write mutex, and never
     without a copy first. */
  if (typeof RUN !== "undefined" && RUN.active)
    throw new Error("A scan is running. Compacting now would rewrite the log a "
      + "flush is appending to. Stop the scan first.");
  const text0 = await readTextIfAny(IDX.dir, "records.jsonl");
  if (text0 == null) return { before:0, after:0 };
  /* Guard on the FILE, not the in-memory count: if loadRecords never ran,
     IDX.records.size is 0 and the old check skipped the safety copy entirely
     while still rewriting the file. */
  if (typeof backupIndex === "function" && text0.trim())
    await backupIndex("pre-compaction safety copy");
  const text = await readTextIfAny(IDX.dir, "records.jsonl");
  if (text == null) return { before:0, after:0 };
  const latest = new Map();
  let before = 0;
  for (const ln of text.split("\n")){
    if (!ln.trim()) continue;
    before++;
    try { const r = JSON.parse(ln); if (r && r.id) latest.set(r.id, r); } catch {}
  }
  const keep = [...latest.values()].filter(r => !r.deleted);
  await exclusive(async () => {
    const fh = await IDX.dir.getFileHandle("records.jsonl", { create:true });
    await writeFile(fh, keep.map(o => JSON.stringify(o)).join("\n") + (keep.length ? "\n" : ""));
  });
  IDX.records = new Map(keep.map(r => [r.id, lighten(r)]));
  return { before, after: keep.length };
}

/* ---- vectors.bin: Float32 rows + a parallel id list ---- */
async function loadVectors(){
  IDX.vec = { dim:0, ids:[], rows:null, index:new Map() };
  const metaText = await readTextIfAny(IDX.dir, "vectors.json");
  if (!metaText) return 0;
  let meta;
  try { meta = JSON.parse(metaText); } catch { return 0; }
  if (!meta.dim || !Array.isArray(meta.ids)) return 0;
  let buf;
  try { buf = await (await (await IDX.dir.getFileHandle("vectors.bin")).getFile()).arrayBuffer(); }
  catch { return 0; }
  /* The row count on disk is the truth; the id list must be made to agree with
     it in BOTH directions. Only the short case used to be handled, and a longer
     bin (the normal result of dying between the two writes) then desynchronised
     every subsequent vector: fresh rows are placed by buffer length but indexed
     by ids.length, so each new photo would map to another photo's embedding. */
  if (buf.byteLength % 4 !== 0){
    console.warn("vectors.bin has a torn final row; discarding it");
    buf = buf.slice(0, buf.byteLength - (buf.byteLength % 4));
  }
  let rows = new Float32Array(buf);
  const rowsOnDisk = Math.floor(rows.length / meta.dim);
  if (rows.length % meta.dim !== 0) rows = rows.subarray(0, rowsOnDisk * meta.dim);
  if (rowsOnDisk !== meta.ids.length){
    console.warn("vectors: " + rowsOnDisk + " rows on disk vs " + meta.ids.length
      + " ids; realigning to the shorter of the two");
    IDX.vecRealigned = { rows: rowsOnDisk, ids: meta.ids.length };
    const keep = Math.min(rowsOnDisk, meta.ids.length);
    meta.ids = meta.ids.slice(0, keep);
    rows = rows.subarray(0, keep * meta.dim);
  }
  IDX.vec.dim = meta.dim; IDX.vec.ids = meta.ids;
  /* Copy out of the subarray so later appends grow a buffer we own. */
  IDX.vec.rows = rows.length === new Float32Array(buf).length ? rows : new Float32Array(rows);
  IDX.vec.model = meta.model || null;
  meta.ids.forEach((id, i) => IDX.vec.index.set(id, i));
  return meta.ids.length;
}
/* Appends new vectors; ids already present are rewritten in place. */
async function appendVectors(pairs){
  if (!pairs.length) return;
  const dim = pairs[0].vec.length;
  if (IDX.vec.dim && IDX.vec.dim !== dim)
    throw new Error("embedding dim changed (" + IDX.vec.dim + " -> " + dim + "); run Re-embed only");
  const fresh = [], updates = [];
  for (const p of pairs)
    (IDX.vec.index.has(p.id) ? updates : fresh).push(p);

  if (IDX.vec.rows && updates.length)
    for (const u of updates)
      IDX.vec.rows.set(u.vec, IDX.vec.index.get(u.id) * dim);

  if (fresh.length){
    const old = IDX.vec.rows || new Float32Array(0);
    const next = new Float32Array(old.length + fresh.length * dim);
    next.set(old, 0);
    fresh.forEach((p, i) => {
      /* Place by the LOGICAL row (ids.length), not by buffer length. If the two
         ever disagree the physical and logical rows must not drift further. */
      const row = IDX.vec.ids.length;
      next.set(p.vec, row * dim);
      IDX.vec.index.set(p.id, row);
      IDX.vec.ids.push(p.id);
    });
    IDX.vec.rows = next;
  }
  IDX.vec.dim = dim;
  if (IDX.vec.rows.length !== IDX.vec.ids.length * dim)
    throw new Error("vector index is inconsistent ("
      + (IDX.vec.rows.length / dim) + " rows vs " + IDX.vec.ids.length
      + " ids); reload the index before scanning further");
  await exclusive(async () => {
    const vfh = await IDX.dir.getFileHandle("vectors.bin", { create:true });
    const onDisk = (await vfh.getFile()).size;
    const wanted = IDX.vec.ids.length * dim * 4;
    if (onDisk > wanted || updates.length){
      // A rewritten row or a shrunk file needs the whole thing rewritten.
      const w = await vfh.createWritable();
      await w.write(IDX.vec.rows.buffer); await w.close();
    } else if (fresh.length){
      // The common case: only the new rows are written, at the end.
      const w = await vfh.createWritable({ keepExistingData:true });
      await w.seek(onDisk);
      await w.write(IDX.vec.rows.buffer.slice(onDisk, wanted));
      await w.close();
    }
    /* Confirm the bin really reached the expected length before recording the
       ids that describe it, so the manifest is never ahead of the data. */
    const finalSize = (await vfh.getFile()).size;
    if (finalSize !== wanted)
      throw new Error("vectors.bin is " + finalSize + " bytes, expected " + wanted
        + " — not recording ids that the file does not contain");
    const jf = await IDX.dir.getFileHandle("vectors.json", { create:true });
    const jw = await jf.createWritable();
    await jw.write(JSON.stringify({ dim, model:S.roles.embed, ids:IDX.vec.ids }));
    await jw.close();
  });
}
function vectorOf(id){
  const i = IDX.vec.index.get(id);
  if (i == null || !IDX.vec.rows) return null;
  return IDX.vec.rows.subarray(i * IDX.vec.dim, (i + 1) * IDX.vec.dim);
}

/* ---- thumbnails ---- */
/* Opened lazily: see ensureIndex. Cached for the life of the index handle. */
async function thumbsDir(){
  if (!IDX.thumbs) IDX.thumbs = await IDX.dir.getDirectoryHandle("thumbs", { create:true });
  return IDX.thumbs;
}
async function saveThumb(id, blob){
  const dir = await thumbsDir();
  const fh = await dir.getFileHandle(id + ".jpg", { create:true });
  await writeBinary(fh, blob);
}
const thumbCache = new Map();
/* Object URLs were evicted while <img> elements in earlier chat bubbles still
   pointed at them, turning older grids into broken images. Pinned ids are kept. */
const thumbPinned = new Set();
function thumbPin(id){ thumbPinned.add(id); }
async function thumbUrl(id){
  if (thumbCache.has(id)) return thumbCache.get(id);
  try {
    const dir = await thumbsDir();
    const fh = await dir.getFileHandle(id + ".jpg");
    const u = URL.createObjectURL(await fh.getFile());
    if (thumbCache.size > 400){          // bound the cache so long sessions do not leak
      for (const [k, v] of thumbCache){
        if (thumbPinned.has(k)) continue;          // still on screen
        URL.revokeObjectURL(v); thumbCache.delete(k);
        break;
      }
    }
    thumbCache.set(id, u);
    return u;
  } catch { return null; }
}

/* ---- resume checkpoint ----
   Written on every batch flush, so an interrupted scan restarts from the exact
   remaining queue instead of re-walking or re-scanning what is already done. */
let lastCheckpointAt = 0;
async function saveCheckpoint(cp, force){
  IDX.checkpoint = cp;
  /* This was O(remaining) per batch -- at 50k photos, roughly 3GB of writes
     over the run, and the most frequent write in the system. The plan finds
     anything unflushed anyway, so the checkpoint is an optimisation: writing it
     every 30 seconds is ample. */
  const now = Date.now();
  if (!force && now - lastCheckpointAt < 30000) return;
  lastCheckpointAt = now;
  await writeFile(await IDX.dir.getFileHandle("state.json", { create:true }),
    JSON.stringify(cp));
}
async function loadCheckpoint(){
  const t = await readTextIfAny(IDX.dir, "state.json");
  if (!t) { IDX.checkpoint = null; return null; }
  try { IDX.checkpoint = JSON.parse(t); } catch { IDX.checkpoint = null; }
  if (IDX.checkpoint && !(IDX.checkpoint.pending || []).length) IDX.checkpoint = null;
  return IDX.checkpoint;
}
async function clearCheckpoint(){
  IDX.checkpoint = null;
  try { await writeFile(await IDX.dir.getFileHandle("state.json", { create:true }),
    JSON.stringify({ pending:[], finished_at:new Date().toISOString() })); } catch {}
}
