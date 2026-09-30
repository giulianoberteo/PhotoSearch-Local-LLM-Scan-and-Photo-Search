
/* ================= scan runner ================= */
const RUN = {
  active:false, paused:false, stop:false, abort:null,
  done:0, total:0, errors:[], times:[], tokens:[],
  started:0, runId:null, batch:[], vecBatch:[], mode:"", pending:null,
  streak:0, streakMsg:null, errorCount:0
};
let wakeLock = null;

async function acquireWakeLock(){
  if (wakeLock) return;                 // idempotent: it is acquired on two paths now
  try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request("screen"); }
  catch { wakeLock = null; }
}
function releaseWakeLock(){
  try { if (wakeLock){ wakeLock.release(); wakeLock = null; } } catch {}
}
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && RUN.active && !RUN.paused && !wakeLock)
    await acquireWakeLock();
});
window.addEventListener("beforeunload", e => {
  if (RUN.active){ e.preventDefault(); e.returnValue = ""; }
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitIfPaused(){ while (RUN.paused && !RUN.stop) await sleep(150); }

/* One photo, end to end. Retries once with the validation errors named. */
async function scanOne(f, signal){
  const file = await withRetry("read " + f.name, () => f.handle.getFile());
  const tag = await contentTag(file);
  const img = await withRetry("decode " + f.name, () => processImage(file, f.kind));
  const dataUrl = await blobToDataUrl(img.big);
  showCurrent(img.thumb, f.path);

  const exif = await readExif(file, f.name, overrideFor(f.path));

  let attempt = 0, note = "", out = null, lastIssues = null, lastParsed = null;
  let attemptTokens = S.scan.maxTokens, tokenBumpUsed = false;
  while (attempt < 2){
    attempt++;
    if (signal.aborted) throw new DOMException("aborted","AbortError");
    try {
      const r = await extract(S.roles.scan, dataUrl, note, signal, attemptTokens);
      let parsed;
      try { parsed = JSON.parse(r.raw); }
      catch (e){
        /* Truncated output is not a bad answer, it is one that ran out of room
           -- almost always an image dense with text. Give it more and retry,
           rather than recording a failure. */
        /* Bound this explicitly: the old guard compared against the configured
           ceiling rather than the value it was about to set, so a maxTokens of
           8000+ looped forever on one image, and above 8000 it silently LOWERED
           the budget. */
        const bumped = Math.min(12000, Math.max(attemptTokens * 3, 3000));
        if (r.truncated && !tokenBumpUsed && bumped > attemptTokens){
          attemptTokens = bumped;
          tokenBumpUsed = true;
          note = ""; attempt--;            // the extra try does not count
          continue;
        }
        throw new Error("JSON parse failed"
          + (r.truncated ? " (hit the " + attemptTokens + "-token limit)" : "")
          + ": " + e.message);
      }
      const v = validate(parsed);
      lastParsed = { r, parsed, v };
      /* Only retry for problems the normaliser cannot fix. Over-generating
         objects or writing a long caption is repaired silently, and retrying
         those doubled the cost of a multi-day scan for nothing. */
      const worthRetrying = v.issues.filter(i =>
        /not in enum|reserved field|fewer than 3/.test(i));
      if (worthRetrying.length && attempt === 1){
        note = "Your previous answer had these problems, fix them exactly: "
          + worthRetrying.join("; ");
        lastIssues = v.issues;
        continue;
      }
      out = lastParsed;
      break;
    } catch (e){
      if (e.name === "AbortError") throw e;
      lastIssues = [errText(e)];
      if (attempt >= 2) break;
      note = "Your previous answer failed to parse. Return ONE valid JSON object only.";
    }
  }
  /* Keep what parsed, but do not lose WHY the second attempt failed: the real
     cause (HTTP 500, connection reset) used to be dropped in favour of the
     first attempt's validation issues, producing a library of plausible
     "partial" records during an outage. */
  if (!out && lastParsed){
    out = lastParsed;
    if (lastIssues && lastIssues.length) out.retryError = lastIssues.join("; ");
  }
  if (!out) throw new Error((lastIssues || ["unknown extraction failure"]).join("; "));

  await saveThumb(f.id, img.thumb);

  /* Faces, if switched on. The photo is already decoded at this point, so this
     costs milliseconds against 21.5 seconds of model time -- invisible. A
     failure here must never fail the photo: the caption is the expensive part
     and faces can always be filled in later by the backfill pass. */
  if (S.faces.enabled && FACE_ENGINE){
    try {
      const bmp = await createImageBitmap(img.big);
      try { await detectFacesIn(f.id, bmp); } finally { bmp.close(); }
    } catch (e){ console.warn("faces:", errText(e)); }
  }

  const norm = out.v.norm;
  const fix = correctImageType(norm.image_type,
    { name:f.name, width:img.srcW, height:img.srcH, camera:exif.camera }, norm);

  /* Text-heavy images get a second, text-only pass at higher resolution. It is
     skipped for ordinary photos, so it costs nothing on most of a library. */
  let textLines = null, textSource = "inline", ocrCost = null;
  const wantsOcr = S.ocr.enabled && TEXT_HEAVY.has(fix.type)
    && norm.visible_text && norm.visible_text.has_text;
  if (wantsOcr){
    try {
      const big = await processImage(file, f.kind, { bigPx:S.ocr.px });
      const ocrUrl = await blobToDataUrl(big.big);
      let o = await ocrPass(S.roles.scan, ocrUrl, signal);
      if ((o.truncated || o.parseError) && S.ocr.maxTokens < 8000)
        o = await ocrPass(S.roles.scan, ocrUrl, signal, Math.min(8000, S.ocr.maxTokens * 2));
      const joined = o.lines.join("\n");
      // Keep whichever pass actually read more; never regress.
      if (joined.length > (norm.visible_text.text || "").length){
        textLines = o.lines;
        norm.visible_text = { has_text:true, text:joined };
        textSource = "ocr-pass";
      }
      ocrCost = { secs:o.secs, tokens:o.tokens, lines:o.lines.length,
        truncated: !!o.truncated, parse_error: o.parseError || null };
    } catch (e){
      if (e.name === "AbortError") throw e;
      ocrCost = { error:errText(e) };
    }
  }
  const when = dateContext(exif.date_taken,
    { occasions:S.date.occasions, hemisphere:S.date.hemisphere });
  const place = exif.gps ? nearestPlace(exif.gps.lat, exif.gps.lon) : null;

  const rec = {
    id:f.id, path:f.path, name:f.name, kind:f.kind,
    library_root: (S.dirHandle && S.dirHandle.name) || null,
    content_tag: tag,
    fingerprint:f.fp, size:f.size, mtime:f.mtime,
    width:img.srcW, height:img.srcH, decoder:img.decoder,
    ...norm,
    image_type: fix.type, image_type_model: norm.image_type, image_type_source: fix.source,
    text_lines: textLines, text_source: textSource, ocr: ocrCost,
    date_taken:exif.date_taken, date_source:exif.date_source,
    date_confidence:exif.date_confidence, date_suspect:exif.date_suspect,
    date_alternatives:exif.date_alternatives,
    gps:exif.gps, camera:exif.camera, lens:exif.lens, software:exif.software,
    place: place ? place.name + (place.country ? ", " + place.country : "") : null,
    place_km: place ? place.km : null,
    when, when_phrase: datePhrase(when),
    raw_model_json: out.parsed,
    schema_hash: SCHEMA_HASH(), prompt_hash: PROMPT_HASH(),
    vision_model: S.roles.scan, embed_model: S.roles.embed || null,
    scanned_at: new Date().toISOString(),
    secs: out.r.secs, out_tokens: out.r.tokens, reasoned: out.r.reasoned,
    attempts: attempt,
    status: out.v.issues.length ? "partial" : "ok",
    issues: out.v.issues,
    retry_error: out.retryError || null
  };
  if (fix.changed) rec.issues = [...rec.issues, "image_type corrected from '" + norm.image_type
    + "' to '" + fix.type + "' via " + fix.source];

  capText(rec);                       // per-type cap, now that the type is settled

  if (S.roles.embed){
    try {
      const vec = await embed(S.roles.embed, embedDoc(rec), signal);
      rec.embedding_dim = vec.length;
      RUN.vecBatch.push({ id:rec.id, vec: Float32Array.from(vec) });
    } catch (e){
      if (e.name === "AbortError") throw e;
      rec.embed_error = errText(e);
    }
  }
  return rec;
}

/* Check the things that would fail identically for every image BEFORE starting,
   so a misconfiguration produces one clear message instead of N error records. */
async function preflightScan(){
  /* Where the index goes is a decision, not a default. If it was never chosen,
     confirm it rather than silently creating one beside the photos -- which on
     a new machine, or a new folder, means starting from nothing by accident. */
  /* Ask again whenever the index would be BRAND NEW, not just the first time
     ever. The latch meant that after answering once for library A, pointing at
     folder B silently created an empty index there and never asked. */
  const freshIndex = IDX.records.size === 0;
  if ((!S.indexChosen || freshIndex) && !$("#mock").checked){
    const where = S.indexMode === "custom" && S.indexDirHandle
      ? S.indexDirHandle.name
      : (S.dirHandle ? S.dirHandle.name : "the photo folder");
    const existing = IDX.records.size;
    const ok = confirm(
      "Where should the index be saved?\n\n"
      + "No location has been chosen, so it will go to:\n"
      + "    " + where + "/.photoindex/\n\n"
      + (existing
          ? "That index already holds " + existing + " photos; new ones are added to it.\n\n"
          : "That folder has NO index yet, so this starts a new, empty one.\n"
            + "If you meant to add to an existing index, cancel and choose its\n"
            + "location under Settings first.\n\n")
      + "Continue?");
    if (!ok) return "Choose where to save the index under Settings, then scan.";
    S.indexChosen = true;
    saveSettings();
  }
  if (!S.roles.scan && !$("#mock").checked) await autoConnect();
  if (!S.roles.scan)
    return "No scan model selected. Open Settings, press Test connection, then pick a "
         + "vision model under Model roles.";
  if ($("#mock").checked) return null;
  const m = await jget("/api/v0/models", 8000);
  if (!m.ok){
    const v = await jget("/v1/models", 8000);
    if (!v.ok) return "Cannot reach LM Studio at " + S.baseUrl + " (" + m.error + "). "
      + "Start it with:  lms server start --cors --port 1234";
    return null;
  }
  const ids = (m.data.data || []).map(x => x.id);
  if (ids.length && !ids.includes(S.roles.scan))
    return "The selected scan model '" + S.roles.scan + "' is not in LM Studio. "
         + "Available: " + ids.slice(0,6).join(", ") + ". Press Test connection in Settings.";
  const entry = (m.data.data || []).find(x => x.id === S.roles.scan);
  if (entry && entry.type === "embeddings")
    return "'" + S.roles.scan + "' is an embedding model and cannot read images. "
         + "Pick a vision model under Model roles.";
  if (S.roles.embed && ids.length && !ids.includes(S.roles.embed))
    return "The selected embedding model '" + S.roles.embed + "' is not in LM Studio. "
         + "Set it to None, or press Test connection.";
  return null;
}

async function runScan(files, mode, resuming){
  if (!files.length){ toast("Nothing to do."); return; }

  /* Everything between pressing Scan and the first photo can take MINUTES on a
     share: the safety copy alone is ~50 MB at a few hundred KB/s, then it is
     verified by re-reading it. All of that used to happen with the progress card
     still hidden and not a single row on screen, so pressing Scan looked exactly
     like pressing nothing -- for minutes, on the one action the user least wants
     to be unsure about. Claim the run and start reporting before any of it. */
  RUN.active = true; RUN.paused = false; RUN.stop = false;
  RUN.abort = new AbortController();
  RUN.done = 0; RUN.total = files.length; RUN.errors = []; RUN.times = [];
  RUN.tokens = []; RUN.errorCount = 0; RUN.streak = 0; RUN.streakMsg = null;
  RUN.started = Date.now(); RUN.mode = mode;
  RUN.batch = []; RUN.vecBatch = []; RUN.pending = new Set();
  scanUi(true);
  $("#progCard").hidden = false;
  $("#progStats").textContent = "Preparing…";
  $("#progEta").textContent = "";
  const prep = step($("#errBox"), "Preparing to scan");
  /* The safety copy can run for minutes; the screen must not sleep through it. */
  await acquireWakeLock();
  /* Any path that gives up from here must hand the UI back, or the buttons stay
     dead and the app looks wedged. */
  const abandon = (why, how) => {
    RUN.active = false;
    releaseWakeLock();
    scanUi(false);
    if (why) prep[how || "err"](why);
    else prep.ok("cancelled");
    return null;
  };

  await prep.note("Checking the folder and the model…");
  if (!(await ensureIndexConnected()) || !(await ensureConnected("the scan")))
    return abandon("Could not reconnect the folder.", "warn");
  const problem = await preflightScan();
  if (problem){
    abandon(null, null);
    $("#progCard").hidden = false;
    renderChecks($("#errBox"), [{ status:"err", title:"Scan not started", detail:problem }]);
    toast(problem);
    return;
  }
  /* Safety copy BEFORE writing anything. A failed scan cannot corrupt an
     append-only log, but this also covers compaction, re-embedding and simple
     human error -- and the existing records represent days of work. */
  if (S.backup.enabled && IDX.records.size > 0){
    try {
      await prep.note("Safety copy of " + IDX.records.size + " records before scanning…");
      const pre = await backupIndex("pre-scan safety copy",
        async m => { await prep.note("Safety copy — " + m); });
      await prep.note("Safety copy taken ("
        + (pre.bytes / 1048576).toFixed(1) + " MB). Starting…");
      toast("Safety copy taken (" + (pre.bytes/1048576).toFixed(1) + " MB) before scanning.");
    } catch (e){
      prep.warn("Safety copy failed: " + errText(e));
      const go = confirm("Could not take a safety copy of the existing index:\n\n"
        + errText(e) + "\n\nThe index has " + IDX.records.size + " records. "
        + "Scan anyway?\n\n(Records are only ever appended, so a failed scan "
        + "cannot delete existing ones.)");
      if (!go) return abandon("Cancelled — no safety copy.", "warn");
    }
  }
  await prep.note("Opening the index…");
  await ensureIndex();
  /* Stop is live during preparation, so honour it rather than resetting the flag
     and scanning anyway -- which is what re-initialising here used to do. */
  if (RUN.stop) return abandon("Stopped before scanning began.", "warn");
  prep.ok(files.length + " to scan.");
  /* RUN was already claimed above; only what depends on the prepared index is
     set here. Deliberately NOT re-touching active/stop/abort. */
  RUN.started = Date.now();
  RUN.runId = resuming && IDX.checkpoint ? IDX.checkpoint.run_id : "run-" + Date.now();
  const queue = files.slice();
  RUN.pending = new Set(queue.map(f => f.path));
  await acquireWakeLock();
  scanUi(true);
  updateProgress();

  const conc = Math.max(1, Math.min(4, S.scan.concurrency));
  async function loop(){
    for(;;){
      await waitIfPaused();
      if (RUN.stop) return;
      const f = queue.shift();
      if (!f) return;
      try {
        const rec = await scanOne(f, RUN.abort.signal);
        RUN.streak = 0;                       // a success breaks the failure streak
        RUN.times.push(rec.secs);
        if (rec.out_tokens) RUN.tokens.push(rec.out_tokens);
        RUN.batch.push(rec);
        IDX.records.set(rec.id, lighten(rec));
        addRecent(rec);
      } catch (e){
        if (e.name === "AbortError"){ queue.unshift(f); return; }
        const msg = errText(e);
        /* NEVER downgrade a good record to an error stub. A transient read or
           decode failure during a rescan would otherwise destroy a caption,
           objects, dates and GPS that cost real model time -- and compaction
           would make it permanent. Keep the old content and record the failure
           alongside it. */
        const prior = IDX.records.get(f.id);
        const keep = (prior && !prior.deleted && prior.status !== "error")
          ? (await readFullRecords(new Set([f.id]))).get(f.id) || prior
          : null;
        const rec = keep
          ? { ...keep, path:f.path, name:f.name, fingerprint:f.fp,
              size:f.size, mtime:f.mtime,
              library_root: (S.dirHandle && S.dirHandle.name) || null,
              last_error: msg, last_error_at: new Date().toISOString(),
              rescan_failed: true }
          : { id:f.id, path:f.path, name:f.name, kind:f.kind, fingerprint:f.fp,
              library_root: (S.dirHandle && S.dirHandle.name) || null,
              size:f.size, mtime:f.mtime, status:"error", error:msg,
              scanned_at:new Date().toISOString(), vision_model:S.roles.scan,
              schema_hash:SCHEMA_HASH(), prompt_hash:PROMPT_HASH() };
        RUN.batch.push(rec);
        IDX.records.set(rec.id, lighten(rec));
        RUN.errorCount++;
        if (RUN.errors.length < 200) RUN.errors.push({ path:f.path, error:msg });
        if (RUN.errorCount < 20 || RUN.errorCount % 25 === 0) renderErrors();
        // If the first handful all fail the same way, the cause is configuration,
        // not the images. Stop rather than burning through the whole library.
        /* Compare the SHAPE of the failure, not the text: every message embeds
           the filename, so "read IMG_1.jpg failed" never matched "read
           IMG_2.jpg failed" and the breaker could not fire for exactly the
           errors that indicate a mount or configuration problem. */
        const shape = msg.replace(/\b[\w .()'-]+\.(jpe?g|png|heic|heif|tiff?|webp|gif|bmp|avif)\b/gi, "<file>")
                         .replace(/\d+/g, "#").slice(0, 120);
        RUN.streak = (RUN.streak && RUN.streakMsg === shape) ? RUN.streak + 1 : 1;
        RUN.streakMsg = shape;
        if (RUN.streak >= 5){
          RUN.stop = true;
          if (RUN.abort) RUN.abort.abort();
          toast("Stopped after 5 failures in a row: " + msg.slice(0,140));
        }
      }
      RUN.pending.delete(f.path);
      RUN.done++;
      if (RUN.batch.length >= S.scan.batchSize) await flushBatch(queue);
      updateProgress();
    }
  }
  try {
    await Promise.all(Array.from({ length: conc }, loop));
  } finally {
    /* A throw here used to skip clearCheckpoint, RUN.active = false, the wake
       lock release and scanUi(false) -- leaving every button disabled and the
       tab nagging on close, for the rest of the document's life. */
    let flushError = null;
    try { await flushBatch(queue, true); } catch (e){ flushError = errText(e); }
    if (flushError){
      RUN.writeError = flushError;
      try { renderErrors(); } catch {}
    }
    const secs = (Date.now() - RUN.started) / 1000;
    try {
      await appendLines("runs.jsonl", [{
        run_id:RUN.runId, mode, started_at:new Date(RUN.started).toISOString(),
        finished_at:new Date().toISOString(), seconds:secs,
        requested:files.length, completed:RUN.done,
        error_count:RUN.errorCount, errors:RUN.errors.slice(0, 100),
        vision_model:S.roles.scan, embed_model:S.roles.embed || null,
        schema_hash:SCHEMA_HASH(), prompt_hash:PROMPT_HASH(),
        stopped: RUN.stop, remaining: queue.length }]);
    } catch (e){ console.warn("runs.jsonl could not be written:", errText(e)); }
    /* Only clear the checkpoint if everything really reached disk. */
    if (!queue.length && !flushError && !RUN.batch.length) await clearCheckpoint();
    /* Back up AFTER the run, never during: a copy taken mid-write would be a
       torn snapshot. Failure here must not fail the scan. */
    /* A pre-scan copy was already taken; a second full copy of a 29MB index
       after retrying three photos is not worth minutes on a slow share. */
    if (S.backup.enabled && RUN.done >= Math.max(S.backup.minNewRecords, 25)){
      try {
        const b = await backupIndex(mode);
        toast("Backed up " + (b.bytes/1048576).toFixed(1) + " MB"
          + (b.pruned ? " (" + b.pruned + " older removed)" : ""));
      } catch (e){ toast("Backup failed: " + errText(e)); }
    }
    RUN.active = false;
    releaseWakeLock();
    scanUi(false);
    updateProgress();
    rebuildDerived();
    if (flushError) toast("Scan ended but the last records could NOT be saved: "
      + flushError + " — they will be found again by the next plan.");
    toast((RUN.stop ? "Stopped" : "Finished") + ": " + RUN.done + "/" + RUN.total
      + " in " + fmtDur(secs) + (RUN.errors.length ? ", " + RUN.errors.length + " errors" : "")
      + (queue.length ? " — " + queue.length + " left, resumable" : ""));
    await refreshPlan();
  }
}

/* Flush = records + vectors + checkpoint, in that order. If the tab dies
   between them the checkpoint is merely stale, never ahead of the data. */
async function flushBatch(queue, force){
  /* Both batches are put back if the write fails. They used to be cleared
     first, so a failed write silently dropped up to 25 finished photos (and
     every embedding) with only a console warning. */
  if (RUN.batch.length){
    const b = RUN.batch.slice();
    try {
      await appendLines("records.jsonl", b);
      RUN.batch = RUN.batch.slice(b.length);
    } catch (e){
      RUN.writeError = errText(e);
      renderErrors();
      throw e;                       // the caller must know records are unsaved
    }
  }
  if (RUN.vecBatch.length){
    const v = RUN.vecBatch.slice();
    try {
      await appendVectors(v);
      RUN.vecBatch = RUN.vecBatch.slice(v.length);
    } catch (e){
      /* Keep them queued for the next flush and make it visible: embeddings
         failing for a whole run used to be invisible, and search then degraded
         to keyword-only with nothing to indicate why. */
      RUN.vecError = errText(e);
      RUN.vecErrorCount = (RUN.vecErrorCount || 0) + v.length;
      renderErrors();
    }
  }
  if (queue){
    await saveCheckpoint({
      run_id:RUN.runId, mode:RUN.mode, started_at:new Date(RUN.started).toISOString(),
      updated_at:new Date().toISOString(),
      pending: queue.map(f => f.path), done:RUN.done, total:RUN.total,
      vision_model:S.roles.scan, schema_hash:SCHEMA_HASH(), prompt_hash:PROMPT_HASH()
    }, force);
  }
}

/* Resume: re-walk, then keep only the paths the checkpoint still lists. */
async function resumeScan(){
  const cp = IDX.checkpoint;
  if (!cp) { toast("Nothing to resume."); return; }
  const plan = S.plan || await buildPlan();
  const byPath = new Map();
  for (const g of ["new","changed","stale","failed","ok"])
    for (const f of plan[g]) byPath.set(f.path, f);
  const sh = SCHEMA_HASH(), ph = PROMPT_HASH();
  const files = cp.pending.map(p => byPath.get(p)).filter(f => {
    if (!f) return false;
    // A stale checkpoint can list photos that were finished after it was written.
    const r = IDX.records.get(f.id);
    if (!r || r.deleted || r.status === "error") return true;
    return r.fingerprint !== f.fp || r.schema_hash !== sh || r.prompt_hash !== ph;
  });
  const gone = cp.pending.length - files.length;
  /* Dropping queued paths silently is how a day of work disappears behind a
     reassuring toast: anything not in the CURRENT plan may simply be out of
     scope, not finished. Say so, and let the user decide. */
  if (gone > 0 && files.length < cp.pending.length * 0.9){
    const go = confirm(gone + " of " + cp.pending.length + " queued photos are not in the "
      + "current plan.\n\nThey may be finished, deleted, or simply outside the current "
      + "scan scope" + (S.scanScope ? " (" + S.scanScope + ")" : "") + ".\n\n"
      + "Resume with the remaining " + files.length + "?\n\n"
      + "Cancel keeps the checkpoint intact so nothing is lost.");
    if (!go) return;
  }
  if (!files.length){ await clearCheckpoint(); toast("Nothing left to resume."); await refreshPlan(); return; }
  toast("Resuming " + files.length + " of " + cp.pending.length + " queued images"
    + (gone ? " (" + gone + " already done or gone)" : ""));
  await runScan(files, cp.mode || "resume", true);
}

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

  /* Reuse a plan that is already current. Walking and stat-ing the library over
     a share is the longest step here by far, and doing it a second time when
     the Scan tab just did it is pure waiting. */
  let plan = (S.plan && !S.planStale && !S.plan.folderLooksEmpty) ? S.plan : null;
  if (plan) await say("Using the current plan (" + plan.total + " photos)…");
  else {
    await say("Finding the originals — this walks the whole folder…");
    /* Pass the progress through. Without it this step says nothing at all for
       however many minutes the walk takes, which is indistinguishable from
       being stuck -- and on a share it IS minutes. */
    plan = await buildPlan(async m => { await say(m); }, signal);
  }
  const files = [];
  for (const g of ["ok","stale","changed","failed","moved"])
    for (const f of plan[g])
      if (!done.has(f.id) && !files.some(x => x.id === f.id)) files.push(f);

  /* Photos already looked at are not looked at again, so this is resumable:
     stop it half way and the next run picks up where it left off. */
  const total = [...IDX.records.values()]
    .filter(r => !r.deleted && r.status !== "error").length;
  return { files, already: done.size, total,
           faces: FACES.faces.size, people: FACES.people.length };
}

async function runFaceScan(files){
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
  updateProgress();

  const queue = files.slice();
  let found = 0, looked = 0;
  /* One at a time: the detector is the bottleneck and it already uses the GPU,
     so overlapping copies fight each other rather than going faster. */
  async function loop(){
    for(;;){
      await waitIfPaused();
      if (RUN.stop) return;
      const f = queue.shift();
      if (!f) return;
      const t0 = performance.now();
      try {
        const file = await withRetry("read " + f.name, () => f.handle.getFile());
        const img = await processImage(file, f.kind, { thumbOnly:false });
        const bmp = await createImageBitmap(img.big);
        try {
          const rows = await detectFacesIn(f.id, bmp);
          found += rows.length;
        } finally { bmp.close(); }
        showCurrent(img.thumb, f.path);
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
  try { await loop(); }
  finally {
    RUN.active = false;
    releaseWakeLock();
    scanUi(false);
    updateProgress();
    renderErrors();
  }
  return { looked, found, failed: RUN.errorCount, stopped: RUN.stop };
}
