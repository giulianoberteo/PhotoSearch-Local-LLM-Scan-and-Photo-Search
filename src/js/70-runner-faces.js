/* ================= backfilling faces =================
   Same shape as the thumbnail rebuild, and for the same reason: it re-reads
   the originals and calls no model, so the whole existing library costs
   minutes rather than another pass at 21.5 seconds a photo. */

async function planFaceScan(onPhase, signal){
  const say = async m => { if (onPhase) await onPhase(m); };
  await say("Opening the index…");
  await indexOp("opening the index", note => ensureIndex(note, { write:false }),
    { onPhase: say, cost: 4 });
  if (!IDX.loaded){ await say("Loading records…"); await loadRecords(); }
  await say("Loading known faces…");
  await loadFaces();

  /* Photos already looked at, so a stopped run resumes instead of restarting. */
  const done = new Set();
  for (const f of FACES.faces.values()) done.add(f.photo_id);

  const everything = [...IDX.records.values()]
    .filter(r => !r.deleted && r.status !== "error" && !r.probe);
  const outstanding = everything.filter(r => !done.has(r.id));

  /* THUMBNAILS NEED NO PHOTO FOLDER. They are keyed by record id and live in
     .photoindex/thumbs/, so this covers the ENTIRE index rather than whatever
     folder happens to be open. Walking the picked folder instead meant a
     library of 6,635 photos got faces for only the 400 in the folder currently
     connected -- the rest were simply never looked at. */
  if (S.faces.source !== "originals"){
    await say("Reading the index — " + outstanding.length + " photos to look at…");
    return { files: outstanding.map(r => ({ id:r.id, name:r.name || r.id,
               path:r.path || r.name || r.id, kind:r.kind, size:r.size, handle:null })),
             already: done.size, total: everything.length,
             faces: FACES.faces.size, people: FACES.people.length,
             scope: "the whole index" };
  }

  /* Originals need file handles, so the folder has to be walked. Only photos in
     the folder that is open can be done this way. */
  let plan = (S.plan && !S.planStale && !S.plan.folderLooksEmpty) ? S.plan : null;
  if (plan) await say("Using the current plan (" + plan.total + " photos)…");
  else {
    await say("Finding the originals — this walks the open folder…");
    plan = await buildPlan(async m => { await say(m); }, signal);
  }
  const files = [];
  for (const g of ["ok","stale","changed","failed","moved"])
    for (const f of plan[g])
      if (!done.has(f.id) && !files.some(x => x.id === f.id)) files.push(f);

  /* Photos already looked at are not looked at again, so this is resumable:
     stop it half way and the next run picks up where it left off. */
  return { files, already: done.size, total: everything.length,
           faces: FACES.faces.size, people: FACES.people.length,
           scope: "the folder you have open",
           notInFolder: outstanding.length - files.length };
}

/* Only photos ALREADY KNOWN to contain a face are worth re-reading at full
   resolution. That is the whole optimisation: the thumbnail pass costs 8
   minutes and tells us which 35-or-so percent of the library has people in it,
   so the expensive pass reads a few gigabytes instead of all 14.3. */
async function planFaceRefine(onPhase, signal){
  const say = async m => { if (onPhase) await onPhase(m); };
  await say("Opening the index…");
  await indexOp("opening the index", note => ensureIndex(note, { write:false }),
    { onPhase: say, cost: 4 });
  if (!IDX.loaded){ await say("Loading records…"); await loadRecords(); }
  if (!FACES.loaded){ await say("Loading known faces…"); await loadFaces(); }
  await say(FACES.faces.size + " faces known; checking which came from thumbnails…");

  const wanted = new Set();
  for (const f of FACES.faces.values())
    if (f.src !== "original") wanted.add(f.photo_id);
  if (!wanted.size)
    return { files: [], candidates: 0, notInFolder: 0, bytes: 0 };

  await say("Finding the originals for " + wanted.size + " photos with faces…");
  let plan = (S.plan && !S.planStale && !S.plan.folderLooksEmpty) ? S.plan : null;
  if (!plan) plan = await buildPlan(async m => { await say(m); }, signal);
  const files = [];
  for (const g of ["ok","stale","changed","failed","moved"])
    for (const f of plan[g])
      if (wanted.has(f.id) && !files.some(x => x.id === f.id)) files.push(f);
  const bytes = files.reduce((a, f) => a + (f.size || 2.2*1048576), 0);
  return { files, candidates: wanted.size,
           notInFolder: wanted.size - files.length, bytes };
}

