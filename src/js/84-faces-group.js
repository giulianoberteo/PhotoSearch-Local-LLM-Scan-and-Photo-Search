/* ---- clustering ----
   Greedy against centroids rather than all-pairs. All-pairs on ~8,000 faces is
   32M comparisons of 1,024 floats, which is minutes; against a few hundred
   centroids it is seconds, and the result is the same in practice because
   faces of one person are tight in this space.

   A NAMED person is authoritative and is never re-clustered away: naming is
   the user's work and re-running this must not destroy it. Unnamed faces are
   matched against named people first, so new photos join "Anna" by themselves. */
function faceCentroid(faceIds){
  const dim = FACES.vec.dim;
  if (!dim) return null;
  const c = new Float32Array(dim);
  let n = 0;
  for (const id of faceIds){
    const v = faceVectorOf(id);
    if (!v) continue;
    for (let i = 0; i < dim; i++) c[i] += v[i];
    n++;
  }
  if (!n) return null;
  for (let i = 0; i < dim; i++) c[i] /= n;
  return faceNormalise(c);
}

/* The two embedders live in different spaces, so a single number cannot serve
   both: ArcFace cosines for one person sit far lower than faceres'. */
function faceThreshold(){
  return S.faces.embedder === "faceres"
    ? S.faces.faceresThreshold : S.faces.threshold;
}

function clusterFaces(threshold){
  const th = threshold != null ? threshold : faceThreshold();
  const dim = FACES.vec.dim;
  if (!dim || !FACES.vec.ids.length){ FACES.clusters = []; return FACES; }
  if (staleFaceEngines().length)
    throw new Error("These face measurements use a different model. A complete set of stored crops or a staged migration from originals is needed before regrouping. Your names are kept.");

  FACES.review = [];
  const constraints = FACES.separations.map(s => ({ a:new Set(s.a), b:new Set(s.b) }));
  const compatible = (id, members) => {
    const photo = FACES.faces.get(id).photo_id;
    if (members.some(mid => FACES.faces.get(mid)?.photo_id === photo)) return false;
    return !constraints.some(s => (s.a.has(id) && members.some(m => s.b.has(m)))
      || (s.b.has(id) && members.some(m => s.a.has(m))));
  };

  const assigned = new Set();
  const seeds = [];
  for (const p of FACES.people){
    p.face_ids = p.face_ids.filter(id => FACES.faces.has(id));
    for (const id of p.face_ids) assigned.add(id);
    const anchors = (p.confirmed_ids || p.face_ids).filter(id => FACES.faces.has(id));
    p.confirmed_ids = anchors.slice();
    // Conflicting history must not become training evidence for more matches.
    const photos = anchors.map(id => FACES.faces.get(id).photo_id);
    if (new Set(photos).size !== photos.length) continue;
    const c = faceCentroid(anchors);
    if (c) seeds.push({ person:p, centroid:c, anchors });
  }

  /* Confident faces first, so a clear photo seeds a group rather than a blur. */
  const rest = FACES.vec.ids.filter(id => !assigned.has(id) && FACES.faces.has(id))
    .sort((a, b) => (FACES.faces.get(b).score || 0) - (FACES.faces.get(a).score || 0));

  const groups = [];
  for (const id of rest){
    const v = faceVectorOf(id);
    if (!v) continue;
    let best = null, bestSim = th;
    const matches = [];
    for (const s of seeds){
      if (!compatible(id, s.person.face_ids) || (s.person.rejected_ids || []).includes(id)) continue;
      const sim = faceDot(v, 0, s.centroid, 0, dim);
      if (sim < th) continue;
      let near = -1;
      for (const mid of s.anchors){
        const mv = faceVectorOf(mid);
        if (!mv) continue;
        const d2 = faceDot(v, 0, mv, 0, dim);
        if (d2 > near) near = d2;
        if (near >= th) break;
      }
      if (near < th) continue;        // never auto-join a person on drift alone
      matches.push({ seed:s, sim });
    }
    matches.sort((a,b) => b.sim - a.sim);
    const lead = matches[0], margin = 0.06;
    if (lead && lead.sim >= Math.min(0.99, th + margin)
        && (!matches[1] || lead.sim - matches[1].sim >= margin)) best = lead.seed;
    else if (lead) FACES.review.push({ face_id:id, person_id:lead.seed.person.id,
      score:lead.sim, reason:matches.length > 1 ? "Looks like more than one person" : "Needs your confirmation" });
    if (best){                                   // joins an existing named person
      best.person.face_ids.push(id);
      continue;
    }
    /* Match the CENTROID and the nearest MEMBER. Centroid-only merging drifts:
       one wrong face moves the centre, which pulls in more wrong faces, and a
       group ends up as a blur of several people. Requiring a close individual
       neighbour as well stops that cascade. */
    let bg = null; bestSim = th;
    for (const g of groups){
      if (!compatible(id, g.face_ids)) continue;
      const sim = faceDot(v, 0, g.centroid, 0, dim);
      if (sim < bestSim) continue;
      let near = -1;
      for (const mid of g.face_ids){
        const mv = faceVectorOf(mid);
        if (!mv) continue;
        const d2 = faceDot(v, 0, mv, 0, dim);
        if (d2 > near) near = d2;
        if (near >= th) break;                  // close enough, stop looking
      }
      if (near < th) continue;
      bestSim = sim; bg = g;
    }
    if (bg){
      bg.face_ids.push(id);
      const c = faceCentroid(bg.face_ids);
      if (c) bg.centroid = c;
    } else {
      groups.push({ id:"c-" + id,
                    face_ids:[id], centroid: faceNormalise(v) });
    }
  }
  /* Biggest groups first: those are the people worth naming. */
  FACES.clusters = groups
    .map(g => ({ id:g.id, face_ids:g.face_ids }))
    .sort((a, b) => b.face_ids.length - a.face_ids.length);
  FACES.clusteredAt = new Date().toISOString();
  rebuildFaceNames();
  return FACES;
}

