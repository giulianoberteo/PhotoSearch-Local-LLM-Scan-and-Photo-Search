
/* ================= walk + plan ================= */
const SKIP_DIR = new Set([".photoindex","@eaDir",".AppleDouble",".Trashes","#recycle",
  "$RECYCLE.BIN","System Volume Information",".Spotlight-V100",".fseventsd",".DS_Store"]);

/* A folder is left out when its path (from the library root, ending in "/") is on the
   exclusion list or inside a listed folder. */
function isExcludedPath(path){
  const list = S.scanExclude || [];
  if (!list.length) return false;
  const p = path.endsWith("/") ? path : path + "/";
  return list.some(e => p === e || p.startsWith(e));
}
async function walk(dir, onTick, signal, base){
  base = base || "";
  const files = [];
  const counts = { excludedDirs:0, raw:0, rawPaired:0, vector:0, video:0, other:0, skippedDirs:0 };
  async function rec(h, prefix, depth){
    if (depth > 24) return;                         // guard against pathological nesting
    const raws = [], stems = new Set();
    for await (const [name, ent] of h.entries()){
      if (signal && signal.aborted) throw new DOMException("aborted","AbortError");
      if (ent.kind === "directory"){
        if (SKIP_DIR.has(name) || name.startsWith(".")){ counts.skippedDirs++; continue; }
        if (isExcludedPath(base + prefix + name + "/")){ counts.excludedDirs++; continue; }
        await rec(ent, prefix + name + "/", depth + 1);
      } else {
        if (name.startsWith("._")) continue;        // AppleDouble sidecars
        const kind = classifyFile(name);
        if (kind === "raw") raws.push({ path: prefix + name, name, handle: ent, kind });
        else if (kind === "native" || kind === "heic" || kind === "tiff"){
          stems.add(name.replace(/\.[^.]*$/, "").toLowerCase());
          files.push({ path: prefix + name, name, handle: ent, kind });
          if (onTick && files.length % 100 === 0) await onTick(files.length);
        } else counts[kind === "other" ? "other" : kind]++;
      }
    }
    // A RAW with a same-named JPEG beside it is the same shot: the JPEG is scanned, not both.
    for (const r of raws){
      if (stems.has(r.name.replace(/\.[^.]*$/, "").toLowerCase())) counts.rawPaired++;
      else files.push(r);
    }
  }
  await rec(dir, "", 0);
  return { files, counts };
}

/* getFile() is one stat per file. Over SMB that is latency-bound, so issue a
   bounded number in parallel; this is the difference between fast and unusable
   on a NAS. */
async function statAll(files, onTick, signal){
  const conc = Math.max(1, Math.min(32, S.scan.statConcurrency));
  let i = 0, done = 0;
  async function loop(){
    for(;;){
      if (signal && signal.aborted) throw new DOMException("aborted","AbortError");
      const k = i++;
      if (k >= files.length) return;
      const f = files[k];
      try {
        const file = await withRetry("stat " + f.name, () => f.handle.getFile());
        f.size = file.size; f.mtime = file.lastModified;
      } catch (e){
        f.statError = String(e.message || e);
      }
      done++;
      if (onTick && done % 100 === 0) await onTick(done, files.length);
    }
  }
  await Promise.all(Array.from({ length: conc }, loop));
  return files;
}

/* Resolves the scope to a directory handle plus the path prefix that keeps
   record paths relative to the LIBRARY ROOT, not to the scanned subfolder. */
async function scopedRoot(){
  const scope = (S.scanScope || "").replace(/^\/+|\/+$/g, "");
  if (!scope) return { handle: S.dirHandle, prefix: "" };
  let h = S.dirHandle;
  try {
    for (const part of scope.split("/"))
      h = await withRetry("opening " + part, () => h.getDirectoryHandle(part));
  } catch (e){
    /* Only a genuinely absent folder justifies widening the scope. Treating a
       transient share failure the same way silently turns "scan 400 photos in
       Sicily" into "walk 50,000", and re-enables missing-judgement across the
       whole library. */
    const gone = isNotFound(e);
    if (!gone)
      throw new Error("could not open the scan scope '" + scope + "': " + errText(e)
        + ". The scope is unchanged; try again when the share is responding.");
    S.scanScope = "";
    const sel = document.getElementById("sScope");
    if (sel) sel.value = "";
    if (typeof toast === "function")
      toast("Scan scope '" + scope + "' no longer exists — showing the whole library.");
    return { handle: S.dirHandle, prefix: "" };
  }
  return { handle: h, prefix: scope + "/" };
}
/* Lists the top-level folders so the UI can offer them as scopes. */
async function listSubfolders(){
  const out = [];
  if (!S.dirHandle) return out;
  for await (const [name, ent] of S.dirHandle.entries()){
    if (ent.kind !== "directory") continue;
    if (SKIP_DIR.has(name) || name.startsWith(".")) continue;
    out.push(name);
  }
  return out.sort((a,b) => a.localeCompare(b));
}

