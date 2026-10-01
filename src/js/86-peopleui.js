
/* ================= the People tab =================
   Groups of faces that look alike, and a box to type a name into. The app
   proposes nothing: a group is "Group 1" until you say otherwise. */

const PUI = { open: null, picked: new Set(), mergeFrom: null };

/* A face tile is the photo's existing thumbnail, zoomed to the face box. No
   crops are stored: the box is kept in 0..1 so it maps onto any size, which
   saves one file per face and a whole write path. object-fit:fill means the
   zoom stays linear in those coordinates, at the cost of a little stretch on a
   non-square thumbnail -- acceptable at 64px, and it never misses the face. */
function faceTile(face, cls){
  const d = el("div", "facetile" + (cls ? " " + cls : ""));
  if (!face) return d;
  const im = el("img");
  im.alt = "";
  const [x, y, w, h] = face.box || [0, 0, 1, 1];
  const zoom = Math.max(1, Math.min(9, 1 / Math.max(w, h, 0.02)));
  im.style.transformOrigin = ((x + w / 2) * 100).toFixed(2) + "% "
                           + ((y + h / 2) * 100).toFixed(2) + "%";
  im.style.transform = "scale(" + zoom.toFixed(2) + ")";
  thumbUrl(face.photo_id).then(u => { if (u) im.src = u; });
  thumbPin(face.photo_id);
  d.append(im);
  return d;
}

function bestFaceOf(group){
  let best = null;
  for (const id of group.face_ids){
    const f = FACES.faces.get(id);
    if (!f) continue;
    if (!best || (f.score || 0) > (best.score || 0)) best = f;
  }
  return best;
}

function groupLabel(g, i){
  return g.name || ("Group " + (i + 1));
}

function renderPeople(){
  const box = $("#peopleBox");
  box.textContent = "";
  const all = [...FACES.people, ...FACES.clusters];
  if (!all.length){
    box.append(Object.assign(el("span", "dim"), { textContent: FACES.faces.size
      ? "No groups yet — press Re-group."
      : "No faces found yet. Press “Find faces”." }));
    return;
  }
  $("#faceNote").textContent = FACES.faces.size + " faces in "
    + FACES.people.length + " named "
    + (FACES.people.length === 1 ? "person" : "people") + " and "
    + FACES.clusters.length + " unnamed group"
    + (FACES.clusters.length === 1 ? "" : "s")
    + ". Type a name to label a group; it becomes searchable straight away."
    + "  If people are mixed together, raise the strictness and re-group — it is "
    + "instant and keeps your names.";
  const rep = faceSizeReport();
  if (rep && rep.belowPct >= 25)
    $("#faceNote").textContent += "  " + rep.belowPct + "% of faces are smaller than the "
      + "112px the model reads (median " + rep.median + "px), so they were enlarged and "
      + "the detail was never there — “Improve from originals” fixes that.";
  else if (rep)
    $("#faceNote").textContent += "  Median face " + rep.median + "px; "
      + rep.belowPct + "% below the model's 112px input.";

  const grid = el("div", "people");
  all.forEach((g, i) => {
    const named = !!g.name;
    const card = el("div", "pcard" + (PUI.mergeFrom === g.id ? " sel" : ""));
    const top = el("div", "top");
    top.append(faceTile(bestFaceOf(g)));
    const right = el("div");
    right.style.flex = "1";
    right.style.minWidth = "0";
    const inp = el("input");
    inp.type = "text";
    inp.value = g.name || "";
    inp.placeholder = named ? "" : "Name this group…";
    inp.onchange = async () => {
      try {
        await namePerson(g.id, inp.value);
        rebuildDerived();                 // names are searchable text
        renderPeople();
        toast(inp.value ? "Named " + inp.value + "." : "Name cleared.");
      } catch (e){ toast(errText(e)); }
    };
    right.append(inp);
    right.append(Object.assign(el("div", "hint"),
      { textContent: g.face_ids.length + " face"
        + (g.face_ids.length === 1 ? "" : "s") }));
    top.append(right);
    card.append(top);

    const acts = el("div", "acts");
    const view = el("button", null, PUI.open === g.id ? "Hide faces" : "Show faces");
    view.onclick = () => { PUI.open = PUI.open === g.id ? null : g.id;
      PUI.picked.clear(); renderPeople(); };
    acts.append(view);

    const photos = el("button", null, "Photos");
    photos.onclick = () => showPersonPhotos(g, groupLabel(g, i));
    acts.append(photos);

    if (PUI.mergeFrom && PUI.mergeFrom !== g.id){
      const m = el("button", null, "Merge into this");
      m.onclick = async () => {
        try {
          await mergeGroups(g.id, PUI.mergeFrom);
          PUI.mergeFrom = null; rebuildDerived(); renderPeople();
          toast("Merged.");
        } catch (e){ toast(errText(e)); }
      };
      acts.append(m);
    } else {
      const m = el("button", null, PUI.mergeFrom === g.id ? "Cancel merge" : "Merge…");
      m.onclick = () => { PUI.mergeFrom = PUI.mergeFrom === g.id ? null : g.id;
        renderPeople(); };
      acts.append(m);
    }
    card.append(acts);

    if (PUI.open === g.id){
      const strip = el("div", "facestrip");
      for (const fid of g.face_ids){
        const f = FACES.faces.get(fid);
        if (!f) continue;
        const t = faceTile(f, PUI.picked.has(fid) ? "pick" : "");
        t.title = "Select to move this face out of the group";
        t.onclick = () => {
          PUI.picked.has(fid) ? PUI.picked.delete(fid) : PUI.picked.add(fid);
          renderPeople();
        };
        strip.append(t);
      }
      card.append(strip);
      const picked = g.face_ids.filter(id => PUI.picked.has(id));
      const sp = el("div", "acts");
      const b = el("button", null, "Move " + picked.length + " out to a new group");
      b.disabled = !picked.length;
      b.onclick = async () => {
        try {
          await splitOut(g.id, picked);
          PUI.picked.clear(); rebuildDerived(); renderPeople();
          toast("Moved " + picked.length + " face"
            + (picked.length === 1 ? "" : "s") + " out.");
        } catch (e){ toast(errText(e)); }
      };
      sp.append(b);
      card.append(sp);
    }
    grid.append(card);
  });
  box.append(grid);
}

