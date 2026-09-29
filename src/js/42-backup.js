
/* ================= index backups =================
   What is worth copying is what cost model time: records.jsonl holds every
   extraction, vectors.bin every embedding. Thumbnails are deliberately NOT
   backed up — they are the bulk of the index and can be rebuilt by re-decoding
   the originals, which costs no model calls at all. */
const BACKUP_FILES = ["records.jsonl", "vectors.bin", "vectors.json", "config.json"];

async function backupsDir(){
  return IDX.dir.getDirectoryHandle("backups", { create:true });
}

/* Every await here can stall on a network share. Without a deadline the UI sits
   on one label forever with no way to tell which step is stuck. */
async function withDeadline(label, ms, promise){
  let timer;
  const bomb = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(label + " did not finish within "
      + Math.round(ms / 1000) + "s — the share may be slow or asleep")), ms);
  });
  try { return await Promise.race([promise, bomb]); }
  finally { clearTimeout(timer); }
}

/* An interrupted createWritable leaves a .crswap file behind. They are dead
   weight and can confuse a later write to the same name. */
async function sweepSwapFiles(dir){
  const stale = [];
  try {
    for await (const [name, h] of dir.entries())
      if (h.kind === "file" && name.endsWith(".crswap")) stale.push(name);
    for (const n of stale) { try { await dir.removeEntry(n); } catch {} }
  } catch {}
  return stale.length;
}

/* Copies a file without loading it into memory: a File is a Blob, and the
   writable stream accepts one directly. */
const COPY_CHUNK = 4 * 1024 * 1024;

async function copyInto(srcDir, destDir, name, onProgress){
  let src;
  try { src = await (await srcDir.getFileHandle(name)).getFile(); }
  catch { return null; }                       // absent is fine (no vectors yet)
  const fh = await destDir.getFileHandle(name, { create:true });
  const w = await fh.createWritable();
  try {
    /* Write in chunks rather than handing over the whole blob: on a share that
       moves ~430 KB/s a 29 MB file takes over a minute, and silence for a
       minute is indistinguishable from a hang. */
    let off = 0;
    if (src.size === 0) await w.write(src);
    while (off < src.size){
      const end = Math.min(off + COPY_CHUNK, src.size);
      await w.write({ type:"write", position: off, data: src.slice(off, end) });
      off = end;
      if (onProgress) await onProgress(name, off, src.size);
    }
    await w.close();
  } catch (e){
    /* abort() discards; close() would COMMIT a half-written file. A truncated
       records.jsonl that looks valid is worse than no backup at all. */
    try { await w.abort(); } catch {}
    try { await destDir.removeEntry(name); } catch {}
    throw e;
  }
  const written = (await fh.getFile()).size;
  return { name, bytes: src.size, ok: written === src.size };
}

/* A sleeping NAS takes ~24 seconds to answer its first request and well under a
   second afterwards. Wake it deliberately so that cost lands on a step that
   says what it is doing, instead of ambushing whatever runs first. */
async function wakeStorage(onProgress){
  const t0 = performance.now();
  try { await IDX.dir.getFileHandle("config.json"); } catch {}
  const ms = performance.now() - t0;
  if (ms > 3000 && onProgress)
    await onProgress("Drive was asleep — took " + (ms/1000).toFixed(0) + "s to wake");
  return ms;
}

async function listBackups(){
  const out = [];
  try {
    const dir = await backupsDir();
    for await (const [name, h] of dir.entries()){
      if (h.kind !== "directory") continue;
      let meta = null, bytes = 0;
      try {
        meta = JSON.parse(await (await (await h.getFileHandle("manifest.json")).getFile()).text());
      } catch {}
      for await (const [, fh] of h.entries()){
        try { bytes += (await fh.getFile()).size; } catch {}
      }
      out.push({ name, meta, bytes, handle:h });
    }
  } catch {}
  return out.sort((a, b) => b.name.localeCompare(a.name));   // newest first
}

async function pruneBackups(keep){
  const all = await listBackups();
  const dir = await backupsDir();
  let removed = 0;
  for (const b of all.slice(Math.max(1, keep))){
    try { await dir.removeEntry(b.name, { recursive:true }); removed++; } catch {}
  }
  return removed;
}

/* A backup is only useful if it is intact, so verify before trusting it:
   every line of records.jsonl must parse and carry an id. */
async function verifyRecordsFile(fileHandle){
  const text = await (await fileHandle.getFile()).text();
  let lines = 0, bad = 0, ids = new Set();
  for (const ln of text.split("\n")){
    if (!ln.trim()) continue;
    lines++;
    try {
      const r = JSON.parse(ln);
      if (r && r.id) ids.add(r.id); else bad++;
    } catch { bad++; }
  }
  return { lines, bad, unique: ids.size };
}

