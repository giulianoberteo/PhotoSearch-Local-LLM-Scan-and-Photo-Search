/* Regressions use synthetic vectors and OPFS only, never the personal library. */
async function consumerSelfTest(scratch){
  const keep = { records:IDX.records, vec:IDX.vec, settings:{ ...S.faces },
    roles:{ ...S.roles }, backup:{ ...S.backup }, dir:IDX.dir };
  const rejected = async fn => { try { await fn(); return false; } catch { return true; } };
  try {
    await deleteAllFaceData();
    S.faces.embedder = "arcface"; S.faces.threshold = 0.7;

    /* ---- face vectors must append, and must not publish before committing ----
       Rewriting the whole file per face is quadratic: at 5,247 faces that is
       ~5 MB per face, about 17 hours on a 430 KB/s share. And publishing memory
       before the write succeeded meant one failure made every later write
       longer, so the run produced 2,951 crops beside no vectors at all. */
    {
      const dim = 8;
      const vec = seed => Float32Array.from(
        Array.from({ length:dim }, (_, i) => Math.sin(seed * 3.7 + i)));
      await deleteAllFaceData();
      const dir = await facesDir();
      const binSize = async () => {
        try { return (await (await dir.getFileHandle("facevecs.bin")).getFile()).size; }
        catch { return 0; }
      };
      await appendFaceVectors([{ id:"fv-1", vec: vec(1) }]);
      eq("one face writes one row", await binSize(), dim * 4);
      await appendFaceVectors([{ id:"fv-2", vec: vec(2) }]);
      eq("a second face appends a second row", await binSize(), 2 * dim * 4);
      eq("and memory agrees with the file", FACES.vec.ids.length, 2);

      for (let i = 3; i <= 8; i++) await appendFaceVectors([{ id:"fv-" + i, vec: vec(i) }]);
      eq("eight rows on disk", await binSize(), 8 * dim * 4);
      eq("and eight ids", FACES.vec.ids.length, 8);
      ok("every vector reads back", [1,4,8].every(i => !!faceVectorOf("fv-" + i)));

      /* Measure the bytes actually WRITTEN, not the resulting file size: a full
         rewrite and an append leave an identical file, so size cannot tell them
         apart. This is the assertion that detects the quadratic behaviour. */
      {
        const realDir = await facesDir();
        let wrote = 0, keptExisting = null;
        const spy = {
          async getFileHandle(name, o){
            const fh = await realDir.getFileHandle(name, o);
            if (name !== "facevecs.bin") return fh;
            return { getFile: () => fh.getFile(),
              async createWritable(opts){
                keptExisting = !!(opts && opts.keepExistingData);
                const w = await fh.createWritable(opts);
                return { seek: pos => w.seek(pos),
                  write(d){
                    wrote += (d && d.byteLength != null) ? d.byteLength
                           : (d && d.size) || 0;
                    return w.write(d);
                  },
                  close: () => w.close(), abort: () => w.abort() };
              } };
          },
          getDirectoryHandle: (n, o) => realDir.getDirectoryHandle(n, o),
          removeEntry: (n, o) => realDir.removeEntry(n, o),
          entries: () => realDir.entries(), keys: () => realDir.keys(),
          values: () => realDir.values()
        };
        FACES.dir = spy;
        await appendFaceVectors([{ id:"fv-measured", vec: vec(42) }]);
        FACES.dir = realDir;
        eq("adding one face writes exactly one row", wrote, dim * 4);
        ok("by appending rather than rewriting", keptExisting === true,
           String(keptExisting));
        eq("and the file grew by one row", await binSize(), 9 * dim * 4);
      }

      /* A failed write must leave memory exactly as it was, so the next attempt
         is the same size rather than larger. */
      const idsBefore = FACES.vec.ids.length;
      const rowsBefore = FACES.vec.rows.length;
      const realFacesDir = facesDir;
      facesDir = async () => { throw new Error("share went away"); };
      let threw = false;
      try { await appendFaceVectors([{ id:"fv-fail", vec: vec(99) }]); }
      catch { threw = true; }
      facesDir = realFacesDir;
      ok("a failed vector write is reported", threw);
      eq("and memory is unchanged by it", FACES.vec.ids.length, idsBefore);
      eq("including the row buffer", FACES.vec.rows.length, rowsBefore);
      ok("so the id that failed is not claimed", !FACES.vec.index.has("fv-fail"));
      /* The next write must therefore be the ordinary one-row append. */
      await appendFaceVectors([{ id:"fv-9", vec: vec(9) }]);
      eq("and the next append is still one row", await binSize(), 10 * dim * 4);

      await deleteAllFaceData();
    }

    S.roles.embed = "";
    const records = Array.from({ length:75 }, (_,i) => ({ id:"consumer-" + i,
      name:"photo-" + i + ".jpg", caption:i % 2 ? "a beach holiday" : "a garden",
      place:i % 2 ? "Sicily" : "London", status:"ok", date_taken:"2024-07-20" }));
    IDX.records = new Map(records.map(r => [r.id,r]));
    const add = async (id, photo, vector) => {
      await appendFaceVectors([{ id, vec:Float32Array.from(vector) }]);
      await appendFaces([{ id, photo_id:photo, box:[0.1,0.1,0.2,0.2],
        engine:faceEngineId(), score:0.95, px:160, src:"original" }]);
    };
    await add("a", "consumer-1", [1,0,0]);
    await add("b", "consumer-3", [1,0.01,0]);
    await add("c", "consumer-5", [0,1,0]);
    clusterFaces();
    const group = FACES.clusters.find(g => g.face_ids.includes("a"));
    await namePerson(group.id, "Anna");
    const annaId = group.id;
    await namePerson(FACES.clusters[0].id, "Ben");
    const benId = FACES.people.find(p => p.name === "Ben").id;
    const moved = await splitOut(annaId, ["b"]);
    clusterFaces();
    ok("a rejected face cannot silently rejoin its named person", !findPerson(annaId).face_ids.includes("b"));
    await savePeople(); await loadFaces(); clusterFaces();
    ok("a rejection survives reload and regrouping", !findPerson(annaId).face_ids.includes("b"));
    eq("the separation decision was persisted", FACES.separations.length, 1);
    await undoPeopleEdit();
    ok("undo restores the face membership", findPerson(annaId).face_ids.includes("b"));
    eq("undo restores the earlier constraints", FACES.separations.length, 0);
    eq("undo is consumed rather than silently toggling to redo", FACES.undo, null);
    const splitAgain = await splitOut(annaId, ["b"]);
    await namePerson(annaId, "");
    clusterFaces();
    ok("separations also protect unnamed groups", !FACES.clusters.some(g => g.face_ids.includes("a") && g.face_ids.includes("b")));
    const aGroup = FACES.clusters.find(g => g.face_ids.includes("a"));
    await namePerson(aGroup.id, "Anna");
    const anna = FACES.people.find(p => p.name === "Anna");
    await mergeGroups(anna.id, FACES.clusters.find(g => g.face_ids.includes("b")).id);
    ok("an explicit merge overrides a previous separation", anna.face_ids.includes("b") && !FACES.separations.length);

    await add("same-photo", "consumer-1", [1,0,0]);
    clusterFaces();
    ok("two faces from one photo are never automatically assigned to one person", !anna.face_ids.includes("same-photo"));
    await add("ambiguous", "consumer-7", [0.72,0.69,0]);
    clusterFaces();
    ok("a close match to two people goes to review", FACES.review.some(r => r.face_id === "ambiguous"));
    eq("an uncertain match is absent from named search", faceNamesFor("consumer-7"), []);
    await reviewFace("ambiguous", anna.id, false);
    clusterFaces();
    ok("a rejected suggestion is not offered for that person again", !FACES.review.some(r => r.face_id === "ambiguous" && r.person_id === anna.id));
    await reviewFace("ambiguous", benId, true);
    ok("confirmation makes a face searchable", faceNamesFor("consumer-7").includes("Ben"));
    await loadFaces();
    ok("confirmed and rejected decisions survive reload", findPerson(benId).confirmed_ids.includes("ambiguous")
      && FACES.people.find(p => p.name === "Anna").rejected_ids.includes("ambiguous"));
    ok("refinement cannot discard saved corrections", await rejected(() => refinePhotoFaces("consumer-1", {})));
    ok("malformed correction data is rejected", await rejected(async () => parsePeople(
      JSON.stringify({ people:[], clusters:[], separations:[{}] }))));

    rebuildDerived();
    let result = await searchPhotos({ query:"photos of Anna at the beach", semantic:false });
    eq("natural people search cannot return other people's beach photos", result.results.map(x => x.rec.id).sort(), ["consumer-1","consumer-3"]);
    eq("the applied name filter is explained", result.applied, ["With Anna"]);
    eq("short names do not match a substring of another name", (await searchPhotos({ query:"", person:"Ann" })).total, 0);
    eq("names within words are not parsed as people", peopleSearchArgs({ query:"annals of a holiday" }).args.person_ids, []);
    eq("quoted names stay literal", peopleSearchArgs({ query:'"Anna"' }).args.person_ids, []);
    eq("quoted filler words remain exact", peopleSearchArgs({ query:'Anna "the beach"' }).args.query, '"the beach"');
    eq("quoted whitespace remains exact", peopleSearchArgs({ query:'Anna "the  beach"' }).args.query, '"the  beach"');
    eq("people can be excluded explicitly", (await searchPhotos({ query:"beach without Anna", semantic:false })).results.some(x => faceNamesFor(x.rec.id).includes("Anna")), false);
    eq("everyone named must be in the photo", (await searchPhotos({ query:"Anna and Ben", semantic:false })).total, 0);
    await add("together", "consumer-1", [0,1,0]);
    await reviewFace("together", benId, true);
    result = await searchPhotos({ query:"Anna and Ben", semantic:false });
    eq("multiple people finds photos together", result.results.map(x => x.rec.id), ["consumer-1"]);
    result = await searchPhotos({ query:"Anna", place:"London", semantic:false });
    eq("person and place filters intersect", result.total, 0);
    eq("person and date filters intersect", (await searchPhotos({ query:"Anna", date_from:"2025-01-01" })).total, 0);
    eq("a user can search a name as ordinary text", peopleSearchArgs({ query:"Anna beach", interpret_people:false }).args.person_ids, []);
    ok("an explicit unknown name gives an actionable error", await rejected(() => searchPhotos({ query:'person:"Nobody"' })));
    const first = await searchPhotos({ query:"", limit:60 });
    const second = await searchPhotos({ query:"", limit:60, offset:60 });
    eq("pagination reports the full album count", first.total, 75);
    eq("pagination reaches the photos after sixty", second.results.length, 15);
    ok("pages do not overlap", !second.results.some(x => first.results.some(y => y.rec.id === x.rec.id)));
    FACES.people.push({ id:"duplicate-name", name:"Anna", face_ids:[] });
    ok("ambiguous names ask for an explicit person selection", await rejected(() => searchPhotos({ query:"Anna" })));
    ok("chat filters cannot silently choose between duplicate names", await rejected(() => searchPhotos({ query:"", person:["Anna"] })));
    FACES.people.pop();
    // Exercise the actual form/rendering path with the server disabled.
    const wasLoaded = IDX.loaded; IDX.loaded = true;
    renderSearchPeople();
    $("#photoQuery").value = "Anna and Ben"; $("#photoSemantic").checked = false;
    await submitPhotoSearch();
    eq("the Search screen shows the required people", [...$("#photoSearchApplied").children].map(x => x.textContent), ["With Anna","With Ben"]);
    ok("the Search screen renders matching thumbnails", $("#photoSearchResults").querySelectorAll("figure").length === 1);
    $("#photoSearchClear").click();
    eq("clearing filters clears old results", $("#photoSearchResults").children.length, 0);
    $("#photoFrom").value = "2025-01-01"; $("#photoTo").value = "2024-01-01";
    await submitPhotoSearch();
    ok("invalid date bounds have readable feedback", /From date/.test($("#photoSearchStatus").textContent));
    $("#photoSearchClear").click(); IDX.loaded = wasLoaded;
    const one = FACES.faces.get("a"), originalEngine = one.engine;
    one.engine = "old-incompatible-model";
    ok("incompatible face spaces cannot be regrouped", await rejected(async () => clusterFaces()));
    one.engine = originalEngine;

    // Back up real on-disk test records rather than the synthetic search map.
    IDX.records = keep.records; IDX.vec = keep.vec;
    await savePeople();
    const beforePeople = JSON.stringify(peopleState());
    const faceDir = await facesDir();
    const prior = await (await (await faceDir.getFileHandle("people.json")).getFile()).text();
    FACES.dir = faultFS(faceDir, { failWrites:1 });
    ok("a failed correction is reported", await rejected(() => namePerson(benId, "Lost name")));
    eq("a failed correction rolls memory back", findPerson(benId).name, "Ben");
    FACES.dir = faceDir;
    eq("a failed correction leaves saved names intact", await (await (await faceDir.getFileHandle("people.json")).getFile()).text(), prior);
    libraryMaintenance++;
    try { ok("backup/restore excludes concurrent people edits", await rejected(() => namePerson(benId, "Racing edit"))); }
    finally { libraryMaintenance--; }
    const scratchText = await scratch.getDirectoryHandle("verified-text", { create:true });
    ok("short writes fail verification", await rejected(() => writeVerifiedText(faultFS(scratchText, { shortWrites:0.5 }), "test.json", '{"saved":true}')));
    S.backup.keep = 1;
    const backup = await backupIndex("consumer regression");
    ok("backups include people and face vectors", ["people.json","faces.jsonl","facevecs.json","facevecs.bin"].every(n => backup.manifest.faces.files.some(f => f.name === n)));
    ok("every face backup file has a checksum", backup.manifest.faces.files.every(f => /^[0-9a-f]{64}$/.test(f.sha256)));
    await namePerson(benId, "Renamed after backup");
    await restoreBackup(backup.stamp);
    eq("restoring recovers the name", findPerson(benId).name, "Ben");
    ok("restoring recovers correction decisions", FACES.people.find(p => p.name === "Anna").rejected_ids.includes("ambiguous"));
    const backups = await backupsDir();
    ok("keep=1 does not delete the restore source", !!(await backups.getDirectoryHandle(backup.stamp)));
    const source = await backups.getDirectoryHandle(backup.stamp);
    const sourceFaces = await source.getDirectoryHandle("faces");
    const peopleFile = await sourceFaces.getFileHandle("people.json");
    const valid = await (await peopleFile.getFile()).text();
    await writeFile(peopleFile, valid.replace("Ben", "Bad")); // same size corruption
    ok("checksum rejects same-size corruption before restore", await rejected(() => restoreBackup(backup.stamp)));
    eq("a corrupt source cannot change live names", findPerson(benId).name, "Ben");
    await writeFile(peopleFile, valid);
    const legacy = await backups.getDirectoryHandle("legacy-consumer-test", { create:true });
    for (const file of BACKUP_FILES) await copyInto(IDX.dir, legacy, file);
    await restoreBackup("legacy-consumer-test");
    eq("restoring an older backup preserves existing people", findPerson(benId).name, "Ben");
    const blank = await scratch.getDirectoryHandle("second-library", { create:true });
    const oldMode = S.indexMode, oldParent = S.indexDirHandle;
    try {
      S.indexMode = "custom"; S.indexDirHandle = blank;
      await ensureIndex();
      eq("switching libraries clears the previous names", FACES.people.length, 0);
      eq("switching libraries clears previous face lookup", faceNamesFor("consumer-1"), []);
    } finally {
      S.indexMode = oldMode; S.indexDirHandle = oldParent;
      await ensureIndex();
    }
  } finally {
    IDX.dir = keep.dir; resetFaceState();
    await deleteAllFaceData();
    IDX.records = keep.records; IDX.vec = keep.vec;
    S.faces = keep.settings; S.roles = keep.roles; S.backup = keep.backup;
    rebuildDerived();
  }
}