/* Costs nothing extra: name, size and mtime all come from the stat we already do. */
const identityOf = x => (x.name || "") + "|" + (x.size == null ? "?" : x.size)
  + "|" + (x.mtime == null ? "?" : x.mtime);

/* size + a hash of the first 64KB. Enough to tell two files apart without
   reading them whole, which would be far too slow over SMB. */
async function contentTag(file){
  const n = Math.min(65536, file.size);
  const buf = new Uint8Array(await file.slice(0, n).arrayBuffer());
  let h = 0x811c9dc5;
  for (let i = 0; i < buf.length; i++){ h ^= buf[i]; h = Math.imul(h, 0x01000193) >>> 0; }
  return file.size.toString(36) + "-" + h.toString(16);
}

async function buildPlan(onTick, signal){
  const { handle: scopeHandle, prefix } = await scopedRoot();
  const { files, counts } = await walk(scopeHandle, n =>
    onTick && onTick("Walking " + (prefix || "library") + ": " + n + " images"), signal, prefix);
  // Paths are always stored relative to the library root so two subfolders can
  // never produce the same id for different photos.
  if (prefix) for (const f of files) f.path = prefix + f.path;
  await statAll(files, (d, t) =>
    onTick && onTick("Reading file details: " + d + " / " + t), signal);

  const sh = SCHEMA_HASH(), ph = PROMPT_HASH();
  /* If no scan model is resolved yet (page just reloaded, detection still in
     flight), comparing against "" would mark the ENTIRE library stale and make
     a finished scan look lost. Skip the model check until we actually know. */
  const vm = S.roles.scan || null;
  const plan = { new:[], changed:[], stale:[], ok:[], failed:[], moved:[], missing:[],
                 unreadable:[], counts, total: files.length, scope: prefix };
  /* Only records inside the scanned scope may be judged. Everything else was
     simply not looked at, and must never be reported missing or moved. */
  const inScope = r => (!prefix || (r.path || "").startsWith(prefix)) && !isExcludedPath(r.path || "");

  /* ---- identity matching ----
     A record is keyed by the FILE, not by where the picker happened to point.
     Identity = name + size + modified time, which we already have from stat, so
     it costs no extra reads. That means:
       - picking the library root or a subfolder finds the same records
       - moving or re-organising a folder keeps the record
       - the same filename in two folders stays two distinct photos
     Matching order: exact stored path, then identity, then genuinely new. */
  const presentPaths = new Set(files.map(f => f.path));
  const rootName = (S.dirHandle && S.dirHandle.name) || "";
  const recByPath = new Map();
  const byIdentity = new Map();
  const usedIds = new Set();
  for (const [id, r] of IDX.records){
    usedIds.add(id);
    if (r.deleted) continue;
    /* Records outside the scanned scope were not looked at, so they must not be
       matched, relinked or judged. inScope existed but was never applied to the
       matchers, so a scoped scan could steal a record from another folder. */
    if (!inScope(r)) continue;
    /* A stored path is only meaningful relative to the folder it was scanned
       from: pick two different subfolders and both photos are "IMG_1.jpg".
       So path matching is qualified by that root; identity handles the rest.
       Records written before this field existed are matched on path alone. */
    if (!r.library_root || r.library_root === rootName) recByPath.set(r.path, r);
    const k = identityOf(r);
    if (!byIdentity.has(k)) byIdentity.set(k, []);
    byIdentity.get(k).push(r);
  }

  const claimed = new Set();
  const unmatched = [];
  /* Records belonging to files we could not stat must be protected: the file is
     present, we simply could not read it. Without this they fall through to
     "missing" and Mark missing soft-deletes them. */
  const unreadablePaths = new Set(files.filter(f => f.statError).map(f => f.path));
  for (const f of files){
    if (f.statError) continue;
    f.fp = f.size + ":" + f.mtime;
    const r = recByPath.get(f.path);
    if (r){ f.id = r.id; claimed.add(r.id); }
    else unmatched.push(f);
  }

  /* Identity pass. Only a 1:1 match counts, so true duplicates are never
     guessed at — they simply become separate photos. */
  const freeByIdentity = new Map();
  for (const [k, list] of byIdentity){
    const free = list.filter(r => !claimed.has(r.id));
    if (free.length) freeByIdentity.set(k, free);
  }
  const unmatchedByIdentity = new Map();
  for (const f of unmatched){
    const k = identityOf(f);
    if (!unmatchedByIdentity.has(k)) unmatchedByIdentity.set(k, []);
    unmatchedByIdentity.get(k).push(f);
  }
  const takenFiles = new Set();
  const relink = [];       // matched by content, so path and/or root must be rewritten
  for (const [k, fs] of unmatchedByIdentity){
    const rs = freeByIdentity.get(k);
    if (!rs || fs.length !== 1 || rs.length !== 1) continue;
    const f = fs[0], r = rs[0];
    /* Confirm by content before reusing the record. Name, size and mtime can
       coincide; the first 64KB effectively cannot. Older records predate this
       tag, so they are accepted on identity alone. */
    if (r.content_tag){
      try {
        const file = await withRetry("verify " + f.name, () => f.handle.getFile());
        const tag = await contentTag(file);
        f.contentTag = tag;
        if (tag !== r.content_tag) continue;      // different photo: leave it new
      } catch { continue; }
    }
    f.id = r.id; f.movedFrom = r.path; f.moveConfidence = r.content_tag ? "content" : "identity";
    claimed.add(r.id); takenFiles.add(f.path);
    relink.push(f);          // classified below like any other file
  }

  /* Tier 3: name + size only, for copies that lost their timestamp (a NAS
     transfer, rsync without -t, cloud sync). Requires a 1:1 match on both
     sides AND a content match, so duplicates are still never guessed at. */
  const looseOf = x => (x.name || "") + "|" + (x.size == null ? "?" : x.size);
  const looseFiles = new Map(), looseRecs = new Map();
  for (const f of unmatched){
    if (takenFiles.has(f.path)) continue;
    const k = looseOf(f);
    looseFiles.set(k, (looseFiles.get(k) || []).concat(f));
  }
  for (const [id, r] of IDX.records){
    if (r.deleted || claimed.has(id) || !inScope(r)) continue;
    if (presentPaths.has(r.path) && (!r.library_root || r.library_root === rootName)) continue;
    const k = looseOf(r);
    looseRecs.set(k, (looseRecs.get(k) || []).concat(r));
  }
  for (const [k, fs] of looseFiles){
    const rs = looseRecs.get(k);
    if (!rs || fs.length !== 1 || rs.length !== 1) continue;
    const f = fs[0], r = rs[0];
    if (r.content_tag){
      try {
        const file = await withRetry("verify " + f.name, () => f.handle.getFile());
        const tag = await contentTag(file);
        f.contentTag = tag;
        if (tag !== r.content_tag) continue;
      } catch { continue; }
    }
    f.id = r.id; f.movedFrom = r.path;
    f.moveConfidence = r.content_tag ? "content" : "name+size";
    claimed.add(r.id); takenFiles.add(f.path);
    relink.push(f);
  }

  const newId = path => {
    let base = fnv64(path), id = base, n = 0;
    while (usedIds.has(id)) id = base + "-" + (++n);
    usedIds.add(id);
    return id;
  };
  const seen = new Set(claimed);
  for (const f of files){
    if (f.statError){ plan.unreadable.push(f); continue; }
    const r = f.id ? IDX.records.get(f.id) : null;
    /* Re-point the record if the file moved OR was reached from a different
       pick root. Without the root rewrite it would be content-verified again
       on every single plan. */
    if (r && !r.deleted && (r.path !== f.path || r.library_root !== rootName))
      plan.moved.push(f);
    if (!r || r.deleted){ f.id = f.id && r ? f.id : newId(f.path); plan.new.push(f); seen.add(f.id); continue; }
    seen.add(f.id);
    if (r.fingerprint !== f.fp) plan.changed.push(f);
    else if (r.status === "error" || r.status === "partial") plan.failed.push(f);
    else if (r.schema_hash !== sh || r.prompt_hash !== ph || (vm && r.vision_model !== vm)) plan.stale.push(f);
    else plan.ok.push(f);
  }

  /* ---- missing ----
     Only records that belong to the folder we actually walked may be judged.
     Anything scanned from a different pick root was simply not looked at, so it
     is never reported missing. This is deliberately conservative: under-report
     rather than risk soft-deleting a library you did not open. */
  for (const [id, r] of IDX.records){
    if (seen.has(id) || r.deleted) continue;
    if (prefix && !(r.path || "").startsWith(prefix)) continue;
    if (r.library_root && r.library_root !== rootName) continue;
    if (unreadablePaths.has(r.path)) continue;      // present but unreadable
    plan.missing.push(r);
  }

  /* Order decides what exists in the index on day one of a multi-day scan. */
  const order = S.scanOrder;
  const sorter =
    order === "oldest"   ? (a,b) => (a.mtime||0) - (b.mtime||0) :
    order === "smallest" ? (a,b) => (a.size||0) - (b.size||0) :
    order === "path"     ? (a,b) => a.path.localeCompare(b.path) :
                           (a,b) => (b.mtime||0) - (a.mtime||0);   // newest first
  for (const g of ["new","changed","stale","failed","ok","moved"]) plan[g].sort(sorter);

  plan.folderLooksEmpty = files.length === 0;
  plan.indexTotal = [...IDX.records.values()].filter(r => !r.deleted).length;
  S.plan = plan;
  return plan;
}

