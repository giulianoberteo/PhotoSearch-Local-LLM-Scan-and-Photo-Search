/* ================= plan UI ================= */
let planAbort = null;
async function refreshPlan(){
  if (!S.dirHandle){
    /* This used to be a silent no-op, while six callers toasted success first
       and left the old numbers on screen. */
    const host = $("#planBox");
    if (host){
      resetChecks(host);
      checksBox(host).append(checkRow({ status:"warn", title:"No folder connected",
        detail:"Press Choose folder, or Reconnect, in Settings." }));
    }
    return;
  }
  const host = $("#planBox");
  if (planAbort) planAbort.abort();
  planAbort = new AbortController();
  const sig = planAbort.signal;
  resetChecks(host);
  const custom = S.indexMode === "custom";
  const idxName = custom ? (S.indexDirHandle ? S.indexDirHandle.name : "(not connected)") : S.dirHandle.name;
  const where = idxName + "/.photoindex" + (custom ? "  \u2014 the index folder you chose" : "  \u2014 beside the photos");
  checksBox(host).append(Object.assign(el("div","hint"), { textContent:
    "Checking photos in '" + S.dirHandle.name + (S.scanExclude.length ? "' (" + S.scanExclude.length + " folders left out)" : "'")
    + (S.scanScope ? ", scope " + S.scanScope : "") + " against the index in " + where
    + ". This only reads: nothing is scanned, sent to a model or changed until you press a scan button." }));
  let st = step(host, "Opening the index");
  try {
    if (!S.models.length && !$("#mock").checked){
      await st.note("Detecting models\u2026");
      await autoConnect();
    }
    if (custom && !S.indexDirHandle && !await ensureIndexConnected())
      throw new Error("Your index folder is not connected. Chrome drops folder access when the page reloads: "
        + "press \u201cChoose where to save the DB\u2026\u201d in Settings and pick it again, or reconnect it from there.");
    await ensureIndex(null, { write:false });
    await st.note("Waking the drive\u2026");
    await wakeStorage(m => st.note(m));
    st.ok(((await indexParent()).name) + "/.photoindex" + (custom ? "  \u2014 the index folder you chose" : "  \u2014 beside the photos"));
    if (!IDX.loaded){
      st = step(host, "Loading what is already in the index");
      await loadRecords((pct, n) => st.note("Reading records\u2026 " + pct + "% (" + n + " so far)"));
      await loadVectors();
      await loadCheckpoint();
      if (GEO.state === "none" && await geoCached()) { /* place names ready */ }
      st.ok(IDX.records.size + " records, one per photo scanned before");
    }
    st = step(host, "Listing the photos in the folder");
    const t0 = performance.now();
    const p = await buildPlan(m => {
      if (/^Walking/.test(m)) st.note(m.replace(/^Walking [^:]*: /, "Looking through the folder and its subfolders: ") + " found so far\u2026");
      else if (/^Reading file details/.test(m)) st.note(m.replace("Reading file details: ", "Reading each file's size and date: "));
      else st.note(m);
    }, sig);
    st.ok(p.total + " photos found in " + fmtDur((performance.now() - t0) / 1000)
      + (p.counts.skippedDirs ? " (" + p.counts.skippedDirs + " hidden folders skipped)" : "")
      + (p.counts.excludedDirs ? " (" + p.counts.excludedDirs + " folders left out by you)" : ""));
    st = step(host, "Matching them to the index");
    await st.paint();
    if (p.moved.length){
      const n = await applyMoves(p.moved);
      st.note(n + " file(s) re-linked without re-scanning…");
      p.moved = [];          // they keep whatever category they were classified into
    }
    rebuildDerived();
    S.planStale = false;
    await ensureFaceNames();        // so names are searchable without opening People
    st.ok(p.new.length + " new, " + p.ok.length + " already known"
      + (p.moved.length ? ", " + p.moved.length + " moved" : "")
      + (p.missing.length ? ", " + p.missing.length + " in the index but no longer in the folder" : ""));
    /* This used to say "everything will look new -- use a separate index per
       library", which was true only before photos were matched by content.
       They are now, so adding a second folder to one index is a supported
       thing to do and anything already scanned is recognised wherever it sits.
       What is worth saying is which folder the index was last built from. */
    if (IDX.rootMismatch && !S.scanScope)
      checksBox($("#planBox")).append(checkRow({ status:"ok",
        title:"Adding a second folder to this index",
        detail:"This index was last built from '" + IDX.rootMismatch.was
          + "'; you have opened '" + IDX.rootMismatch.now + "'. Photos are matched "
          + "by content, so anything already scanned is recognised and only genuinely "
          + "new photos are queued. Nothing in the existing index is touched." }));
    renderPlan(p);
  } catch (e){
    if (e.name === "AbortError") return;
    st.err(humanError(e));
    /* A failed refresh must invalidate the plan, not leave live buttons
       pointing at dead file handles. */
    S.planStale = true;
    ["btnScan","btnStale","btnFull","btnRetry","btnMissing"]
      .forEach(id => { const n = $("#" + id); if (n) n.disabled = true; });
  }
}
function renderPlan(p){
  const host = $("#planBox");
  const box = el("div");
  const stat = el("div","stat");
  const TIPS = { "new":"Not in the index yet: a scan would read these.",
    "changed":"The file was edited or replaced since it was scanned.",
    "stale":"Scanned with an older schema, prompt or model than the current one.",
    "failed":"A previous scan of these did not work. Retry failed tries them again.",
    "missing":"In the index but not found in this folder (moved elsewhere, deleted, or another folder is connected).",
    "up to date":"Already in the index and unchanged: nothing to do." };
  const cell = (n, label) => { const d = el("div"); if (TIPS[label]) d.title = TIPS[label];
    d.append(el("b", null, String(n))); d.append(el("span", null, label)); return d; };
  stat.append(cell(p.total, p.scope ? "images in scope" : "images"));
  stat.append(cell(p.new.length, "new"));
  stat.append(cell(p.changed.length, "changed"));
  stat.append(cell(p.stale.length, "stale"));
  stat.append(cell(p.failed.length, "failed"));
  stat.append(cell(p.missing.length, "missing"));
  stat.append(cell(p.ok.length, "up to date"));
  box.append(stat);
  box.append(Object.assign(el("div","hint"), { textContent:
    "Counts: new = not scanned yet · changed = edited since scanned · stale = scanned with an older model or prompt · "
    + "failed = a scan did not work · missing = in the index, not in this folder · up to date = nothing to do. "
    + "Hover a number for details." }));
  const c = p.counts;
  const bits = [];
  if (c.rawPaired) bits.push(c.rawPaired + " RAW beside a JPEG, not scanned twice");
  if (c.video) bits.push(c.video + " video skipped");
  if (c.vector) bits.push(c.vector + " vector/PDF skipped");
  if (p.unreadable.length) bits.push(p.unreadable.length + " unreadable");
  if (c.skippedDirs) bits.push(c.skippedDirs + " hidden folders skipped");
  if (c.excludedDirs) bits.push(c.excludedDirs + " folder" + (c.excludedDirs === 1 ? "" : "s") + " left out by you");
  bits.push(p.scope ? ("scope: " + p.scope + " — index holds " + p.indexTotal
    + " photos from the whole library") : "scope: whole library");
  if (RUN.vecError)
    box.append(Object.assign(el("div","note"), { textContent:
      "Some embeddings could not be saved (" + RUN.vecError + "). Those photos are "
      + "searchable by keyword only until you run Re-embed." }));
  if (IDX.vecRealigned)
    box.append(Object.assign(el("div","note"), { textContent:
      "The vector index was realigned on load (" + IDX.vecRealigned.rows + " rows vs "
      + IDX.vecRealigned.ids + " ids), which means an interrupted write. Run Re-embed "
      + "to be certain every photo has the right embedding." }));
  if (S.rolesUnavailable && Object.keys(S.rolesUnavailable).length)
    box.append(Object.assign(el("div","note"), { textContent:
      "LM Studio is not currently offering: "
      + Object.values(S.rolesUnavailable).join(", ")
      + ". Your choice has been kept — load the model, then press Test connection." }));
  if (DERIVED.stats && DERIVED.stats.photos && !DERIVED.stats.embedded)
    box.append(Object.assign(el("div","note"), { textContent:
      "No embeddings yet: search will be keyword-only. Pick an embedding model under "
      + "Model roles, then run Re-embed or Refresh stale." }));
  if (DERIVED.stats && DERIVED.stats.withGps && GEO.state !== "ready")
    box.append(Object.assign(el("div","note"), { textContent:
      "Photos have GPS but no place names. Press 'Get place names' in Settings." }));
  if (DERIVED.stats) bits.push(DERIVED.stats.embedded + " embedded · "
    + DERIVED.stats.events + " events · " + DERIVED.stats.entities + " entities · "
    + DERIVED.stats.withText + " with text ("
    + Math.round((DERIVED.stats.textChars || 0) / 1000) + "k chars)");
  box.append(Object.assign(el("div","hint"), { textContent: bits.join(" · ") }));
  const todo = p.new.length + p.changed.length + p.failed.length;
  const avg = avgSecs(), conc = Math.max(1, Math.min(4, S.scan.concurrency));
  /* "Everything is up to date" is true but useless when you have just pointed
     at a NEW folder and the Scan button is greyed out: it does not say whether
     nothing was found, or everything found was already known. Say which. */
  const recognised = p.ok.length + p.moved.length;
  const why = p.total === 0
    ? "No images found in this folder, so there is nothing to scan."
      + (c.raw || c.video || c.vector
         ? "  It does contain files this app skips ("
           + [c.raw && c.raw + " RAW", c.video && c.video + " video",
              c.vector && c.vector + " vector/PDF"].filter(Boolean).join(", ") + ")."
         : "  Check you picked the right folder — subfolders are included, "
           + "but hidden folders are skipped.")
    : recognised >= p.total
      ? "All " + p.total + " images here are already in the index, so there is "
        + "nothing new to scan. Photos are matched by their content, so copies and "
        + "photos that have moved are recognised rather than scanned again."
        + (p.moved.length ? "  " + p.moved.length + " were found at a new path." : "")
      : "Everything is up to date.";
  box.append(Object.assign(el("div","hint"), { textContent: todo
    ? "Scan new & changed: " + todo + " images, about " + fmtDur(todo*avg/conc)
      + " at " + avg.toFixed(0) + "s each."
      + (p.stale.length ? "  " + p.stale.length + " stale (schema/prompt/model changed)." : "")
    : why }));
  /* A greyed-out button with no reason is the actual complaint. Name the one
     action that still does something. */
  if (!todo && p.total > 0)
    box.append(Object.assign(el("div","hint"), { textContent:
      "\u201cFull rescan\u201d would re-scan all " + p.total + " from scratch, at model "
      + "cost. \u201cRefresh stale\u201d re-does only what the schema or model changed."
      }));
  if (DERIVED.stats && DERIVED.stats.dateSuspect)
    box.append(Object.assign(el("div","hint"), { textContent:
      DERIVED.stats.dateSuspect + " photos have a date but no camera tags — the date may be an "
      + "export time rather than when it was taken. Use a date override in Settings to correct a folder." }));
  host.append(box);
  if (IDX.checkpoint){
    const w = el("div","note");
    w.append(el("b", null, "Interrupted scan found. "));
    w.append(document.createTextNode(IDX.checkpoint.pending.length + " images were still queued from "
      + (IDX.checkpoint.updated_at || "").slice(0,19).replace("T"," ") + "."));
    const b = el("button","btn"); b.textContent = "Resume"; b.style.marginLeft = "10px";
    b.onclick = () => resumeScan();
    w.append(b);
    host.append(w);
  }
  $("#btnScan").disabled   = todo === 0;
  $("#btnStale").disabled  = p.stale.length === 0;
  $("#btnFull").disabled   = p.total === 0;
  $("#btnRetry").disabled  = p.failed.length === 0;
  $("#btnMissing").disabled = p.missing.length === 0;
  $("#sCount").textContent = p.total + " photos";
}
function avgSecs(){
  const done = [...IDX.records.values()].filter(r => r.secs).map(r => r.secs);
  const pool = RUN.times.length ? RUN.times : done;
  if (!pool.length) return S.scan.estSecs;
  return pool.slice(-40).reduce((a,b) => a+b, 0) / Math.min(pool.length, 40);
}