function showPersonPhotos(g, label){
  const ids = new Set();
  for (const fid of g.face_ids){
    const f = FACES.faces.get(fid);
    if (f) ids.add(f.photo_id);
  }
  const recs = [...ids].map(id => IDX.records.get(id)).filter(Boolean)
    .sort((a, b) => (b.date_taken || "").localeCompare(a.date_taken || ""));
  const host = $("#faceOut");
  host.textContent = "";
  if (!recs.length){
    host.append(Object.assign(el("span", "dim"),
      { textContent: "Those photos are not in the open folder." }));
    return;
  }
  renderGrid(host, recs.slice(0, 120), label + " — " + recs.length
    + " photo" + (recs.length === 1 ? "" : "s")
    + (recs.length > 120 ? " (showing 120)" : ""));
}

/* Vectors built by an earlier configuration describe pose rather than identity,
   so they cannot be salvaged by re-grouping -- they have to be recomputed. Say
   that plainly instead of letting the groups look merely bad. */
function renderFaceStale(){
  const box = $("#faceStale");
  const stale = staleFaceEngines();
  if (!stale.length){ box.hidden = true; box.textContent = ""; return; }
  box.hidden = false;
  box.textContent = "";
  box.append(el("b", null, "These faces were measured the old way. "));
  box.append(document.createTextNode(
    "They were described without landmark alignment (" + stale.join(", ")
    + "), which encodes the angle of the head rather than who it is — which is "
    + "why groups mixed people together. Re-grouping cannot fix it; the faces "
    + "have to be looked at again. Delete the face data and press Find faces."));
  const b = el("button", "btn");
  b.textContent = "Delete face data and start again";
  b.style.marginTop = "8px";
  b.onclick = async () => {
    try {
      await deleteAllFaceData();
      rebuildDerived(); renderFaceStale(); renderPeople();
      toast("Face data deleted — press Find faces.");
    } catch (e){ toast(errText(e)); }
  };
  box.append(el("div"));
  box.append(b);
}

/* ---- actions ---- */
$("#sFaceEmb").onchange = async () => {
  S.faces.embedder = $("#sFaceEmb").value;
  saveSettings();
  faceThRange();
  renderFaceStale();
  toast(S.faces.embedder === "arcface"
    ? "ArcFace: a purpose-built recognition model. Press \u201cRe-measure\u201d to apply it "
      + "to the faces already found — it uses the stored crops, so no photo is re-read."
    : "faceres: kept for comparison only. It is a by-product of age/gender estimation.");
};