/* Relinking needs no model call: rewrite where the file is and which root it
   was seen under, and keep every other field (including the hashes, so the
   staleness check still fires). */
async function applyMoves(moved){
  if (!moved.length) return 0;
  /* Read the FULL records from disk first. The in-memory copies are lightened
     -- raw_model_json and embeddings are stripped to keep a large library in
     memory -- and records.jsonl is last-line-wins, so writing a lightened copy
     would make the stripped version authoritative and destroy the model output
     permanently. One pass over the file covers every move. */
  const full = await readFullRecords(new Set(moved.map(f => f.id)));
  const lines = [];
  for (const f of moved){
    const old = full.get(f.id) || IDX.records.get(f.id);
    if (!old) continue;
    const rec = { ...old, path:f.path, name:f.name, fingerprint:f.fp,
      size:f.size, mtime:f.mtime, moved_from:f.movedFrom,
      move_confidence:f.moveConfidence, moved_at:new Date().toISOString(),
      content_tag: f.contentTag || old.content_tag,
      library_root: (S.dirHandle && S.dirHandle.name) || old.library_root };
    IDX.records.set(f.id, lighten(rec));
    lines.push(rec);
  }
  await appendLines("records.jsonl", lines);
  return lines.length;
}

/* Mark missing refuses to run when the folder looks disconnected, so an
   unmounted NAS cannot soft-delete the whole library. */
