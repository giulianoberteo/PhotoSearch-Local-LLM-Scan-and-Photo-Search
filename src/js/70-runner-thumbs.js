/* ================= rebuilding thumbnails =================
   Thumbnails are the only derived part of the index: 384px JPEGs written during
   a scan, and deliberately excluded from backups because they are ~80% of the
   bytes while costing no model time to produce.

   That trade is only honest if they can actually be remade. Until now they
   could not -- a missing thumbs/<id>.jpg was a blank tile for ever, and the
   only way back was to re-scan the photo and pay the model again for a caption
   that was never lost. Rebuilding needs the original file and nothing else: no
   model, no network, no embeddings. */

async function planThumbnails(onPhase, signal){
  const say = async m => { if (onPhase) await onPhase(m); };
  await say("Opening the index…");
  await indexOp("opening the index", note => ensureIndex(note, { write:false }),
    { onPhase: say, cost: 4 });
  if (!IDX.loaded) { await say("Loading records…"); await loadRecords(); }

  await say("Listing existing thumbnails…");
  const have = await indexOp("listing thumbnails", note => listThumbIds(note),
    { onPhase: say, cost: 60 });          // the 75-second operation, deliberately

  /* Error stubs never had a thumbnail and are not supposed to get one; a
     soft-deleted record describes a photo that is no longer there. */
  const wanted = [...IDX.records.values()]
    .filter(r => !r.deleted && r.status !== "error");
  const missingIds = new Set(wanted.filter(r => !have.has(r.id)).map(r => r.id));

  /* A thumbnail with no record is dead weight from a compacted or restored
     index. Counted, never deleted: this command rebuilds, it does not tidy, and
     removing files is not a decision it should make alone. Counted BEFORE the
     early return, because "nothing is missing" is exactly when someone is most
     likely to be asking what is in there. */
  let orphans = 0;
  for (const id of have) if (!IDX.records.has(id)) orphans++;

  if (!missingIds.size)
    return { files: [], missing: 0, have: have.size, total: wanted.length,
             unresolved: [], orphans };

  /* The originals have to be found the same way a scan finds them -- by
     identity, not by the stored path -- or a library that has been reorganised
     rebuilds nothing. buildPlan already does exactly that. */
  await say("Finding the originals…");
  const plan = await buildPlan(null, signal);
  const byId = new Map();
  for (const g of ["ok","stale","changed","failed","moved"])
    for (const f of plan[g])
      if (missingIds.has(f.id) && !byId.has(f.id)) byId.set(f.id, f);

  /* Anything still unaccounted for belongs to a folder that is not open right
     now. Say so rather than silently rebuilding a subset. */
  const unresolved = [...missingIds].filter(id => !byId.has(id))
    .map(id => IDX.records.get(id)).filter(Boolean);

  return { files: [...byId.values()], missing: missingIds.size,
           have: have.size, total: wanted.length, unresolved, orphans };
}

async function runThumbnailRebuild(files){
  if (!files.length){ toast("Nothing to rebuild."); return null; }
  RUN.active = true; RUN.paused = false; RUN.stop = false;
  RUN.abort = new AbortController();
  RUN.done = 0; RUN.total = files.length; RUN.errors = []; RUN.times = [];
  RUN.tokens = []; RUN.errorCount = 0; RUN.streak = 0; RUN.streakMsg = null;
  RUN.started = Date.now(); RUN.mode = "thumbnails";
  RUN.batch = []; RUN.vecBatch = []; RUN.pending = new Set();
  await acquireWakeLock();
  scanUi(true);
  $("#progCard").hidden = false;
  updateProgress();

  const queue = files.slice();
  let built = 0;
  /* Reads are latency-bound on a share and decoding is one worker, so a few in
     flight overlaps the two. No model is involved, so none of the reasons
     scanning stays at concurrency 1 apply here. */
  const conc = Math.max(1, Math.min(4, S.scan.statConcurrency > 1 ? 3 : 1));

  async function loop(){
    for(;;){
      await waitIfPaused();
      if (RUN.stop) return;
      const f = queue.shift();
      if (!f) return;
      const t0 = performance.now();
      try {
        const file = await withRetry("read " + f.name, () => f.handle.getFile());
        const img = await processImage(file, f.kind, { thumbOnly:true });
        await saveThumb(f.id, img.thumb);
        showCurrent(img.thumb, f.path);
        RUN.times.push((performance.now() - t0) / 1000);
        built++;
      } catch (e){
        if (e.name === "AbortError") return;
        RUN.errorCount++;
        if (RUN.errors.length < 200)
          RUN.errors.push({ path:f.path, error:errText(e) });
        if (RUN.errorCount < 20 || RUN.errorCount % 25 === 0) renderErrors();
      }
      RUN.done++;
      updateProgress();
    }
  }

  try {
    await Promise.all(Array.from({ length: conc }, loop));
  } finally {
    RUN.active = false;
    releaseWakeLock();
    scanUi(false);
    updateProgress();
    renderErrors();
    /* Cached object URLs were created before these files existed; drop them so
       the grid re-reads what was just written instead of showing blanks. */
    for (const [k, v] of thumbCache){
      if (thumbPinned.has(k)) continue;
      try { URL.revokeObjectURL(v); } catch {}
      thumbCache.delete(k);
    }
  }
  return { built, failed: RUN.errorCount, stopped: RUN.stop };
}