/* ---- naming, merging, splitting ---- */
function findPerson(id){ return FACES.people.find(p => p.id === id) || null; }
function findCluster(id){ return FACES.clusters.find(c => c.id === id) || null; }

/* Names a cluster (promoting it to a person) or renames an existing person. */
async function namePerson(id, name){
  return editPeople(() => {
  name = String(name || "").trim();
  const existing = findPerson(id);
  if (existing){
    if (!name){                       // clearing a name returns it to unnamed
      FACES.people = FACES.people.filter(p => p !== existing);
      FACES.clusters.unshift({ id: existing.id, face_ids: existing.face_ids });
    } else existing.name = name;
    return existing;
  }
  const c = findCluster(id);
  if (!c) throw new Error("no such group: " + id);
  if (!name) return null;
  FACES.clusters = FACES.clusters.filter(x => x !== c);
  const person = { id: c.id, name, face_ids: c.face_ids.slice(),
                   confirmed_ids:c.face_ids.slice(), rejected_ids:[],
                   named_at: new Date().toISOString() };
  FACES.people.push(person);
  return person;
  });
}

/* Clustering will split one person across two groups; this is the fix. */
async function mergeGroups(intoId, fromId){
  return editPeople(() => {
  if (intoId === fromId) return null;
  const into = findPerson(intoId) || findCluster(intoId);
  const from = findPerson(fromId) || findCluster(fromId);
  if (!into || !from) throw new Error("no such group");
  for (const id of from.face_ids)
    if (!into.face_ids.includes(id)) into.face_ids.push(id);
  // An explicit merge overrides earlier separation decisions for these faces.
  const joined = new Set(into.face_ids);
  FACES.separations = FACES.separations.filter(s =>
    !(s.a.some(id => joined.has(id)) && s.b.some(id => joined.has(id))));
  if (into.name){
    into.confirmed_ids = [...new Set([...(into.confirmed_ids || into.face_ids), ...from.face_ids])];
    into.rejected_ids = (into.rejected_ids || []).filter(id => !joined.has(id));
  }
  FACES.review = FACES.review.filter(r => !joined.has(r.face_id) && r.person_id !== fromId);
  FACES.people = FACES.people.filter(p => p !== from);
  FACES.clusters = FACES.clusters.filter(c => c !== from);
  return into;
  });
}

