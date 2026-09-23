
/* ================= index store (.photoindex/) ================= */
const IDX = {
  dir:null, thumbs:null,
  records:new Map(),          // light records only: raw JSON + embeddings live on disk
  vec:{ dim:0, ids:[], rows:null, index:new Map() },
  loaded:false, checkpoint:null
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
function exclusive(fn){
  const run = ioChain.then(fn, fn);
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
async function ensureIndex(){
  const parent = await indexParent();
  IDX.dir = await parent.getDirectoryHandle(".photoindex", { create:true });
  IDX.thumbs = await IDX.dir.getDirectoryHandle("thumbs", { create:true });
  const cfg = await IDX.dir.getFileHandle("config.json", { create:true });
  const f = await cfg.getFile();
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
  conf.updated_at = new Date().toISOString();
  await writeFile(cfg, JSON.stringify(conf, null, 2));
  return IDX.dir;
}

/* records.jsonl is append-only; the last line for an id wins. */
async function appendLines(name, lines){
  if (!lines.length) return;
  return exclusive(async () => {
    const fh = await IDX.dir.getFileHandle(name, { create:true });
    const size = (await fh.getFile()).size;
    const w = await fh.createWritable({ keepExistingData:true });
    await w.seek(size);
    await w.write(lines.map(o => JSON.stringify(o)).join("\n") + "\n");
    await w.close();
  });
}
async function loadRecords(onProgress){
  IDX.records = new Map();
  let fh;
  try { fh = await IDX.dir.getFileHandle("records.jsonl"); }
  catch { IDX.loaded = true; return 0; }
  const file = await fh.getFile();
  const total = file.size || 1;
  const rd = file.stream().pipeThrough(new TextDecoderStream()).getReader();
  let buf = "", read = 0, lines = 0, bad = 0;
  const take = ln => {
    if (!ln.trim()) return;
    lines++;
    try { const r = JSON.parse(ln); if (r && r.id) IDX.records.set(r.id, lighten(r)); }
    catch { bad++; }
  };
  for(;;){
    const { value, done } = await rd.read();
    if (done) break;
    read += value.length; buf += value;
    const parts = buf.split("\n"); buf = parts.pop();
    for (const ln of parts) take(ln);
    if (onProgress) onProgress(Math.min(99, Math.round(read/total*100)), IDX.records.size);
  }
  take(buf);
  IDX.loaded = true;
  if (onProgress) onProgress(100, IDX.records.size);
  if (bad) console.warn("records.jsonl: " + bad + " unparseable lines skipped");
  return lines;
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
  const fh = await IDX.dir.getFileHandle("records.jsonl", { create:true });
  await writeFile(fh, keep.map(o => JSON.stringify(o)).join("\n") + (keep.length ? "\n" : ""));
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
  const rows = new Float32Array(buf);
  const expect = meta.dim * meta.ids.length;
  if (rows.length < expect){
    console.warn("vectors.bin truncated; ignoring the tail");
    meta.ids = meta.ids.slice(0, Math.floor(rows.length / meta.dim));
  }
  IDX.vec.dim = meta.dim; IDX.vec.ids = meta.ids; IDX.vec.rows = rows;
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
      next.set(p.vec, old.length + i * dim);
      IDX.vec.index.set(p.id, IDX.vec.ids.length);
      IDX.vec.ids.push(p.id);
    });
    IDX.vec.rows = next;
  }
  IDX.vec.dim = dim;
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
async function saveThumb(id, blob){
  const fh = await IDX.thumbs.getFileHandle(id + ".jpg", { create:true });
  await writeBinary(fh, blob);
}
const thumbCache = new Map();
async function thumbUrl(id){
  if (thumbCache.has(id)) return thumbCache.get(id);
  try {
    const fh = await IDX.thumbs.getFileHandle(id + ".jpg");
    const u = URL.createObjectURL(await fh.getFile());
    if (thumbCache.size > 400){          // bound the cache so long sessions do not leak
      const [k, v] = thumbCache.entries().next().value;
      URL.revokeObjectURL(v); thumbCache.delete(k);
    }
    thumbCache.set(id, u);
    return u;
  } catch { return null; }
}

/* ---- resume checkpoint ----
   Written on every batch flush, so an interrupted scan restarts from the exact
   remaining queue instead of re-walking or re-scanning what is already done. */
async function saveCheckpoint(cp){
  IDX.checkpoint = cp;
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