$("#btnRefine").onclick = async () => {
  if (!(await ensureIndexConnected()) || !(await ensureConnected("the improvement pass"))) return;
  if (RUN.active){ toast("Stop the scan first."); return; }
  const host = $("#faceOut"); resetChecks(host);
  const st = step(host, "Improve from originals");
  let p;
  try {
    await st.note("Loading the models…");
    await loadHumanEngine(async m => { await st.note(m); });
    if (S.faces.embedder !== "faceres") await loadArcFace(async m => { await st.note(m); });
    p = await planFaceRefine(async m => { await st.note(m); });
  } catch (e){ st.err(errText(e)); return; }

  if (!FACES.faces.size){
    st.warn("There are no faces yet — press “Find faces” first. This pass improves "
      + "faces that have already been found, it does not find them.");
    return;
  }
  if (!p.candidates){
    st.ok("All " + FACES.faces.size + " faces already came from full-size originals.");
    return;
  }
  if (!p.files.length){
    st.warn(p.candidates + " photos have faces taken from thumbnails, but none of those "
      + "photos are in the folder you have open. Connect the folder they live in "
      + "(Settings) and try again.");
    return;
  }
  const unit = storageUnitMs();
  const secs = (p.bytes / (430*1024) + p.files.length * ((unit != null ? unit : 50)/1000))
    / Math.max(1, Math.min(8, S.faces.readConcurrency)) + p.files.length * 0.08;
  if (!confirm("Re-read " + p.files.length.toLocaleString() + " photos that contain faces, "
      + "at full size?\n\n" + (p.bytes/1073741824).toFixed(1) + " GB, roughly "
      + fmtDur(secs) + ".\n\nA face from a 384px thumbnail is usually smaller than the "
      + "112px the model reads, so it was enlarged and the detail was never there. This "
      + "replaces those with faces measured from the originals.\n\nThe names you have "
      + "assigned are carried across."
      + (p.notInFolder ? "\n\n" + p.notInFolder + " are in another folder and will be "
          + "skipped." : ""))) return;

  try {
    await st.note("Improving " + p.files.length.toLocaleString() + " photos…");
    const r = await runFaceRefine(p.files);
    if (!r) return;
    clusterFaces(); await savePeople(); rebuildDerived();
    renderFaceStale(); renderPeople();
    const bits = [r.improved + " photos re-read", r.found + " faces measured at full size"];
    if (r.remapped) bits.push(r.remapped + " names carried across");
    if (r.failed) bits.push(r.failed + " could not be read");
    if (r.stopped) bits.push("stopped early — press again to carry on");
    (r.failed || r.stopped ? st.warn : st.ok)(bits.join(", ") + ".");
  } catch (e){ st.err(errText(e)); }
};

$("#btnReembed").onclick = async () => {
  if (!FACES.faces.size){ toast("Press Find faces first."); return; }
  const host = $("#faceOut"); resetChecks(host);
  const st = step(host, "Re-measure faces");
  try {
    const r = await reembedFromCrops(async m => { await st.note(m); });
    rebuildDerived(); renderFaceStale(); renderPeople();
    (r.missing ? st.warn : st.ok)(r.measured + " faces re-measured with "
      + faceEngineId() + (r.missing ? ", " + r.missing + " had no stored crop" : "")
      + ". No photo was re-read.");
  } catch (e){ st.err(errText(e)); }
};

$("#btnCompare").onclick = async () => {
  const host = $("#faceOut"); resetChecks(host);
  const st = step(host, "Compare on your named people");
  try {
    const r = await compareEmbedders(async m => { await st.note(m); });
    const box = el("div");
    box.append(Object.assign(el("div","hint"), { textContent:
      "Measured on " + r.faces + " faces across " + r.people + " people you named. "
      + "Higher separability groups better." }));
    const t = el("table"); t.style.fontSize = "12.5px"; t.style.marginTop = "8px";
    const row = (cells, head) => {
      const tr = el("tr");
      for (const c of cells){
        const td = el(head ? "th" : "td", null, String(c));
        td.style.textAlign = "left"; td.style.padding = "3px 12px 3px 0";
        tr.append(td);
      }
      t.append(tr);
    };
    row(["model","same person","different people","separability","suggested"], true);
    for (const [label, sc] of [["ArcFace (buffalo_s)", r.arcface],
                               ["currently stored", r.current]]){
      if (!sc) continue;
      row([label, sc.samePerson, sc.differentPeople, sc.separability,
           sc.suggestedThreshold]);
    }
    box.append(t);
    if (r.arcface && r.current){
      const better = r.arcface.separability > r.current.separability;
      box.append(Object.assign(el("div","hint"), { textContent: better
        ? "ArcFace separates your people better. Set the model to ArcFace, press "
          + "Re-measure, then set strictness to " + r.arcface.suggestedThreshold + "."
        : "On your photos the stored vectors separate at least as well. Keeping them "
          + "is reasonable; try strictness " + r.current.suggestedThreshold + "." }));
    }
    $("#faceOut").append(box);
    st.ok("Done — see the table.");
  } catch (e){ st.err(errText(e)); }
};