async function markMissing(plan){
  if (plan.folderLooksEmpty)
    throw new Error("The " + (plan.scope ? "folder '" + plan.scope + "'" : "library")
      + " returned no images at all. Refusing to mark anything missing — check that the "
      + "drive or network share is connected.");
  if (plan.missing.length > plan.total && plan.total > 0)
    throw new Error("More records are missing than files found. Refusing, as this usually means "
      + "a partly mounted share.");
  /* A flaky share fails some reads, not all. Proportion is the signal a bare
     count misses: losing a quarter of a library at once is never routine. */
  const live = plan.indexTotal || IDX.records.size;
  if (live > 20 && plan.missing.length > live * 0.25)
    throw new Error("That would mark " + plan.missing.length + " of " + live
      + " records missing (" + Math.round(plan.missing.length / live * 100) + "%). "
      + "Refusing: this usually means the share is flaky rather than the photos being gone. "
      + "Refresh the plan when it is responding normally.");
  if (plan.unreadable && plan.unreadable.length)
    throw new Error(plan.unreadable.length + " file(s) could not be read on this pass, so "
      + "what is genuinely missing cannot be determined. Try again when the share is healthy.");
  const lines = plan.missing.map(r => ({ ...r, deleted:true, deleted_at:new Date().toISOString() }));
  for (const r of lines) IDX.records.set(r.id, lighten(r));
  await appendLines("records.jsonl", lines);
  return lines.length;
}