/* And it will merge two people into one group; this is that fix. */
async function splitOut(groupId, faceIds){
  return editPeople(() => {
  const g = findPerson(groupId) || findCluster(groupId);
  if (!g) throw new Error("no such group");
  const moving = faceIds.filter(id => g.face_ids.includes(id));
  if (!moving.length) return null;
  g.face_ids = g.face_ids.filter(id => !moving.includes(id));
  if (g.face_ids.length) FACES.separations.push({ a:moving.slice(), b:g.face_ids.slice() });
  if (g.name){
    g.rejected_ids = [...new Set([...(g.rejected_ids || []), ...moving])];
    g.confirmed_ids = (g.confirmed_ids || g.face_ids).filter(id => !moving.includes(id));
  }
  FACES.review = FACES.review.filter(r => !moving.includes(r.face_id));
  const fresh = { id: "c-split-" + crypto.randomUUID(), face_ids: moving };
  FACES.clusters.unshift(fresh);
  /* A group emptied by the split disappears rather than lingering as a ghost. */
  if (!g.face_ids.length){
    FACES.people = FACES.people.filter(p => p !== g);
    FACES.clusters = FACES.clusters.filter(c => c !== g);
  }
  return fresh;
  });
}

async function reviewFace(faceId, personId, accept){
  return editPeople(() => {
    const p = findPerson(personId);
    if (!p || !FACES.faces.has(faceId)) throw new Error("That face or person is no longer available.");
    p.confirmed_ids = (p.confirmed_ids || p.face_ids).slice();
    if (accept){
      for (const g of [...FACES.people, ...FACES.clusters]){
        g.face_ids = g.face_ids.filter(id => id !== faceId);
        if (g !== p && g.confirmed_ids) g.confirmed_ids = g.confirmed_ids.filter(id => id !== faceId);
      }
      p.face_ids.push(faceId); p.confirmed_ids.push(faceId);
      p.rejected_ids = (p.rejected_ids || []).filter(id => id !== faceId);
      const joined = new Set(p.face_ids);
      FACES.separations = FACES.separations.filter(s =>
        !(s.a.some(id => joined.has(id)) && s.b.some(id => joined.has(id))));
    } else p.rejected_ids = [...new Set([...(p.rejected_ids || []), faceId])];
    FACES.clusters = FACES.clusters.filter(g => g.face_ids.length);
    FACES.review = FACES.review.filter(r => r.face_id !== faceId);
  });
}

/* Everything, in one action, leaving the rest of the index untouched. */
async function deleteAllFaceData(){
  if (libraryMaintenance) throw new Error("Wait for the backup or restore before deleting face data.");
  /* Drop the cached handle FIRST so nothing re-creates the folder behind the
     removal, then take the whole directory in one call. */
  FACES.dir = null;
  try { await IDX.dir.removeEntry("faces", { recursive:true }); } catch {}
  FACES.faces = new Map(); FACES.byPhoto = new Map(); FACES.namesByPhoto = new Map();
  FACES.vec = { dim:0, ids:[], rows:null, index:new Map() };
  FACES.people = []; FACES.clusters = []; FACES.clusteredAt = null;
  FACES.separations = []; FACES.review = []; FACES.undo = null;
  FACES.loaded = false;
  faceNamesLoaded = false;
  return true;
}

