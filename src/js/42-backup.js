
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
async function copyInto(srcDir, destDir, name){
  let src;
  try { src = await (await srcDir.getFileHandle(name)).getFile(); }
  catch { return null; }                       // absent is fine (no vectors yet)
  const fh = await destDir.getFileHandle(name, { create:true });
  const w = await fh.createWritable();
  await w.write(src);
  await w.close();
  const written = (await fh.getFile()).size;
  return { name, bytes: src.size, ok: written === src.size };
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
  await say("Opening the index…");
  await withDeadline("opening the index", 30000, ensureIndex());
  await say("Opening backups/…");
  const dir = await withDeadline("opening backups/", 30000, backupsDir());
  await sweepSwapFiles(dir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await say("Creating " + stamp + "…");
  const dest = await withDeadline("creating the backup folder", 30000,
    dir.getDirectoryHandle(stamp, { create:true }));
  const copied = [];
  for (const name of BACKUP_FILES){
    let sizeHint = "";
    try {
      const f = await (await IDX.dir.getFileHandle(name)).getFile();
      sizeHint = " (" + (f.size / 1048576).toFixed(1) + " MB)";
    } catch {}
    await say("Copying " + name + sizeHint + "…");
    const r = await withDeadline("copying " + name, 600000,
      copyInto(IDX.dir, dest, name));
    if (r) copied.push(r);
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
  await ensureIndex();
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
  await ensureIndex();
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