async function backupIndex(reason, onProgress){
  const say = async m => { if (onProgress) await onProgress(m); };
  /* Deadlines are generous because the storage may legitimately be slow: a
     sleeping share needs ~24s just to answer, and copies run at a few hundred
     KB/s. They exist to turn a hang into a message, not to police speed. */
  await say("Opening the index…");
  let lastPhase = "opening the index";
  await withDeadline("opening the index", 120000,
    ensureIndex(async m => { lastPhase = m; await say(m); }, { write:false }))
    .catch(e => { throw new Error(errText(e) + "  [stuck at: " + lastPhase + "]"); });
  await say("Waking the drive…");
  await wakeStorage(say);
  await say("Opening backups/…");
  const dir = await withDeadline("opening backups/", 120000, backupsDir());
  await sweepSwapFiles(dir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await say("Creating " + stamp + "…");
  const dest = await withDeadline("creating the backup folder", 120000,
    dir.getDirectoryHandle(stamp, { create:true }));

  const copied = [];
  let doneBytes = 0, totalBytes = 0;
  for (const name of BACKUP_FILES){
    try { totalBytes += (await (await IDX.dir.getFileHandle(name)).getFile()).size; }
    catch {}
  }
  const started = performance.now();
  for (const name of BACKUP_FILES){
    const before = doneBytes;
    const r = await withDeadline("copying " + name, 1800000,
      copyInto(IDX.dir, dest, name, async (n, got, size) => {
        doneBytes = before + got;
        const pct = totalBytes ? Math.round(doneBytes / totalBytes * 100) : 0;
        const secs = (performance.now() - started) / 1000;
        const rate = doneBytes / Math.max(1, secs) / 1024;
        const left = rate > 0 ? (totalBytes - doneBytes) / 1024 / rate : 0;
        await say("Copying " + n + " — " + pct + "% of "
          + (totalBytes/1048576).toFixed(0) + " MB, "
          + Math.round(rate) + " KB/s, about " + fmtDur(left) + " left");
      }));
    if (r){ copied.push(r); doneBytes = before + r.bytes; }
  }
  await say("Verifying…");
  let check = null;
  try { check = await verifyRecordsFile(await dest.getFileHandle("records.jsonl")); }
  catch {}
  const manifest = {
    created_at: new Date().toISOString(),
    reason: reason || "manual",
    files: copied,
    records: check,
    photo_root: (S.dirHandle && S.dirHandle.name) || null,
    schema_hash: SCHEMA_HASH(), prompt_hash: PROMPT_HASH(),
    template_version: TPL.version
  };
  await writeFile(await dest.getFileHandle("manifest.json", { create:true }),
    JSON.stringify(manifest, null, 2));
  const bad = copied.filter(c => !c.ok).map(c => c.name);
  if (bad.length) throw new Error("backup incomplete: " + bad.join(", "));
  const pruned = await pruneBackups(S.backup.keep);
  return { stamp, manifest, pruned,
    bytes: copied.reduce((a, c) => a + c.bytes, 0) };
}

/* ---- relocating the index ----
   The index belongs on fast local storage even when the photos do not. These
   five files are the whole library; thumbnails are excluded because there are
   thousands of them and per-file latency on a slow share makes copying them
   take hours. They can be rebuilt from the originals without any model calls. */
const CORE_FILES = ["records.jsonl", "vectors.bin", "vectors.json", "config.json",
                    "runs.jsonl", "state.json"];

async function moveIndexTo(destParent, onProgress){
  const say = async m => { if (onProgress) await onProgress(m); };
  await say("Opening the current index…");
  await ensureIndex(null, { write:false });
  const from = IDX.dir;
  await say("Creating .photoindex in the new location…");
  const to = await destParent.getDirectoryHandle(".photoindex", { create:true });
  const moved = [];
  for (const name of CORE_FILES){
    let hint = "";
    try {
      const f = await (await from.getFileHandle(name)).getFile();
      hint = " (" + (f.size / 1048576).toFixed(1) + " MB)";
    } catch { continue; }                       // not every file always exists
    await say("Copying " + name + hint + "…");
    const r = await withDeadline("copying " + name, 900000, copyInto(from, to, name));
    if (r) moved.push(r);
  }
  // the cached place-name data is small and tedious to re-fetch
  try {
    const gFrom = await from.getDirectoryHandle("geo");
    const gTo = await to.getDirectoryHandle("geo", { create:true });
    for (const n of ["cities.bin", "names.txt", "meta.json"]){
      await say("Copying geo/" + n + "…");
      await copyInto(gFrom, gTo, n);
    }
  } catch {}
  await say("Switching over…");
  S.indexMode = "custom";
  S.indexDirHandle = destParent;
  try { await idbSet("lastIndexDir", destParent); } catch {}
  saveSettings();
  IDX.lastConfig = null;
  IDX.loaded = false;
  await ensureIndex();
  await loadRecords();
  await loadVectors();
  await loadCheckpoint();
  rebuildDerived();
  return { files: moved, records: IDX.records.size, vectors: IDX.vec.ids.length,
           bytes: moved.reduce((a, f) => a + f.bytes, 0) };
}

/* Restoring overwrites the live index, so take a safety copy of the CURRENT
   state first — otherwise a mistaken restore is unrecoverable. */
async function restoreBackup(name, onProgress){
  await ensureIndex(null, { write:false });
  const dir = await backupsDir();
  const src = await dir.getDirectoryHandle(name);
  if (onProgress) await onProgress("Saving the current index first…");
  await backupIndex("pre-restore safety copy", onProgress);
  for (const f of BACKUP_FILES){
    if (onProgress) await onProgress("Restoring " + f + "…");
    await copyInto(src, IDX.dir, f);
  }
  IDX.loaded = false;
  await loadRecords();
  await loadVectors();
  rebuildDerived();
  return { records: IDX.records.size, vectors: IDX.vec.ids.length };
}