async function runFaceRefine(files){
  if (libraryMaintenance) throw new Error("Wait for the backup or restore before improving faces.");
  if (FACES.separations.length || FACES.people.some(p => p.confirmed_ids || p.rejected_ids))
    throw new Error("Your saved corrections need a staged migration before re-detection. Current names and faces are preserved.");
  if (!files.length){ toast("Nothing to improve."); return null; }
  RUN.active = true; RUN.paused = false; RUN.stop = false;
  RUN.abort = new AbortController();
  RUN.done = 0; RUN.total = files.length; RUN.errors = []; RUN.times = [];
  RUN.tokens = []; RUN.errorCount = 0; RUN.started = Date.now(); RUN.mode = "faces";
  RUN.batch = []; RUN.vecBatch = []; RUN.pending = new Set();
  await acquireWakeLock();
  scanUi(true);
  $("#progCard").hidden = false;
  $("#facesProg").hidden = false;
  updateProgress();

  const queue = files.slice();
  let improved = 0, found = 0, remapped = 0;
  const conc = Math.max(1, Math.min(8, S.faces.readConcurrency));
  async function loop(){
    for(;;){
      await waitIfPaused();
      if (RUN.stop) return;
      const f = queue.shift();
      if (!f) return;
      const t0 = performance.now();
      try {
        await withDeadline("improving " + f.name, ioDeadline(10, 90000), (async () => {
          const file = await withRetry("read " + f.name, () => f.handle.getFile());
          /* Decode BIG: the point of this pass is pixels on the face. */
          const img = await processImage(file, f.kind, { bigPx: S.faces.refinePx });
          const bmp = await createImageBitmap(img.big);
          try {
            const r = await faceDetectChainRun(() => refinePhotoFaces(f.id, bmp));
            improved++; found += r.found; remapped += r.remapped;
          } finally { bmp.close(); }
          showCurrent(img.thumb, f.path);
        })());
        RUN.times.push((performance.now() - t0) / 1000);
      } catch (e){
        if (e.name === "AbortError") return;
        RUN.errorCount++;
        if (RUN.errors.length < 200) RUN.errors.push({ path:f.path, error:errText(e) });
        if (RUN.errorCount < 20 || RUN.errorCount % 25 === 0) renderErrors();
      }
      RUN.done++;
      updateProgress();
    }
  }
  try { await Promise.all(Array.from({ length: conc }, loop)); }
  finally {
    RUN.active = false;
    releaseWakeLock();
    scanUi(false);
    updateProgress();
    renderErrors();
    $("#facesProg").hidden = true;
    await savePeople();
  }
  return { improved, found, remapped, failed: RUN.errorCount, stopped: RUN.stop };
}

async function runFaceScan(files){
  if (libraryMaintenance) throw new Error("Wait for the backup or restore before scanning faces.");
  if (!files.length){ toast("No photos left to look at."); return null; }
  RUN.active = true; RUN.paused = false; RUN.stop = false;
  RUN.abort = new AbortController();
  RUN.done = 0; RUN.total = files.length; RUN.errors = []; RUN.times = [];
  RUN.tokens = []; RUN.errorCount = 0; RUN.streak = 0; RUN.streakMsg = null;
  RUN.started = Date.now(); RUN.mode = "faces";
  RUN.batch = []; RUN.vecBatch = []; RUN.pending = new Set();
  await acquireWakeLock();
  scanUi(true);
  $("#progCard").hidden = false;
  $("#facesProg").hidden = false;          // the tab this was actually started from
  updateProgress();

  const queue = files.slice();
  let found = 0, looked = 0, fromThumb = 0;

  /* THE thing that decides whether this takes minutes or most of a day.
     Detection costs 8-19 ms. Re-reading the originals costs 14.3 GB at the
     measured 430 KB/s -- 9.7 hours -- for the same photos whose 384px
     thumbnails are 214 MB, or 8 minutes. Read the thumbnail unless the user
     has asked for the accuracy of the full-size original. */
  async function imageFor(f){
    if (S.faces.source !== "originals"){
      try {
        const dir = await thumbsDir();
        const blob = await (await dir.getFileHandle(f.id + ".jpg")).getFile();
        if (blob.size){ fromThumb++; return { blob, thumb: blob }; }
      } catch {}          // no thumbnail for this one: fall back to the original
    }
    if (!f.handle)
      throw new Error("no thumbnail, and the original is not in the folder you "
        + "have open — open that folder, or run a scan to build its thumbnail");
    const file = await withRetry("read " + f.name, () => f.handle.getFile());
    const img = await processImage(file, f.kind, { thumbOnly:false });
    return { blob: img.big, thumb: img.thumb };
  }

  /* Reads overlap; detection does not (see detectFacesSerial). One stalled
     photo must not wedge the run, so each gets its own deadline. */
  const conc = Math.max(1, Math.min(8, S.faces.readConcurrency));
  async function loop(){
    for(;;){
      await waitIfPaused();
      if (RUN.stop) return;
      const f = queue.shift();
      if (!f) return;
      const t0 = performance.now();
      try {
        await withDeadline("looking at " + f.name, ioDeadline(6, 60000), (async () => {
          const got = await imageFor(f);
          const bmp = await createImageBitmap(got.blob);
          try {
            const rows = await detectFacesSerial(f.id, bmp);
            found += rows.length;
          } finally { bmp.close(); }
          showCurrent(got.thumb, f.path);
        })());
        looked++;
        RUN.times.push((performance.now() - t0) / 1000);
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
  try { await Promise.all(Array.from({ length: conc }, loop)); }
  finally {
    RUN.active = false;
    releaseWakeLock();
    scanUi(false);
    updateProgress();
    renderErrors();
    $("#facesProg").hidden = true;
  }
  return { looked, found, fromThumb, failed: RUN.errorCount, stopped: RUN.stop };
}
