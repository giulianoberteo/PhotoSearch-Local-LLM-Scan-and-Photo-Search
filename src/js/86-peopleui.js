
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
$("#sFaceTh").oninput = () => {
  S.faces.threshold = +$("#sFaceTh").value;
  $("#sFaceThVal").textContent = S.faces.threshold.toFixed(2);
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
  toast("Re-grouped at " + S.faces.threshold.toFixed(2) + " — "
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
    await st.note("Loading the face model (first run downloads it)…");
    await loadHumanEngine(async m => { await st.note(m); });
    p = await planFaceScan(async m => { await st.note(m); });
  } catch (e){ st.err(errText(e)); toast(errText(e)); return; }

  if (!p.files.length){
    st.ok("All " + p.already + " photos have been looked at already. "
      + FACES.faces.size + " faces found.");
    clusterFaces(); await savePeople(); rebuildDerived();
    renderFaceStale(); renderPeople();
    return;
  }
  if (!confirm("Look for faces in " + p.files.length + " photo"
      + (p.files.length === 1 ? "" : "s") + "?\n\nThis re-reads the originals and "
      + "costs no model time. Roughly "
      + fmtDur(p.files.length * 0.15) + ".\n\nNothing is named automatically.")) return;

  try {
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
    $("#sFaceTh").value = String(S.faces.threshold);
    $("#sFaceThVal").textContent = S.faces.threshold.toFixed(2);
    renderFaceStale();
    renderPeople();
  } catch (e){
    $("#peopleBox").textContent = "";
    $("#peopleBox").append(Object.assign(el("div", "note"), { textContent: errText(e) }));
  } finally { peopleLoading = false; }
}
