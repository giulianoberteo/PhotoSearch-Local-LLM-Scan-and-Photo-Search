
/* ================= scan runner ================= */
const RUN = {
  active:false, paused:false, stop:false, abort:null,
  done:0, total:0, errors:[], times:[], tokens:[],
  started:0, runId:null, batch:[], vecBatch:[], mode:"", pending:null,
  streak:0, streakMsg:null, errorCount:0
};
let wakeLock = null;

async function acquireWakeLock(){
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
  let attemptTokens = S.scan.maxTokens;
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
        if (r.truncated && attemptTokens <= S.scan.maxTokens){
          attemptTokens = Math.min(8000, S.scan.maxTokens * 3);
          note = ""; attempt--;            // the extra try does not count
          continue;
        }
        throw new Error("JSON parse failed"
          + (r.truncated ? " (hit the " + attemptTokens + "-token limit)" : "")
          + ": " + e.message);
      }
      const v = validate(parsed);
      lastParsed = { r, parsed, v };
      if (v.issues.length && attempt === 1){
        note = "Your previous answer had these problems, fix them exactly: " + v.issues.join("; ");
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
  // Spec: if the retry still fails, keep whatever did parse and flag it partial.
  if (!out && lastParsed) out = lastParsed;
  if (!out) throw new Error((lastIssues || ["unknown extraction failure"]).join("; "));

  await saveThumb(f.id, img.thumb);

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
      const o = await ocrPass(S.roles.scan, ocrUrl, signal);
      const joined = o.lines.join("\n");
      // Keep whichever pass actually read more; never regress.
      if (joined.length > (norm.visible_text.text || "").length){
        textLines = o.lines;
        norm.visible_text = { has_text:true, text:joined };
        textSource = "ocr-pass";
      }
      ocrCost = { secs:o.secs, tokens:o.tokens, lines:o.lines.length };
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
    issues: out.v.issues
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
  if (!S.indexChosen && !$("#mock").checked){
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
  if (!(await ensureIndexConnected()) || !(await ensureConnected("the scan"))) return;
  const problem = await preflightScan();
  if (problem){
    scanUi(false);
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
      const pre = await backupIndex("pre-scan safety copy");
      toast("Safety copy taken (" + (pre.bytes/1048576).toFixed(1) + " MB) before scanning.");
    } catch (e){
      const go = confirm("Could not take a safety copy of the existing index:\n\n"
        + errText(e) + "\n\nThe index has " + IDX.records.size + " records. "
        + "Scan anyway?\n\n(Records are only ever appended, so a failed scan "
        + "cannot delete existing ones.)");
      if (!go) return;
    }
  }
  await ensureIndex();
  RUN.active = true; RUN.paused = false; RUN.stop = false;
  RUN.abort = new AbortController();
  RUN.done = 0; RUN.total = files.length; RUN.errors = []; RUN.times = []; RUN.tokens = [];
  RUN.streak = 0; RUN.streakMsg = null; RUN.errorCount = 0;
  RUN.started = Date.now(); RUN.mode = mode;
  RUN.runId = resuming && IDX.checkpoint ? IDX.checkpoint.run_id : "run-" + Date.now();
  RUN.batch = []; RUN.vecBatch = [];
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
        RUN.streak = (RUN.streak && RUN.streakMsg === msg) ? RUN.streak + 1 : 1;
        RUN.streakMsg = msg;
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
    await flushBatch(queue);
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
    } catch {}
    if (!queue.length) await clearCheckpoint();
    /* Back up AFTER the run, never during: a copy taken mid-write would be a
       torn snapshot. Failure here must not fail the scan. */
    if (S.backup.enabled && RUN.done >= S.backup.minNewRecords){
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
    toast((RUN.stop ? "Stopped" : "Finished") + ": " + RUN.done + "/" + RUN.total
      + " in " + fmtDur(secs) + (RUN.errors.length ? ", " + RUN.errors.length + " errors" : "")
      + (queue.length ? " — " + queue.length + " left, resumable" : ""));
    await refreshPlan();
  }
}

/* Flush = records + vectors + checkpoint, in that order. If the tab dies
   between them the checkpoint is merely stale, never ahead of the data. */
async function flushBatch(queue){
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
    });
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