$("#btnFacesPause").onclick = () => {
  RUN.paused = !RUN.paused;
  $("#btnFacesPause").textContent = RUN.paused ? "Resume" : "Pause";
  $("#btnPause").textContent = $("#btnFacesPause").textContent;
  if (RUN.paused) releaseWakeLock(); else acquireWakeLock();
};
$("#btnFacesStop").onclick = () => {
  RUN.stop = true; RUN.paused = false;
  if (RUN.abort) RUN.abort.abort();
  toast("Stopping — what has been found is kept, and it resumes from here.");
};

$("#sFaceSrc").onchange = () => {
  S.faces.source = $("#sFaceSrc").value;
  saveSettings();
  toast(S.faces.source === "thumbs"
    ? "Reading thumbnails: much faster, and misses faces that are small in the frame."
    : "Reading originals: finds smaller faces, but re-reads every photo in full.");
};
function faceThSet(v){
  if (S.faces.embedder === "faceres") S.faces.faceresThreshold = v;
  else S.faces.threshold = v;
}
/* The two embedders occupy different ranges, so one fixed slider cannot serve
   both: the old 0.50 floor could not even express ArcFace's working range, and
   setting 0.42 clamped silently up to 0.50. */
function faceThRange(){
  const sl = $("#sFaceTh");
  if (S.faces.embedder === "faceres"){ sl.min = "0.50"; sl.max = "0.95"; }
  else { sl.min = "0.20"; sl.max = "0.80"; }
  sl.step = "0.01";
  sl.value = String(faceThreshold());
  $("#sFaceThVal").textContent = faceThreshold().toFixed(2);
}
$("#sFaceTh").oninput = () => {
  faceThSet(+$("#sFaceTh").value);
  $("#sFaceThVal").textContent = faceThreshold().toFixed(2);
};
$("#sFaceTh").onchange = async () => {
  saveSettings();
  if (!FACES.vec.ids.length) return;
  /* Instant: the vectors are already on disk, so trying a different strictness
     costs nothing and never re-reads a photo. */
  clusterFaces();
  await savePeople();
  rebuildDerived();
  renderPeople();
  toast("Re-grouped at " + faceThreshold().toFixed(2) + " — "
    + FACES.clusters.length + " unnamed groups. Names were kept.");
};
$("#btnFaceScan").onclick = async () => {
  if (!(await ensureIndexConnected()) || !(await ensureConnected("the face scan"))) return;
  if (RUN.active){ toast("Stop the scan first."); return; }
  const host = $("#faceOut"); resetChecks(host);
  const st = step(host, "Find faces");
  /* Do not leave "No faces found yet" sitting under a running step: it reads
     as a result rather than a stale label. */
  $("#peopleBox").textContent = "";
  $("#peopleBox").append(Object.assign(el("span", "dim"),
    { textContent: "Working — watch the line above. Walking a large folder over "
      + "a network share can take several minutes before any photo is read." }));
  let p;
  try {
    await st.note("Loading the face models (first run downloads them)…");
    await loadHumanEngine(async m => { await st.note(m); });
    if (S.faces.embedder !== "faceres")
      await loadArcFace(async m => { await st.note(m); });
    p = await planFaceScan(async m => { await st.note(m); });
  } catch (e){ st.err(errText(e)); toast(errText(e)); return; }

  if (!p.files.length){
    st.ok("All " + p.already.toLocaleString() + " of " + p.total.toLocaleString()
      + " photos have been looked at already — " + FACES.faces.size + " faces found."
      + (p.notInFolder ? "  " + p.notInFolder + " are not in the folder you have open; "
         + "switch \u2018Read from\u2019 to Thumbnails to cover the whole index." : ""));
    clusterFaces(); await savePeople(); rebuildDerived();
    renderFaceStale(); renderPeople();
    return;
  }
  /* The old estimate was 0.15s per photo -- the cost of DETECTION, which is
     8-19ms, not of getting the pixels off the share. Reading is the whole job:
     size it from the measured storage speed and the bytes actually involved. */
  const thumbs = S.faces.source !== "originals";
  const bytes = thumbs
    ? p.files.length * 33 * 1024
    : p.files.reduce((a, f) => a + (f.size || 2.2 * 1048576), 0);
  const unit = storageUnitMs();
  const perFile = unit != null ? unit / 1000 : 0.05;       // latency per open
  const rate = 430 * 1024;                                  // measured on this share
  const conc = Math.max(1, Math.min(8, S.faces.readConcurrency));
  const secs = (bytes / rate + p.files.length * perFile) / conc + p.files.length * 0.02;
  if (!confirm("Look for faces in " + p.files.length + " photo"
      + (p.files.length === 1 ? "" : "s") + "?\n\n"
      + (thumbs
          ? "Reading the " + (bytes / 1048576).toFixed(0) + " MB of thumbnails already "
            + "in the index, not the originals."
          : "Re-reading " + (bytes / 1073741824).toFixed(1) + " GB of originals — accurate, "
            + "but slow over a network share.")
      + "\n\nRoughly " + fmtDur(secs) + ". No model time is used.\n\n"
      + "Nothing is named automatically.")) return;

  try {
    await st.note("Looking at " + p.files.length.toLocaleString() + " of "
      + p.total.toLocaleString() + " photos in " + (p.scope || "the index") + "…");
    const r = await runFaceScan(p.files);
    if (!r) return;
    await st.note("Grouping " + FACES.faces.size + " faces…");
    clusterFaces();
    await savePeople();
    rebuildDerived();
    renderFaceStale();
    renderPeople();
    const bits = [r.looked + " looked at", r.found + " faces found",
      FACES.clusters.length + FACES.people.length + " groups"];
    if (r.fromThumb) bits.push(r.fromThumb + " read from thumbnails");
    if (r.failed) bits.push(r.failed + " could not be read");
    if (r.stopped) bits.push("stopped early — press Find faces again to carry on");
    (r.failed || r.stopped ? st.warn : st.ok)(bits.join(", ") + ".");
  } catch (e){ st.err(errText(e)); toast(errText(e)); }
};

