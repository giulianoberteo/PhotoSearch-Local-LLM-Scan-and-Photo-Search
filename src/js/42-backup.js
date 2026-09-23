
/* ================= index backups =================
   What is worth copying is what cost model time: records.jsonl holds every
   extraction, vectors.bin every embedding. Thumbnails are deliberately NOT
   backed up — they are the bulk of the index and can be rebuilt by re-decoding
   the originals, which costs no model calls at all. */
const BACKUP_FILES = ["records.jsonl", "vectors.bin", "vectors.json", "config.json"];

async function backupsDir(){
  return IDX.dir.getDirectoryHandle("backups", { create:true });
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
  await ensureIndex();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = await backupsDir();
  const dest = await dir.getDirectoryHandle(stamp, { create:true });
  const copied = [];
  for (const name of BACKUP_FILES){
    if (onProgress) await onProgress("Copying " + name + "…");
    const r = await copyInto(IDX.dir, dest, name);
    if (r) copied.push(r);
  }
  if (onProgress) await onProgress("Verifying…");
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