$("#btnRecluster").onclick = async () => {
  if (!FACES.loaded){ toast("Press Find faces first."); return; }
  const host = $("#faceOut"); resetChecks(host);
  const st = step(host, "Re-group");
  try {
    clusterFaces();
    await savePeople();
    rebuildDerived();
    renderPeople();
    st.ok(FACES.people.length + " named, " + FACES.clusters.length
      + " unnamed. Names you gave were kept.");
  } catch (e){ st.err(errText(e)); }
};

$("#btnFaceWipe").onclick = async () => {
  if (!confirm("Delete ALL face data?\n\nEvery face vector, group and name you "
    + "assigned is removed from .photoindex/faces/. Your photos, captions, dates "
    + "and search index are not touched.\n\nThis cannot be undone.")) return;
  try {
    await deleteAllFaceData();
    rebuildDerived();
    $("#faceOut").textContent = "";
    $("#faceNote").textContent = "All face data deleted.";
    renderPeople();
    toast("Face data deleted.");
  } catch (e){ toast(errText(e)); }
};

let peopleLoading = false;
async function onPeopleShown(){
  if (peopleLoading || FACES.loaded) { renderPeople(); return; }
  peopleLoading = true;
  try {
    if (!S.dirHandle && !S.indexDirHandle){
      $("#peopleBox").textContent = "";
      $("#peopleBox").append(Object.assign(el("span", "dim"),
        { textContent: "Connect a folder in Settings first." }));
      return;
    }
    await ensureIndex(null, { write:false });
    if (!IDX.loaded) await loadRecords();
    await loadFaces();
    if (FACES.faces.size && !FACES.people.length && !FACES.clusters.length)
      clusterFaces();
    $("#sFaceSrc").value = S.faces.source;
    $("#sFaceEmb").value = S.faces.embedder;
    faceThRange();
    renderFaceStale();
    renderPeople();
  } catch (e){
    $("#peopleBox").textContent = "";
    $("#peopleBox").append(Object.assign(el("div", "note"), { textContent: errText(e) }));
  } finally { peopleLoading = false; }
}
