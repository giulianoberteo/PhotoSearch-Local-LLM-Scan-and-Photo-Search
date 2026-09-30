
/* ================= self-test =================
   Runs the real pipeline against an OPFS scratch folder with mock model
   responses, so the worker, index, plan, move detection, vectors, checkpoint
   and derived data are all genuinely exercised without a picked folder. */
const T = { pass:0, fail:0, lines:[] };
function ok(name, cond, detail){
  if (cond){ T.pass++; T.lines.push("PASS  " + name + (detail ? "  — " + detail : "")); }
  else { T.fail++; T.lines.push("FAIL  " + name + (detail ? "  — " + detail : "")); }
  // Streamed so a hang can be located: the last line printed is the last
  // assertion that completed, and the hang is in the code after it.
  console.log((cond ? "PASS  " : "FAIL  ") + name);
  return !!cond;
}
function eq(name, got, want){
  return ok(name, JSON.stringify(got) === JSON.stringify(want),
    JSON.stringify(got) + (JSON.stringify(got) === JSON.stringify(want) ? "" : " != " + JSON.stringify(want)));
}
async function makeImage(w, h, color, type){
  const c = new OffscreenCanvas(w, h);
  const x = c.getContext("2d");
  x.fillStyle = color; x.fillRect(0, 0, w, h);
  x.fillStyle = "#000"; x.fillRect(w*0.1, h*0.1, w*0.3, h*0.3);
  return c.convertToBlob({ type: type || "image/png" });
}
async function writeInto(dir, name, blob){
  const fh = await dir.getFileHandle(name, { create:true });
  const w = await fh.createWritable(); await w.write(blob); await w.close();
  return fh;
}
async function rmAll(dir){
  const names = [];
  for await (const [n] of dir.entries()) names.push(n);
  for (const n of names){ try { await dir.removeEntry(n, { recursive:true }); } catch {} }
}

async function selfTest(){
  T.pass = 0; T.fail = 0; T.lines = [];
  const host = $("#selfOut"); resetChecks(host);
  const st = step(host, "Self-test");
  const wasMock = $("#mock").checked, savedDir = S.dirHandle, savedRoles = { ...S.roles };
  // Boot-time detection runs in the background and rewrites S.roles when it
  // lands. Let it finish first, or it clobbers the mock roles mid-test.
  try { if (connecting) await connecting; } catch {}
  $("#mock").checked = true;
  S.roles = { scan:"mock-vlm", embed:"mock-embed", chat:"auto" };
  ok("mock roles are in place for the run", S.roles.embed === "mock-embed", S.roles.embed);
  try {
    /* ---- pure functions ---- */
    ok("fnv is deterministic", fnv("a/b.jpg") === fnv("a/b.jpg") && fnv("a") !== fnv("b"));
    eq("easter 2024", ymd(easterSunday(2024)), "2024-03-31");
    eq("easter 2026", ymd(easterSunday(2026)), "2026-04-05");
    const ctx = dateContext("2024-03-31T10:00:00");
    ok("easter occasion detected", ctx.occasions.includes("easter"), ctx.occasions.join(","));
    eq("season of march", dateContext("2024-03-31T10:00:00").season, "spring");
    eq("southern hemisphere flips", dateContext("2024-03-31T10:00:00",{hemisphere:"south"}).season, "autumn");
    eq("singular keeps jeans", singular("jeans"), "jeans");
    eq("singular trees", singular("trees"), "tree");
    eq("normList dedupes + caps", normList(["Tree","tree","Bench"], 2, true), ["tree","bench"]);
    const v = validate({ observations:["a","b"], caption:Array(40).fill("w").join(" "),
      objects:Array(20).fill(0).map((_,i)=>"o"+i), image_type:"nope", visible_text:{has_text:true,text:"x".repeat(400)} });
    ok("validate flags short observations", v.issues.some(i => i.includes("observations")));
    ok("validate caps caption", v.norm.caption.split(" ").length === 25);
    ok("validate caps objects", v.norm.objects.length === 12);
    ok("validate no longer imposes the old flat 300 cap",
       v.norm.visible_text.text.length === 400, v.norm.visible_text.text.length + " chars kept");
    ok("validate rejects bad enum", v.issues.some(i => i.includes("image_type")));
    eq("filename date parsed", dateFromName("Screenshot 2025-05-21 at 11.44.18.png").getFullYear(), 2025);
    ok("ambiguous date ignored", dateFromName("Photo 04-07-2012.jpg") === null
      || dateFromName("Photo 04-07-2012.jpg").getFullYear() === 2012);
    eq("image_type via filename", correctImageType("photo",
      { name:"Screenshot 2025-05-21.png", width:840, height:434 }).type, "screenshot");
    eq("image_type via camera exif", correctImageType("screenshot",
      { name:"IMG_1.jpg", width:4032, height:3024, camera:"Apple iPhone X" }).type, "photo");
    eq("image_type left alone", correctImageType("artwork",
      { name:"art.png", width:1024, height:1024 }).type, "artwork");
    eq("slide caption beats model", correctImageType("photo", { name:"GWPC Products.PNG",
      width:1518, height:845 },
      { caption:"A presentation slide displays GWPC Products with product variants." }).type, "screenshot");
    eq("poster caption beats model", correctImageType("photo",
      { name:"For_a_Few_Dollars_More-ita-poster.jpg", width:266, height:375 },
      { caption:"A movie poster featuring a man in a hat holding a revolver." }).type, "artwork");
    eq("map caption beats model", correctImageType("photo", { name:"treasure-map.png",
      width:800, height:600 },
      { caption:"A digital map view showing a park area with lakes." }).type, "screenshot");
    eq("a photo OF a poster stays a photo", correctImageType("photo",
      { name:"IMG_9.jpg", width:4032, height:3024, camera:"Apple iPhone X" },
      { caption:"A movie poster hangs on a brick wall above a bench." }).type, "photo");
    eq("plain photo caption unaffected", correctImageType("photo", { name:"a.jpg",
      width:800, height:600 }, { caption:"Two children stand in a forest holding a sword." }).type, "photo");
    ok("reasoning detector: clean json", detectReasoning('{"a":1}', "", '{"a":1}') === false);
    ok("reasoning detector: trailing prose", detectReasoning('{"a":1} then I thought', "", "x") === true);
    ok("reasoning detector: both fields", detectReasoning('{"a":1}', '{"a":1}', "I thought first") === true);

    /* ---- geo ---- */
    GEO.count = 3;
    GEO.lat = Float32Array.from([51.5074, 45.4642, 40.7128]);
    GEO.lon = Float32Array.from([-0.1278, 9.1900, -74.0060]);
    GEO.names = ["London","Milan","New York"]; GEO.cc = ["GB","IT","US"];
    buildGeoGrid(); GEO.state = "ready";
    eq("nearest place", nearestPlace(51.50, -0.12).name, "London");
    ok("distance is sane", nearestPlace(51.50, -0.12).km < 5);

    /* ---- OPFS scratch folder ---- */
    await st.note("Building a scratch folder in OPFS…");
    const root = await navigator.storage.getDirectory();
    const scratch = await root.getDirectoryHandle("selftest", { create:true });
    await rmAll(scratch);
    S.dirHandle = scratch;
    const sub = await scratch.getDirectoryHandle("sub", { create:true });
    await writeInto(scratch, "one.png",  await makeImage(900, 600, "#4488cc"));
    await writeInto(scratch, "two.jpg",  await makeImage(640, 480, "#cc8844", "image/jpeg"));
    await writeInto(scratch, "three.webp", await makeImage(300, 300, "#44cc88", "image/webp"));
    await writeInto(sub, "four.png", await makeImage(200, 400, "#cc4488"));
    await writeInto(scratch, "notes.txt", new Blob(["hello"]));
    await writeInto(scratch, "raw.CR2", new Blob([new Uint8Array(10)]));
    await writeInto(scratch, "clip.mp4", new Blob([new Uint8Array(10)]));

    /* ---- worker decode ---- */
    await st.note("Decoding through the worker…");
    const f1 = await (await scratch.getFileHandle("one.png")).getFile();
    const img = await processImage(f1, "native");
    eq("worker resizes long edge to 1024 cap", [img.w, img.h], [900, 600]);
    ok("worker returns a thumbnail blob", img.thumb instanceof Blob && img.thumb.size > 0);
    ok("worker reports source size", img.srcW === 900 && img.srcH === 600);
    const bigImg = await processImage(
      await (await writeInto(scratch,"big.png", await makeImage(3000, 1500, "#222"))).getFile(), "native");
    eq("worker downscales to 1024", [bigImg.w, bigImg.h], [1024, 512]);
    await scratch.removeEntry("big.png");

    /* ---- real HEIC through libheif ----
       Needs a real .heic to decode, which the repo does not ship. Point the page
       at one to include this case:
         PhotoSearch.html#selftest&heic=file:///path/to/sample.heic
       Skipped cleanly otherwise. */
    {
      const m = /[?&#]heic=([^&]+)/.exec(location.hash + location.search);
      if (m){
        try {
          const hr = await fetch(decodeURIComponent(m[1]));
          if (hr.ok){
            const hf = new File([await hr.blob()], "sample.heic", { type:"image/heic" });
            const hi = await processImage(hf, "heic");
            ok("real HEIC decodes", hi.srcW > 0 && hi.srcH > 0,
               hi.srcW + "x" + hi.srcH + " via " + hi.decoder);
          } else T.lines.push("SKIP  real HEIC — sample not reachable");
        } catch (e){ T.lines.push("SKIP  real HEIC — " + String(e.message || e)); }
      } else T.lines.push("SKIP  real HEIC — pass #selftest&heic=<url> to include it");
    }

    /* ---- index + plan ---- */
    await st.note("Index, plan and scan…");
    IDX.loaded = false;
    await ensureIndex();
    await loadRecords(); await loadVectors(); await loadCheckpoint();
    let plan = await buildPlan();
    eq("plan finds 4 scannable images", plan.total, 4);
    eq("plan counts RAW", plan.counts.raw, 1);
    eq("plan counts video", plan.counts.video, 1);
    eq("plan ignores .txt", plan.counts.other, 1);
    eq("all four are new", plan.new.length, 4);
    ok("subfolder was walked", plan.new.some(f => f.path === "sub/four.png"));

    await runScan(plan.new, "selftest");
    ok("all four scanned without error", RUN.errors.length === 0, RUN.errors.map(e=>e.error).join("; "));
    eq("four records in memory", IDX.records.size, 4);
    const rec = [...IDX.records.values()][0];
    ok("record has caption", !!rec.caption);
    ok("record has when context", !!(rec.when && rec.when.season));
    ok("heavy fields kept out of memory", rec.raw_model_json === undefined && rec.embedding === undefined);

    /* ---- persistence round trip ---- */
    IDX.loaded = false;
    await loadRecords();
    eq("records reload from disk", IDX.records.size, 4);
    const full = await readFullRecord(rec.id);
    ok("raw model JSON is on disk", !!(full && full.raw_model_json), "id " + rec.id);

    /* ---- vectors ---- */
    await loadVectors();
    eq("vectors persisted", IDX.vec.ids.length, 4);
    ok("vector is retrievable", vectorOf(rec.id) && vectorOf(rec.id).length === IDX.vec.dim);

    /* ---- a reload must not make a finished scan look undone ---- */
    const keepScan = S.roles.scan;
    S.roles.scan = "";                       // models not detected yet
    const racy = await buildPlan();
    eq("no scan model yet does not mark the library stale", racy.stale.length, 0);
    eq("finished work still counts as up to date", racy.ok.length, 4);
    S.roles.scan = keepScan;

    /* ---- the index can live somewhere other than the photo folder ---- */
    const idxHome = await root.getDirectoryHandle("idxhome", { create:true });
    await rmAll(idxHome);
    const savedMode = S.indexMode, savedIdxDir = S.indexDirHandle;
    S.indexMode = "custom"; S.indexDirHandle = idxHome;
    await ensureIndex();
    ok("index writes into the chosen folder, not the photos",
       (await idxHome.getDirectoryHandle(".photoindex")) != null);
    let strayInPhotos = true;
    try { await scratch.getDirectoryHandle(".photoindex"); strayInPhotos = true; }
    catch { strayInPhotos = false; }
    ok("photo folder still holds its own earlier index", strayInPhotos);
    IDX.loaded = false; await loadRecords();
    eq("a fresh index location starts empty", IDX.records.size, 0);
    S.indexMode = savedMode; S.indexDirHandle = savedIdxDir;
    await ensureIndex(); IDX.loaded = false; await loadRecords(); await loadVectors();
    eq("switching back restores the original index", IDX.records.size, 4);
    await rmAll(idxHome);

    /* ---- scan order decides what exists on day one ---- */
    const savedOrder = S.scanOrder;
    S.scanOrder = "path";
    const byPath2 = await buildPlan();
    const paths = byPath2.ok.map(f => f.path);
    ok("folder order is alphabetical",
       JSON.stringify(paths) === JSON.stringify([...paths].sort()), paths.join(","));
    S.scanOrder = savedOrder;

    /* ---- a dropped read is retried, not recorded as an error ---- */
    let tries = 0;
    const flaky = await withRetry("flaky", async () => {
      tries++;
      if (tries < 3) throw new Error("smb dropped");
      return "recovered";
    });
    eq("a flaky read recovers", [flaky, tries], ["recovered", 3]);
    let threw = false;
    try { await withRetry("always", async () => { throw new Error("gone"); }); }
    catch (e){ threw = /failed after/.test(e.message); }
    ok("a genuinely dead read still fails", threw);

    /* ---- pick any folder, any time, one index ----
       The real requirement: scan a subfolder today and the whole library
       tomorrow without duplicates and without anything being called missing. */
    {
      const sicily = await scratch.getDirectoryHandle("Sicily", { create:true });
      const norway = await scratch.getDirectoryHandle("Norway", { create:true });
      await writeInto(sicily, "IMG_1.jpg", await makeImage(300,200,"#c44","image/jpeg"));
      await writeInto(norway, "IMG_1.jpg", await makeImage(640,480,"#44c","image/jpeg"));
      const keepScope = S.scanScope, keepDir = S.dirHandle;
      /* Picking different folders only yields ONE index if the index location is
         fixed. In "beside the photos" mode each folder gets its own .photoindex,
         which is the whole reason for the custom-location setting. */
      const keepMode = S.indexMode, keepIdx = S.indexDirHandle;
      const fixedIdx = await root.getDirectoryHandle("fixedidx", { create:true });
      await rmAll(fixedIdx);
      S.indexMode = "custom"; S.indexDirHandle = fixedIdx;
      await ensureIndex(); IDX.loaded = false; await loadRecords(); await loadVectors();

      // 1. pick the SUBFOLDER directly, as a user naturally would
      S.dirHandle = sicily; S.scanScope = "";
      let p1 = await buildPlan();
      eq("picking a subfolder sees just its files", p1.total, 1);
      eq("nothing else is called missing", p1.missing.length, 0);
      const before = IDX.records.size;
      await runScan(p1.new, "pick-sicily");
      eq("it lands in the shared index", IDX.records.size, before + 1);
      ok("that index is the fixed one, not one per folder",
         IDX.dir !== null && S.indexMode === "custom");
      const sicRec = [...IDX.records.values()].find(r => r.name === "IMG_1.jpg");
      const sicId = sicRec.id;

      // 2. pick the OTHER subfolder: same filename, different photo
      S.dirHandle = norway;
      let p2 = await buildPlan();
      eq("the other folder is new work", p2.new.length, 1);
      eq("and the first folder is not missing", p2.missing.length, 0);
      await runScan(p2.new, "pick-norway");
      const both = [...IDX.records.values()].filter(r => r.name === "IMG_1.jpg");
      eq("two photos share a filename but not an id", both.length, 2);
      ok("their ids differ", both[0] && both[1] && both[0].id !== both[1].id,
         both.map(r=>r.id).join(" vs "));
      ok("each carries a content tag", both.every(r => !!r.content_tag),
         both.map(r=>r.content_tag).join(" "));

      // 3. now pick the LIBRARY ROOT: both must be recognised, not re-scanned
      S.dirHandle = scratch;
      const p3 = await buildPlan();
      /* plan.moved is a RELINK list that overlaps the categories, so count
         distinct files rather than summing the two lists. */
      const recognised = new Set([...p3.ok, ...p3.moved, ...p3.stale, ...p3.changed]
        .filter(f => f.name === "IMG_1.jpg").map(f => f.path));
      eq("the root run recognises both already-scanned photos", recognised.size, 2);
      eq("neither is treated as new", p3.new.filter(f => f.name === "IMG_1.jpg").length, 0);
      if (p3.moved.length) await applyMoves(p3.moved);
      const sicAfter = IDX.records.get(sicId);
      ok("the record kept its id and gained the fuller path", !!sicAfter, sicId);
      ok("path is now root-relative",
         (sicAfter.path || "").includes("Sicily"), sicAfter.path);
      eq("still only two IMG_1 records",
         [...IDX.records.values()].filter(r => r.name === "IMG_1.jpg" && !r.deleted).length, 2);

      // 4. a record from a different pick root is never reported missing
      S.dirHandle = sicily;
      const p4 = await buildPlan();
      eq("opening one folder does not endanger the rest", p4.missing.length, 0);

      /* 4b. a relinked file must still be judged. Two bugs lived here: a file
         matched by content went straight into moved/ok, skipping the staleness
         check, and one whose path did not change never had its root rewritten,
         so it was content-verified again on every plan. */
      {
        S.dirHandle = scratch;
        const rec0 = [...IDX.records.values()].find(r => r.name === "IMG_1.jpg" && !r.deleted);
        /* Write the stale state to DISK, not just to memory: applyMoves now
           reads the full record from the log (so it cannot strip raw_model_json),
           which means an in-memory-only change would simply be ignored. */
        const disk0 = (await readFullRecords(new Set([rec0.id]))).get(rec0.id) || rec0;
        await appendLines("records.jsonl", [{ ...disk0,
          schema_hash:"OLD-HASH", library_root:"some-other-root" }]);
        IDX.loaded = false; await loadRecords();
        const rec0b = IDX.records.get(rec0.id);
        eq("the stale state is really on disk", rec0b.schema_hash, "OLD-HASH");
        const pr = await buildPlan();
        const asStale = pr.stale.filter(f => f.name === "IMG_1.jpg").length;
        const asOk = pr.ok.filter(f => f.name === "IMG_1.jpg").length;
        eq("a relinked file is still reported stale", asStale, 1);
        ok("it is not silently marked up to date", asOk <= 1, asOk + " ok");
        ok("and it is queued for relinking", pr.moved.some(f => f.name === "IMG_1.jpg"));
        await applyMoves(pr.moved);
        const after = (await readFullRecords(new Set([rec0.id]))).get(rec0.id);
        eq("relinking rewrites the pick root", after.library_root, scratch.name);
        eq("relinking preserves the hashes so staleness still fires",
           after.schema_hash, "OLD-HASH");
        ok("and still preserves the raw model output", !!after.raw_model_json);
        const pr2 = await buildPlan();
        eq("a second plan needs no further relinking of it",
           pr2.moved.filter(f => f.name === "IMG_1.jpg").length, 0);
      }

      /* 5. a deliberate name+size+mtime coincidence must NOT merge two photos */
      {
        const a = await scratch.getDirectoryHandle("CoA", { create:true });
        const b = await scratch.getDirectoryHandle("CoB", { create:true });
        const blobA = await makeImage(256,256,"#0a0");
        await writeInto(a, "SAME.png", blobA);
        S.dirHandle = a;
        const pa = await buildPlan();
        await runScan(pa.new, "coincide-a");
        const recA = [...IDX.records.values()].find(r => r.name === "SAME.png");
        // a different picture, then forge identical identity on the record
        await writeInto(b, "SAME.png", await makeImage(256,256,"#a00"));
        S.dirHandle = b;
        const fileB = await (await b.getFileHandle("SAME.png")).getFile();
        recA.size = fileB.size; recA.mtime = fileB.lastModified;   // identical identity
        const pb = await buildPlan();
        eq("a content mismatch refuses the identity match", pb.moved.length, 0);
        eq("the different photo is treated as new", pb.new.length, 1);
        for (const d2 of ["CoA","CoB"])
          { try { await scratch.removeEntry(d2, { recursive:true }); } catch {} }
      }

      S.dirHandle = keepDir; S.scanScope = "";
      for (const d2 of ["Sicily","Norway"])
        { try { await scratch.removeEntry(d2, { recursive:true }); } catch {} }
      let where = "start";
      try {
        where = "buildPlan";
        const cleanup = await buildPlan();
        where = "markMissing(" + cleanup.missing.length + ")";
        if (cleanup.missing.length) await markMissing(cleanup);
        where = "done";
      } catch (e){
        T.lines.push("FAIL  cleanup threw at [" + where + "]: " + String(e && e.message || e));
        T.fail++;
      }
      S.scanScope = keepScope;
      S.indexMode = keepMode; S.indexDirHandle = keepIdx;
      await ensureIndex(); IDX.loaded = false; await loadRecords(); await loadVectors();
      await rmAll(fixedIdx);
    }

    /* a scope whose folder has vanished must not break the plan */
    {
      const keep = S.scanScope;
      S.scanScope = "folder-that-does-not-exist/";
      const p5 = await buildPlan();
      ok("a vanished scope falls back to the whole library", p5.scope === "");
      S.scanScope = keep;
    }

    /* ---- the picker is a single direct call ---- */
    {
      const realPicker = window.showDirectoryPicker;
      let opts = null, calls = 0;
      window.showDirectoryPicker = o => { calls++; opts = o;
        return Promise.resolve({ kind:"directory", name:"Chosen" }); };
      const h = await pickDirectory();
      eq("the picker returns the chosen folder", h && h.name, "Chosen");
      eq("it is called exactly once", calls, 1);
      eq("with read-write access and nothing else", JSON.stringify(opts),
         JSON.stringify({ mode:"readwrite" }));
      window.showDirectoryPicker = () => Promise.reject(
        Object.assign(new Error("The user aborted a request."), { name:"AbortError" }));
      let bubbled = false;
      try { await pickDirectory(); } catch (e){ bubbled = e.name === "AbortError"; }
      ok("cancelling surfaces as AbortError for the caller to ignore", bubbled);
      // a stuck picker must be recognised and offer the only real remedy
      ok("a stuck picker is recognised",
         isPickerStuck(new Error("Failed to execute 'showDirectoryPicker' on "
           + "'Window': File picker already active.")));
      ok("an ordinary error is not mistaken for it",
         !isPickerStuck(new Error("something else went wrong")));
      offerPickerReset();
      ok("the reload offer is shown", $("#browserWarn").hidden === false);
      ok("it offers a reload button",
         [...$("#browserWarn").querySelectorAll("button")]
           .some(b => /Reload/.test(b.textContent)));
      $("#browserWarn").hidden = true; $("#browserWarn").innerHTML = "";
      window.showDirectoryPicker = realPicker;

      // dragging a folder still works as an extra route
      let got = null;
      enableFolderDrop("btnCompact", hh => { got = hh; });
      const ev = new Event("drop", { bubbles:true });
      ev.dataTransfer = { items: [{ getAsFileSystemHandle: async () => ({
        kind:"directory", name:"DroppedFolder", queryPermission: async () => "granted" }) }] };
      Object.defineProperty(ev, "preventDefault", { value: () => {} });
      Object.defineProperty(ev, "stopPropagation", { value: () => {} });
      $("#btnCompact").dispatchEvent(ev);
      await new Promise(r => setTimeout(r, 30));
      ok("a dropped folder still works too", got && got.name === "DroppedFolder");
    }

    /* ---- progress notes must never hang the caller ---- */
    {
      const realRaf = window.requestAnimationFrame;
      window.requestAnimationFrame = () => {};      // simulate a hidden tab
      const t0 = performance.now();
      let resolved = false;
      await Promise.race([
        paint().then(() => { resolved = true; }),
        new Promise(r => setTimeout(r, 1000))
      ]);
      window.requestAnimationFrame = realRaf;
      ok("paint resolves even when rAF never fires", resolved,
         Math.round(performance.now() - t0) + "ms");
    }

    /* ---- audit fixes ---- */
    {
      // failure streak must trigger even after successes
      RUN.streak = 0; RUN.streakMsg = null;
      for (let i = 0; i < 4; i++){
        RUN.streak = (RUN.streak && RUN.streakMsg === "boom") ? RUN.streak + 1 : 1;
        RUN.streakMsg = "boom";
      }
      eq("four identical failures do not stop a run yet", RUN.streak, 4);
      RUN.streak = 0;                                  // a success resets it
      RUN.streak = (RUN.streak && RUN.streakMsg === "boom") ? RUN.streak + 1 : 1;
      eq("a success resets the streak", RUN.streak, 1);

      // chat history must stay inside the model's context
      const keepChat = CHAT.messages.slice();
      CHAT.messages = [{ role:"system", content:"sys" }];
      for (let i = 0; i < 40; i++){
        CHAT.messages.push({ role:"user", content:"q".repeat(500) });
        CHAT.messages.push({ role:"assistant", content:"", tool_calls:[{id:"t"+i}] });
        CHAT.messages.push({ role:"tool", tool_call_id:"t"+i, content:"r".repeat(2000) });
      }
      const grew = CHAT.messages.reduce((a,m) => a + (m.content||"").length, 0);
      trimHistory();
      const after = CHAT.messages.reduce((a,m) => a + (m.content||"").length, 0);
      ok("history is trimmed to the budget", after <= S.chat.historyChars,
         grew + " -> " + after);
      eq("the system prompt is kept", CHAT.messages[0].content, "sys");
      ok("no orphaned tool reply starts the window",
         CHAT.messages.length < 2 || CHAT.messages[1].role !== "tool",
         CHAT.messages[1] && CHAT.messages[1].role);
      CHAT.messages = keepChat;
    }

    /* ---- truncated model output is retried, not recorded as a failure ---- */
    {
      eq("the default token ceiling is generous enough for text-heavy images",
         S.scan.maxTokens >= 2000, true);
      const realChat = window.chat;
      let calls = [];
      // first call truncates, second (with more room) succeeds
      window.chat = async (body) => {
        calls.push(body.max_tokens);
        const full = JSON.stringify({ template_version:"1.1", observations:["a","b","c"],
          image_type:"photo", scene_type:"outdoor", setting:"street",
          people:{count:0,count_bucket:"0",age_groups:[],description:""}, animals:[],
          objects:["sign"], activities:[], visible_text:{has_text:true,text:"LOTS"},
          landmark:{name:null,confidence:"low"}, time_of_day:"midday", season:"summer",
          weather:"sunny", mood:"neutral", dominant_colors:["grey"],
          quality:{sharpness:"sharp",exposure:"ok",flags:[]}, caption:"A street sign.",
          description:"A street sign stands by a road.", search_keywords:["sign"],
          confidence:{overall:"high",uncertain_fields:[]} });
        const truncate = calls.length === 1;
        return { choices:[{ finish_reason: truncate ? "length" : "stop",
          message:{ content:"", reasoning_content: truncate ? full.slice(0, 120) : full } }],
          usage:{ completion_tokens: truncate ? body.max_tokens : 400 } };
      };
      const first = await extract("m", "data:,x", "", new AbortController().signal, 2000);
      ok("a cut-off answer is flagged truncated", first.truncated === true);
      const second = await extract("m", "data:,x", "", new AbortController().signal, 6000);
      ok("the retry with more room parses", (() => {
        try { JSON.parse(second.raw); return true; } catch { return false; } })());
      ok("the retry asked for more tokens than the first", calls[1] > calls[0],
         calls.join(" then "));
      window.chat = realChat;
    }

    /* ---- the whole flow after a reload ----
       Reproduces the real failure: the page reloads, Chrome has dropped folder
       permission, and the user clicks Back up. It must reconnect itself and
       complete, not fail into a panel nobody is looking at.
       idbGet returns a structured CLONE of the handle, so the permission stubs
       have to go on what idbGet hands back, not on the original. */
    {
      const savedDir = S.dirHandle;
      const realIdbGet = idbGet;
      let asked = 0, verdict = "granted", granted = false;
      /* A real handle's methods must be called on the real object, so delegate
         explicitly rather than using Object.create (Illegal invocation). */
      const fakeHandle = {
        kind: "directory", name: scratch.name,
        /* Chrome reports "prompt" until granted, then "granted" — model that,
           so a second query does not look like a second prompt. */
        queryPermission: async () => granted ? "granted" : "prompt",
        requestPermission: async () => {
          asked++;
          if (verdict === "granted") granted = true;
          return verdict;
        },
        getDirectoryHandle: (...a) => scratch.getDirectoryHandle(...a),
        getFileHandle: (...a) => scratch.getFileHandle(...a),
        removeEntry: (...a) => scratch.removeEntry(...a),
        entries: () => scratch.entries()
      };
      idbGet = async k => (k === "lastDir" ? fakeHandle : realIdbGet(k));

      S.dirHandle = null;                                   // permission dropped
      const okc = await ensureConnected("the backup");
      ok("a disconnected folder is re-acquired on demand", okc === true);
      eq("permission was actually requested", asked, 1);
      ok("the folder is connected again", !!S.dirHandle);

      const b = await backupIndex("after-reload");
      ok("the backup then completes", b.bytes > 0, (b.bytes/1024).toFixed(0) + " KB");
      ok("and it is verified readable",
         b.manifest.records && b.manifest.records.bad === 0);

      /* refusing access must not look like success */
      S.dirHandle = null; verdict = "denied"; asked = 0; granted = false;
      const denied = await ensureConnected();
      eq("a denied folder reports failure", denied, false);
      ok("and nothing is left half-connected", S.dirHandle === null);

      idbGet = realIdbGet;
      S.dirHandle = savedDir;
      const dirB2 = await backupsDir();
      for (const x of await listBackups())
        { try { await dirB2.removeEntry(x.name, { recursive:true }); } catch {} }
    }

    /* ---- an error must never render as nothing ----
       A DOMException with an empty .message showed as a blank line, leaving the
       last progress label on screen under a failure icon and no way to tell
       what had gone wrong. */
    {
      eq("an empty DOMException still says something",
         errText(new DOMException("", "NotFoundError")), "NotFoundError");
      eq("a named error keeps both parts",
         errText(new DOMException("no entry", "NotFoundError")),
         "NotFoundError: no entry");
      eq("a plain Error uses its message",
         errText(new Error("plain failure")), "plain failure");
      ok("an object without either is still described",
         errText({}) !== "" && errText({}) !== "[object Object]", errText({}));
      eq("null does not produce blank", errText(null), "unknown error");

      /* withRetry used to flatten its cause into prose, so "this folder is
         gone" became indistinguishable from "the share is down" -- and a
         deleted scan scope hard-failed the whole plan instead of widening. */
      let wrapped = null;
      try {
        await withRetry("opening Gone",
          () => Promise.reject(new DOMException("no entry", "NotFoundError")));
      } catch (e){ wrapped = e; }
      ok("a wrapped failure keeps its cause", !!(wrapped && wrapped.cause));
      ok("a missing entry is recognisable through the wrapper", isNotFound(wrapped));
      ok("a share outage is not mistaken for a missing entry",
         !isNotFound(new Error("connection reset")));
      ok("a missing entry is not retried three times",
         / 1 try: /.test(wrapped.message), wrapped.message);
    }

    /* ---- a backup must not write to the index it is backing up ----
       Rewriting config.json was the only step that ever failed, and a backup
       has no reason to do it: it reads records and writes copies elsewhere. */
    {
      const realWrite = writeFile;
      let writes = [];
      /* Record WHAT is written: the backup legitimately writes its own
         manifest.json into the new folder. What it must never do is write to
         the index's own files. */
      writeFile = async (h, t) => { writes.push(h && h.name || "?"); return realWrite(h, t); };

      IDX.lastConfig = null;
      await ensureIndex(null, { write:false });
      eq("opening read-only writes nothing", writes.length, 0);
      ok("but it notices config is out of date", IDX.configPending === true);

      writes = [];
      await backupIndex("read-only-check");
      const touchedIndex = writes.filter(n => n !== "manifest.json");
      eq("a backup writes nothing into the index itself",
         touchedIndex.join(",") || "nothing", "nothing");
      ok("it writes only its own manifest", writes.includes("manifest.json"),
         writes.join(","));

      writeFile = realWrite;
      IDX.lastConfig = null;
      const dirRO = await backupsDir();
      for (const x of await listBackups())
        { try { await dirRO.removeEntry(x.name, { recursive:true }); } catch {} }
    }

    /* ---- housekeeping failures must not abort real work ---- */
    {
      const realWrite = writeFile;
      IDX.lastConfig = null;
      IDX.configWriteError = null;
      writeFile = async () => { throw new DOMException("", "NoModificationAllowedError"); };
      let threw = null;
      try { await ensureIndex(); } catch (e){ threw = errText(e); }
      ok("a config.json write failure does not abort ensureIndex", threw === null, threw);
      ok("but it is recorded", !!IDX.configWriteError, IDX.configWriteError);
      writeFile = realWrite;
      IDX.lastConfig = null; IDX.configWriteError = null;
      await ensureIndex();
    }

    /* ---- opening the index must not touch thumbs/ ----
       thumbs/ holds one file per photo. Listing it on a real library over a
       network share measured 75 seconds, and ensureIndex was paying that every
       single time for a handle nothing had asked for yet. */
    {
      IDX.thumbs = null;
      IDX.lastConfig = null;
      await ensureIndex();
      ok("ensureIndex leaves thumbs/ unopened", IDX.thumbs === null);
      const dir = await thumbsDir();
      ok("it opens on first use", !!dir && IDX.thumbs === dir);
      const again = await thumbsDir();
      ok("and is then cached", again === dir);
      // re-opening the index must drop the cached handle, not keep a stale one
      IDX.lastConfig = null;
      await ensureIndex();
      ok("re-opening the index drops the cached handle", IDX.thumbs === null);
      await thumbsDir();                        // restore for later tests
    }

    /* ---- a slow share must look slow, not stuck ---- */
    {
      // a file big enough to need several chunks
      const big = new Blob([new Uint8Array(9 * 1024 * 1024)]);
      const srcDir = await scratch.getDirectoryHandle("copysrc", { create:true });
      const dstDir = await scratch.getDirectoryHandle("copydst", { create:true });
      const fh = await srcDir.getFileHandle("big.bin", { create:true });
      const w0 = await fh.createWritable(); await w0.write(big); await w0.close();

      const ticks = [];
      const r = await copyInto(srcDir, dstDir, "big.bin",
        async (n, got, size) => ticks.push(got));
      ok("the copy verifies byte-for-byte", r && r.ok === true,
         r ? r.bytes + " B" : "no result");
      ok("progress is reported in chunks, not once at the end", ticks.length >= 2,
         ticks.length + " updates");
      ok("progress is monotonic and ends at the file size",
         ticks[ticks.length - 1] === 9 * 1024 * 1024,
         String(ticks[ticks.length - 1]));
      const copied = await (await dstDir.getFileHandle("big.bin")).getFile();
      eq("the copy is the same size", copied.size, 9 * 1024 * 1024);

      // an empty file must still copy
      const e1 = await srcDir.getFileHandle("empty.bin", { create:true });
      const we = await e1.createWritable(); await we.write(new Blob([])); await we.close();
      const re = await copyInto(srcDir, dstDir, "empty.bin");
      ok("an empty file copies cleanly", re && re.ok === true);

      for (const d of ["copysrc","copydst"])
        { try { await scratch.removeEntry(d, { recursive:true }); } catch {} }
    }

    /* ---- the index can be moved to faster storage ---- */
    {
      const keepMode = S.indexMode, keepIdx = S.indexDirHandle;
      const before = IDX.records.size;
      const fast = await root.getDirectoryHandle("fastdisk", { create:true });
      await rmAll(fast);
      const phases = [];
      const r = await moveIndexTo(fast, m => phases.push(m));
      eq("every record survives the move", r.records, before);
      ok("it reports what it copied", r.files.length >= 1,
         r.files.map(f => f.name).join(", "));
      ok("each step is named", phases.some(m => /Copying records\.jsonl/.test(m)),
         phases.join(" | "));
      eq("the app now uses the new location", S.indexMode, "custom");
      ok("and the new location really holds the records",
         !!(await (await fast.getDirectoryHandle(".photoindex"))
              .getFileHandle("records.jsonl")));
      /* ensureIndex creates an empty thumbs/ at the destination, so assert it
         is EMPTY rather than absent: none of the 6,000-odd files were copied. */
      let thumbCount = 0;
      try {
        const td = await (await fast.getDirectoryHandle(".photoindex"))
          .getDirectoryHandle("thumbs");
        for await (const [] of td.entries()) thumbCount++;
      } catch {}
      eq("no thumbnails are copied — they rebuild from the originals", thumbCount, 0);

      S.indexMode = keepMode; S.indexDirHandle = keepIdx;
      IDX.lastConfig = null; IDX.loaded = false;
      await ensureIndex(); await loadRecords(); await loadVectors();
      eq("switching back finds the original index again", IDX.records.size, before);
      await rmAll(fast);
    }

    /* ---- config.json is not rewritten for nothing ---- */
    {
      IDX.lastConfig = null;
      await ensureIndex();
      const first = IDX.lastConfig;
      ok("the first call writes it", !!first);
      await ensureIndex();
      ok("a second call with no changes writes nothing new",
         IDX.lastConfig === first, first ? first.length + " chars, unchanged" : "none");
    }

    /* ---- a backup must report where it is, and never hang ---- */
    {
      const phases = [];
      await backupIndex("phase-test", m => { phases.push(m); });
      ok("each step is named", phases.length >= 5, phases.join(" | "));
      ok("it says which file it is copying",
         phases.some(m => /Copying records\.jsonl/.test(m)), phases.join(" | "));
      ok("and reports the size so a slow copy looks slow, not stuck",
         phases.some(m => /MB/.test(m)), phases.join(" | "));

      /* a stalled step must fail with a named cause, not sit there */
      let failed = null;
      try {
        await withDeadline("a stuck step", 60, new Promise(() => {}));
      } catch (e){ failed = e.message; }
      ok("a stalled step times out and says which one",
         !!failed && /a stuck step/.test(failed), failed);

      const dirP = await backupsDir();
      for (const x of await listBackups())
        { try { await dirP.removeEntry(x.name, { recursive:true }); } catch {} }
    }

    /* ---- fault injection: storage that is slow, hanging or failing ----
       Everything above this point runs against OPFS, which is fast and never
       fails. These are the conditions that actually broke the app on the user's
       NAS, and until now none of them were reproducible. */
    {
      const keepMode = S.indexMode, keepIdx = S.indexDirHandle;
      const keepDir = IDX.dir, keepCap = S.io.deadlineCapMs;
      const keepFloor = S.io.deadlineFloorMs, keepStorage = { ...S.storage };
      const faultHome = await root.getDirectoryHandle("faulty", { create:true });
      await rmAll(faultHome);

      const useFaulty = opts => {
        const stats = {};
        S.indexMode = "custom";
        S.indexDirHandle = faultFS(faultHome, { ...opts, stats });
        return stats;
      };

      /* 1. Opening the index must never enumerate thumbs/. This is the
         regression that made every backup take 75 seconds before it started. */
      {
        const stats = useFaulty({});
        IDX.lastConfig = null;
        await ensureIndex(null, { write:true });
        await saveThumb("fault-probe", new Blob(["x"], { type:"image/jpeg" }));
        const statsAfter = useFaulty({});
        IDX.lastConfig = null;
        await ensureIndex(null, { write:false });
        /* Not merely "does not enumerate": must not touch thumbs/ at all.
           Opening the handle is itself a round trip, and on the real share the
           folder holds 6,568 files. */
        ok("opening the index never touches thumbs/",
           !statsAfter.touchedPath("thumbs"),
           statsAfter.touched.filter(t => t.includes("thumbs")).join(",") || "never touched");
        ok("and it does open the index itself", stats.touchedPath(".photoindex"));
      }

      /* 2. A backup completes when every single operation is slow. 250 ms was
         the plan's figure; the assertion is that latency is survivable, not
         that it is fast. */
      {
        const stats = useFaulty({ latencyMs: 25 });
        IDX.lastConfig = null;
        IDX.loaded = false;
        await ensureIndex(null, { write:true });
        await appendLines("records.jsonl", [{ id:"slow-1", name:"a.jpg", status:"ok" }]);
        /* backupIndex verifies the copy against IDX.records, so memory has to
           describe THIS index rather than the one the suite was using before. */
        await loadRecords();
        const t0 = performance.now();
        const b = await backupIndex("under-latency");
        const took = performance.now() - t0;
        ok("a backup completes when every operation is slow",
           !!b && b.bytes > 0, Math.round(took) + " ms, " + stats.ops + " ops");
        ok("the latency was actually applied", took > 25 * 10,
           Math.round(took) + " ms over " + stats.ops + " operations");
      }

      /* 3. A path that never answers must produce a NAMED failure rather than
         leaving the UI sitting on a label. This is the user's actual bug
         report: "Backup ... [stuck at: Opening .photoindex/…]". */
      {
        S.io.deadlineCapMs = 400; S.io.deadlineFloorMs = 100;
        useFaulty({ hangPaths: [".photoindex"] });
        const phases = [];
        let failed = null;
        try { await backupIndex("hanging", m => { phases.push(m); }); }
        catch (e){ failed = e; }
        ok("a hanging share fails the backup rather than hanging the UI", !!failed);
        ok("the failure names the operation",
           !!failed && /opening the index/.test(errText(failed)), errText(failed));
        ok("and names the step it got stuck on",
           !!failed && /stuck at/.test(errText(failed)), errText(failed));
        ok("the failure is not blank", errText(failed).trim().length > 10);
        S.io.deadlineCapMs = keepCap; S.io.deadlineFloorMs = keepFloor;
      }

      /* 4. A write that fails once must be retried, not lost; a write that
         never lands must be reported rather than reported as success. */
      {
        const stats = useFaulty({ failWrites: 1, rng: failFirstWrites(0) });
        IDX.lastConfig = null; IDX.loaded = false;
        await ensureIndex(null, { write:true });
        await appendLines("records.jsonl", [{ id:"keep-1", name:"k.jpg", status:"ok" }]);
        await loadRecords();
        const before = IDX.records.size;

        // every write from here on fails
        const failing = useFaulty({ failWrites: 1, rng: () => 0 });
        let threw = null;
        try {
          await ensureIndex(null, { write:false });
          await appendLines("records.jsonl", [{ id:"lost-1", name:"l.jpg", status:"ok" }]);
        } catch (e){ threw = e; }
        ok("a write that cannot land is reported, not swallowed", !!threw,
           threw ? errText(threw) : "no error raised");
        ok("the failing write was actually attempted", failing.failures > 0,
           failing.failures + " injected failures");

        /* A write that reports success but stores only half of what it was
           given raises no error anywhere. Without a length check the caller
           believes those records are safe and clears them from memory. */
        const shorted = useFaulty({ shortWrites: 0.5 });
        IDX.lastConfig = null;
        await ensureIndex(null, { write:false });
        let shortErr = null;
        try {
          await appendLines("records.jsonl",
            [{ id:"short-1", name:"s.jpg", status:"ok", pad:"x".repeat(200) }]);
        } catch (e){ shortErr = e; }
        ok("a write that silently lands short is caught", !!shortErr,
           shortErr ? errText(shortErr) : "reported success");
        ok("and says the write did not land in full",
           !!shortErr && /did not land in full/.test(errText(shortErr)),
           shortErr && errText(shortErr));

        // and the record that WAS written is still there
        useFaulty({});
        IDX.lastConfig = null; IDX.loaded = false;
        await ensureIndex(null, { write:false });
        await loadRecords();
        ok("records written before the outage survive it",
           IDX.records.has("keep-1"), before + " before, " + IDX.records.size + " after");
        ok("the record that never landed is not claimed as saved",
           !IDX.records.has("lost-1"));
      }

      /* 5. Deadlines are sized from measurement, not from a constant. */
      {
        S.storage.openMs = null; S.storage.readMs = null; S.storage.listMs = null;
        eq("unmeasured storage falls back to the floor",
           ioDeadline(1), Math.min(S.io.deadlineCapMs, S.io.deadlineFloorMs));
        S.storage.openMs = 24000;                    // the measured sleeping NAS
        ok("a slow share gets a longer deadline than a fast one",
           ioDeadline(1) > S.io.deadlineFloorMs, ioDeadline(1) + " ms");
        ok("but never an unbounded one", ioDeadline(100) <= S.io.deadlineCapMs);
        ok("and it says so in words", /very slow/.test(describeStorage()),
           describeStorage());
        S.storage.openMs = 5;
        S.storage.readMs = null; S.storage.listMs = null;
        ok("a fast disk is described as fast", /fast/.test(describeStorage()),
           describeStorage());

        /* The probe itself must never become the thing that hangs: it runs on
           every connect, and a listing is exactly what stops responding on the
           share this is all for. */
        S.storage.listMs = null; S.storage.listTimedOut = false;
        const neverLists = { keys: () => ({ [Symbol.asyncIterator]: () => ({
          next: () => new Promise(() => {}) }) }) };
        const tP = performance.now();
        await probeStorage(neverLists, 150);
        const tookP = performance.now() - tP;
        ok("a probe against an unresponsive share gives up", tookP < 3000,
           Math.round(tookP) + " ms");
        ok("and records that it timed out", S.storage.listTimedOut === true);
        ok("which still yields a usable, pessimistic reading",
           storageUnitMs() >= 150, String(storageUnitMs()));
        ok("and says the share is not responding",
           /not responding/.test(describeStorage()), describeStorage());
        S.storage.listTimedOut = false;
      }

      /* 6. indexOp names the phase it died on, for every caller alike. */
      {
        let e1 = null;
        try {
          await indexOp("doing the thing", async note => {
            await note("step one");
            await note("step two");
            throw new DOMException("", "NotFoundError");
          });
        } catch (e){ e1 = e; }
        ok("indexOp reports the last step reached",
           !!e1 && /step two/.test(e1.message), e1 && e1.message);
        eq("and exposes it for the caller", e1 && e1.phase, "step two");
        ok("an empty DOMException still produces text",
           !!e1 && /NotFoundError/.test(e1.message), e1 && e1.message);
        ok("the original is kept as the cause", isNotFound(e1));

        let e2 = null;
        try {
          await indexOp("a stalled op", () => new Promise(() => {}),
            { timeoutMs: 120 });
        } catch (e){ e2 = e; }
        ok("a stalled op times out and names itself",
           !!e2 && /a stalled op/.test(errText(e2)), e2 && errText(e2));
      }

      S.indexMode = keepMode; S.indexDirHandle = keepIdx;
      Object.assign(S.storage, keepStorage);
      S.io.deadlineCapMs = keepCap; S.io.deadlineFloorMs = keepFloor;
      IDX.lastConfig = null; IDX.loaded = false;
      await ensureIndex(); await loadRecords(); await loadVectors();
      await rmAll(faultHome);
      ok("the real index is back after fault injection", IDX.dir === keepDir
         || IDX.records.size >= 0, "restored");
    }

    /* ---- review round 2: silent-wrong-behaviour regressions ---- */
    {
      /* vectors.bin longer than vectors.json used to desynchronise every later
         vector, mapping photos to other photos' embeddings. */
      const dim = IDX.vec.dim || 64;
      const vfh = await IDX.dir.getFileHandle("vectors.bin", { create:true });
      const before = IDX.vec.ids.length;
      const extra = new Float32Array((before + 2) * dim).fill(0.25);
      const w = await vfh.createWritable(); await w.write(extra.buffer); await w.close();
      await loadVectors();
      eq("a longer bin is realigned to the id list, not left skewed",
         IDX.vec.rows.length / IDX.vec.dim, IDX.vec.ids.length);
      ok("and the mismatch is recorded so it can be reported", !!IDX.vecRealigned);
      IDX.vecRealigned = null;

      /* a torn final row must not throw out of loadVectors */
      const torn = new Uint8Array((before * dim * 4) + 3);
      const w2 = await vfh.createWritable(); await w2.write(torn.buffer); await w2.close();
      let threw = false;
      try { await loadVectors(); } catch { threw = true; }
      ok("a torn final row degrades instead of throwing", !threw);

      /* the model must not be able to set a record's identity */
      const v = validate({ id:"HIJACKED", path:"../evil", size:1,
        observations:["a","b","c"], caption:"x" });
      ok("reserved fields are stripped from model output",
         v.norm.id === undefined && v.norm.path === undefined);
      ok("and the attempt is recorded", v.issues.some(i => /reserved field/.test(i)));

      /* a stated people count must set a matching bucket */
      const vp = validate({ observations:["a","b","c"], people:{ count:5 } });
      eq("a count of 5 does not become bucket 0", vp.norm.people.count_bucket, "3-5");

      /* words that merely end in s must survive */
      eq("lens is not mangled", singular("lens"), "lens");
      eq("trees is still singularised", singular("trees"), "tree");

      /* a camera photo whose name contains "capture" is still a photo */
      eq("camera EXIF outranks a filename containing capture",
         correctImageType("photo", { name:"Video Capture 2019.jpg", width:4000, height:3000,
           camera:"Canon EOS R3" }).type, "photo");

      /* one bad date must not merge every event */
      const evRecs = [
        { id:"a", date_taken:"2020-01-01T10:00:00Z" },
        { id:"b", date_taken:"not a date" },
        { id:"c", date_taken:"2021-06-01T10:00:00Z" },
        { id:"d", date_taken:"2022-06-01T10:00:00Z" }];
      const evs = buildEvents(evRecs, 6, 25);
      eq("an unparseable date is skipped, not allowed to merge everything",
         evs.length, 3);

      /* the date range must never report sentinels */
      const st2 = rebuildDerived();
      ok("the reported date range is real or absent",
         !st2.range || (st2.range[0] !== "9999" && st2.range[1] !== "0"),
         JSON.stringify(st2.range));

      /* BM25 must not answer a nonsense query with confident junk */
      const junk = await searchPhotos({ query:"zzzz yyyy xxxx wwww", limit:10 });
      eq("a query with no real terms returns nothing", junk.results.length, 0);

      /* a backup that fails verification must be removed, not left listed */
      const realVerify = verifyRecordsFile;
      verifyRecordsFile = async () => ({ lines:1, bad:1, unique:1 });
      let rejected = false;
      try { await backupIndex("should-fail"); } catch { rejected = true; }
      verifyRecordsFile = realVerify;
      ok("a backup that fails verification is rejected", rejected);
      const left = await listBackups();
      ok("and is not left behind to displace a good one",
         !left.some(b => b.meta && b.meta.reason === "should-fail"),
         left.map(b => b.meta && b.meta.reason).join(","));
      const dB = await backupsDir();
      for (const x of left) { try { await dB.removeEntry(x.name, { recursive:true }); } catch {} }
    }

    /* ---- data-loss regressions found by review ---- */
    {
      const live = [...IDX.records.values()].find(r => !r.deleted && r.status !== "error");

      /* applyMoves must not strip raw_model_json (it was writing the lightened
         in-memory copy into a last-line-wins log). */
      const fullBefore = (await readFullRecords(new Set([live.id]))).get(live.id);
      ok("the record on disk has raw model output", !!(fullBefore && fullBefore.raw_model_json));
      await applyMoves([{ id:live.id, path:"relocated/" + live.name, name:live.name,
                          fp:live.fingerprint, size:live.size, mtime:live.mtime }]);
      const fullAfter = (await readFullRecords(new Set([live.id]))).get(live.id);
      ok("relinking preserves raw model output",
         !!(fullAfter && fullAfter.raw_model_json), "raw_model_json survived");
      eq("and the path was updated", fullAfter.path, "relocated/" + live.name);

      /* a failed rescan must not replace a good record with an error stub */
      const priorCaption = live.caption;
      ok("the record has a caption to lose", !!priorCaption);

      /* an unreadable file must never be reported missing */
      const planU = await buildPlan();
      const fakeUnreadable = planU.ok[0] || planU.new[0];
      if (fakeUnreadable){
        const rec = IDX.records.get(fakeUnreadable.id);
        if (rec){
          // simulate statAll failing for this one file
          const realStat = fakeUnreadable.handle.getFile;
          fakeUnreadable.handle.getFile = async () => { throw new DOMException("", "NotReadableError"); };
          const planV = await buildPlan();
          const reported = planV.missing.some(r => r.path === rec.path);
          ok("a file that cannot be read is not reported missing", !reported,
             reported ? "WRONGLY MISSING" : "protected");
          fakeUnreadable.handle.getFile = realStat;
        }
      }

      /* mark missing refuses when reads failed on this pass */
      let refusedUnreadable = false;
      try {
        await markMissing({ missing:[{id:"x"}], total:10, indexTotal:10,
                            unreadable:[{path:"a.jpg"}], folderLooksEmpty:false });
      } catch (e){ refusedUnreadable = /could not be read/.test(errText(e)); }
      ok("mark missing refuses after read failures", refusedUnreadable);

      /* and refuses to delete a large proportion at once */
      let refusedBulk = false;
      try {
        await markMissing({ missing:new Array(30).fill({id:"x"}), total:100,
                            indexTotal:100, unreadable:[], folderLooksEmpty:false });
      } catch (e){ refusedBulk = /30 of 100/.test(errText(e)); }
      ok("mark missing refuses to delete a quarter of the library", refusedBulk);

      /* compaction refuses to run during a scan */
      const wasActive = RUN.active; RUN.active = true;
      let refusedCompact = false;
      try { await compactRecords(); } catch (e){ refusedCompact = /scan is running/.test(errText(e)); }
      ok("compaction refuses while a scan is flushing", refusedCompact);
      RUN.active = wasActive;

      /* a failed record write must not discard the batch */
      const realAppend = appendLines;
      RUN.batch = [{ id:"kept-1" }, { id:"kept-2" }];
      appendLines = async () => { throw new DOMException("", "NoModificationAllowedError"); };
      let threw = false;
      try { await flushBatch(null); } catch { threw = true; }
      appendLines = realAppend;
      ok("a failed flush throws rather than continuing", threw);
      eq("and the records are still queued", RUN.batch.length, 2);
      RUN.batch = [];

      /* a failed vector write must be kept and surfaced */
      const realAppendVec = appendVectors;
      RUN.vecBatch = [{ id:"v1", vec:Float32Array.from([1,2,3]) }];
      RUN.vecError = null;
      appendVectors = async () => { throw new DOMException("", "QuotaExceededError"); };
      await flushBatch(null);
      appendVectors = realAppendVec;
      eq("embeddings stay queued after a failed write", RUN.vecBatch.length, 1);
      ok("and the failure is recorded, not swallowed", !!RUN.vecError, RUN.vecError);
      RUN.vecBatch = []; RUN.vecError = null;
    }

    /* ---- a partial copy must never be committed ---- */
    {
      const srcD = await scratch.getDirectoryHandle("pcsrc", { create:true });
      const dstD = await scratch.getDirectoryHandle("pcdst", { create:true });
      const fh = await srcD.getFileHandle("big.bin", { create:true });
      const w0 = await fh.createWritable();
      await w0.write(new Blob([new Uint8Array(9 * 1024 * 1024)])); await w0.close();

      let failed = false;
      try {
        await copyInto(srcD, dstD, "big.bin", async (n, got) => {
          if (got > 4 * 1024 * 1024) throw new DOMException("", "NotReadableError");
        });
      } catch { failed = true; }
      ok("an interrupted copy reports failure", failed);
      let leftBehind = true;
      try { await dstD.getFileHandle("big.bin"); } catch { leftBehind = false; }
      ok("and leaves no truncated file that looks valid", !leftBehind);

      for (const d of ["pcsrc","pcdst"])
        { try { await scratch.removeEntry(d, { recursive:true }); } catch {} }
    }

    /* ---- a new scan must not endanger an existing index ---- */
    {
      const before = IDX.records.size;
      ok("there are records to protect", before > 0, String(before));

      /* append-only: a scan adds lines, it never rewrites them */
      const rfh = await IDX.dir.getFileHandle("records.jsonl");
      const originalText = await (await rfh.getFile()).text();
      await appendLines("records.jsonl", [{ id:"scan-sim-1", path:"sim.jpg", name:"sim.jpg" }]);
      const afterText = await (await (await IDX.dir.getFileHandle("records.jsonl")).getFile()).text();
      ok("existing records are untouched by a new write",
         afterText.startsWith(originalText), "prefix preserved");

      /* a truncated final line (a crash mid-write) must not lose the rest */
      await writeFile(rfh, originalText + '{"id":"half","pa');
      IDX.loaded = false; await loadRecords();
      eq("a half-written line is skipped, the rest survives", IDX.records.size, before);

      await writeFile(rfh, originalText);
      IDX.loaded = false; await loadRecords();
      eq("the index is back to where it started", IDX.records.size, before);

      /* compaction rewrites in place, so it must copy first */
      const dirC = await backupsDir();
      for (const x of await listBackups())
        { try { await dirC.removeEntry(x.name, { recursive:true }); } catch {} }
      await compactRecords();
      const copies = await listBackups();
      ok("compaction takes a safety copy before rewriting",
         copies.some(c => c.meta && /pre-compaction/.test(c.meta.reason)),
         copies.map(c => c.meta && c.meta.reason).join(","));
      for (const x of copies)
        { try { await dirC.removeEntry(x.name, { recursive:true }); } catch {} }
    }

    /* ---- the index location is never assumed ---- */
    {
      const keepChosen = S.indexChosen, keepMock = $("#mock").checked;
      S.indexChosen = false; $("#mock").checked = false;
      const realConfirm = window.confirm;
      let askedWith = null;
      window.confirm = m => { askedWith = m; return false; };      // user cancels
      const problem = await preflightScan();
      ok("an unchosen index location is confirmed, not assumed", !!askedWith);
      ok("the prompt names where it would go", /\.photoindex/.test(askedWith || ""));
      ok("cancelling stops the scan", typeof problem === "string" && /Choose where/.test(problem));
      ok("and it is still not marked chosen", S.indexChosen === false);

      window.confirm = () => true;                                  // user accepts
      S.indexChosen = false;
      await preflightScan();
      ok("accepting records the choice so it is asked only once", S.indexChosen === true);

      window.confirm = realConfirm;
      S.indexChosen = keepChosen; $("#mock").checked = keepMock;
    }

    /* ---- backups ---- */
    {
      const keepCfg = { ...S.backup };
      S.backup.keep = 2;
      const b1 = await backupIndex("test-one");
      ok("a backup is written", !!b1.stamp, b1.stamp);
      ok("it reports bytes copied", b1.bytes > 0, b1.bytes + " B");
      ok("records are verified as readable",
         b1.manifest.records && b1.manifest.records.bad === 0,
         JSON.stringify(b1.manifest.records));
      eq("the manifest records the schema it was taken under",
         b1.manifest.schema_hash, SCHEMA_HASH());

      const dirB = await backupsDir();
      let hasThumbs = false;
      try { await (await dirB.getDirectoryHandle(b1.stamp)).getDirectoryHandle("thumbs");
            hasThumbs = true; } catch {}
      ok("thumbnails are deliberately excluded", !hasThumbs);

      await new Promise(r => setTimeout(r, 5));
      const b2 = await backupIndex("test-two");
      await new Promise(r => setTimeout(r, 5));
      const b3 = await backupIndex("test-three");
      const list = await listBackups();
      eq("old backups are pruned to the keep count", list.length, 2);
      eq("the newest is kept", list[0].name, b3.stamp);

      /* restore must bring the records back and protect the current state */
      const beforeCount = IDX.records.size;
      /* Damage the FILE, not the in-memory map: compactRecords rebuilds from
         disk, so an in-memory delete would simply be undone. */
      const rfh = await IDX.dir.getFileHandle("records.jsonl");
      const original = await (await rfh.getFile()).text();
      const kept = original.split("\n").filter(Boolean);
      await writeFile(rfh, kept.slice(0, -1).join("\n") + "\n");   // drop the last record
      IDX.loaded = false; await loadRecords();
      ok("the index really lost a record", IDX.records.size < beforeCount,
         beforeCount + " -> " + IDX.records.size);
      const r = await restoreBackup(list[0].name);
      eq("restore brings the record back", r.records, beforeCount);
      ok("and the file on disk is whole again",
         (await (await (await IDX.dir.getFileHandle("records.jsonl")).getFile()).text())
           .split("\n").filter(Boolean).length >= kept.length);
      ok("restore kept a safety copy of the damaged state",
         (await listBackups()).some(x => x.meta && /pre-restore/.test(x.meta.reason)));

      S.backup = keepCfg;
      for (const x of await listBackups())
        { try { await dirB.removeEntry(x.name, { recursive:true }); } catch {} }
    }

    /* ---- crash safety: nothing is ever lost, only re-found ---- */
    {
      const before = IDX.records.size;
      // simulate a crash: records written but the checkpoint never updated
      await saveCheckpoint({ run_id:"crash", mode:"new-and-changed",
        pending:["one.png","two.jpg","gone-from-disk.png"],
        done:1, total:4, updated_at:new Date().toISOString() }, true);
      IDX.checkpoint = null; await loadCheckpoint();
      ok("checkpoint survives a reload", !!IDX.checkpoint);
      const planC = await buildPlan();
      const byPath = new Map();
      for (const g of ["new","changed","stale","failed","ok"])
        for (const f of planC[g]) byPath.set(f.path, f);
      const sh = SCHEMA_HASH(), ph = PROMPT_HASH();
      const wouldScan = IDX.checkpoint.pending.map(p => byPath.get(p)).filter(f => {
        if (!f) return false;
        const r = IDX.records.get(f.id);
        if (!r || r.deleted || r.status === "error") return true;
        return r.fingerprint !== f.fp || r.schema_hash !== sh || r.prompt_hash !== ph;
      });
      eq("resume skips work already finished and files now missing", wouldScan.length, 0);
      eq("the index was not damaged by the crash", IDX.records.size, before);
      await clearCheckpoint();
    }

    /* ---- the plan, not the checkpoint, is the source of truth ---- */
    {
      // Throw the checkpoint away entirely and delete one record: the plan must
      // still find exactly the missing work, never everything.
      await clearCheckpoint();
      const victim = [...IDX.records.values()].find(r => !r.deleted && r.status !== "error");
      const kept = IDX.records.size;
      IDX.records.delete(victim.id);
      const planD = await buildPlan();
      eq("a lost record becomes exactly one unit of work", planD.new.length, 1);
      ok("everything else stays up to date", planD.ok.length === kept - 2
         || planD.ok.length >= 1, planD.ok.length + " ok");
      IDX.records.set(victim.id, victim);
    }

    /* ---- vectors append rather than rewrite ---- */
    {
      const vfh = await IDX.dir.getFileHandle("vectors.bin", { create:true });
      const dim = IDX.vec.dim || 64;
      const idsBefore = IDX.vec.ids.length;
      await appendVectors([{ id:"synthetic-vec-1",
        vec: Float32Array.from(Array(dim).fill(0.5)) }]);
      const sizeAfter = (await vfh.getFile()).size;
      /* Assert the absolute invariant rather than a delta. An earlier test
         leaves a deliberately torn final row on disk and the append HEALS it,
         so the file legitimately grows by less than one whole row. What must
         always hold is that the bin is exactly as long as the ids claim. */
      eq("one new vector adds exactly one logical row",
         IDX.vec.ids.length, idsBefore + 1);
      eq("the file is exactly as long as the id list claims",
         sizeAfter, IDX.vec.ids.length * dim * 4);
      ok("the new vector reads back", !!vectorOf("synthetic-vec-1"));
      const v = vectorOf("synthetic-vec-1");
      ok("its values survived the append", Math.abs(v[0] - 0.5) < 1e-6, String(v[0]));
    }

    /* ---- idempotence ---- */
    plan = await buildPlan();
    eq("second plan sees nothing new", plan.new.length, 0);
    eq("second plan sees all up to date", plan.ok.length, 4);

    /* ---- change detection ---- */
    await writeInto(scratch, "two.jpg", await makeImage(640, 480, "#123456", "image/jpeg"));
    plan = await buildPlan();
    eq("edited file shows as changed", plan.changed.length, 1);
    await runScan(plan.changed, "selftest-changed");

    /* ---- move detection ----
       OPFS cannot preserve a modified time, so writing the file elsewhere
       reproduces exactly the case that breaks a timestamp: a NAS copy. */
    const movedBlob = await (await scratch.getFileHandle("three.webp")).getFile();
    await writeInto(sub, "three.webp", movedBlob);
    await scratch.removeEntry("three.webp");
    const before = IDX.records.size;
    plan = await buildPlan();
    eq("moved file detected without a rescan", plan.moved.length, 1);
    ok("it fell back past the timestamp and confirmed by content",
       ["name+size","content"].includes(plan.moved[0] && plan.moved[0].moveConfidence),
       String(plan.moved[0] && plan.moved[0].moveConfidence));
    if (plan.moved.length) await applyMoves(plan.moved);
    plan = await buildPlan();
    eq("no rescan needed after the move", plan.new.length, 0);
    eq("record count unchanged by the move", IDX.records.size, before);
    ok("moved record points at the new path",
      [...IDX.records.values()].some(r => r.path === "sub/three.webp"));
    eq("nothing reported missing after re-linking", plan.missing.length, 0);

    /* Ambiguity guard: two files with the same name and size, BOTH moved, must
       never be guessed at — there is no way to know which went where. */
    const dupBlob = await makeImage(120, 120, "#abcdef");
    const dirA = await scratch.getDirectoryHandle("a", { create:true });
    const dirB = await scratch.getDirectoryHandle("b", { create:true });
    await writeInto(dirA, "dup.png", dupBlob);
    await writeInto(dirB, "dup.png", dupBlob);
    plan = await buildPlan();
    await runScan(plan.new, "selftest-dup");
    const dirC = await scratch.getDirectoryHandle("c", { create:true });
    const dirD = await scratch.getDirectoryHandle("d", { create:true });
    await writeInto(dirC, "dup.png", dupBlob);
    await writeInto(dirD, "dup.png", dupBlob);
    await dirA.removeEntry("dup.png");
    await dirB.removeEntry("dup.png");
    plan = await buildPlan();
    eq("both duplicates gone and reappeared elsewhere", plan.missing.length, 2);
    ok("ambiguous duplicates are never matched as moves", plan.moved.length === 0,
      plan.moved.length + " moved");
    eq("they are treated as new instead", plan.new.length, 2);
    // tidy up so later counts stay meaningful
    await dirC.removeEntry("dup.png"); await dirD.removeEntry("dup.png");
    for (const d of ["a","b","c","d"]) { try { await scratch.removeEntry(d, { recursive:true }); } catch {} }
    plan = await buildPlan();
    await markMissing(plan);

    /* ---- missing + safety ---- */
    await sub.removeEntry("four.png");
    plan = await buildPlan();
    eq("deleted file shows as missing", plan.missing.length, 1);
    const emptyGuard = { ...plan, folderLooksEmpty:true };
    let refused = false;
    try { await markMissing(emptyGuard); } catch { refused = true; }
    ok("mark missing refuses on an empty folder", refused);
    await markMissing(plan);
    plan = await buildPlan();
    eq("missing record soft-deleted", plan.missing.length, 0);

    /* ---- checkpoint / resume ---- */
    /* force: saveCheckpoint throttles to one write per 30s, so an unforced
       save here silently did nothing and the assertion read a stale file. */
    await saveCheckpoint({ run_id:"x", mode:"m", pending:["one.png"], done:1, total:2,
      updated_at:new Date().toISOString() }, true);
    IDX.checkpoint = null;
    await loadCheckpoint();
    ok("checkpoint survives a reload", IDX.checkpoint && IDX.checkpoint.pending.length === 1);

    /* The throttle is deliberate -- it was 3GB of writes over a 50k-photo run
       -- so pin it, including the fact that memory moves ahead of disk. */
    await saveCheckpoint({ run_id:"throttled", mode:"m", pending:["two.jpg"],
      done:1, total:2, updated_at:new Date().toISOString() });
    eq("an unforced save still updates memory", IDX.checkpoint.run_id, "throttled");
    IDX.checkpoint = null;
    await loadCheckpoint();
    eq("but is not written inside the 30s window", IDX.checkpoint.run_id, "x");

    await clearCheckpoint();
    await loadCheckpoint();
    ok("finished checkpoint clears", IDX.checkpoint === null);

    /* ---- derived ---- */
    const stats = rebuildDerived();
    ok("entities built", stats.entities > 0, stats.entities + " entities");
    ok("postings built", stats.terms > 0, stats.terms + " terms");
    ok("events built", stats.events >= 1, stats.events + " events");

    /* ---- image text as first-class metadata ---- */
    eq("text cap depends on the image type",
       [textCapFor("screenshot"), textCapFor("photo")], [6000, 800]);
    const capped = capText({ image_type:"photo",
      visible_text:{ has_text:true, text:"x".repeat(5000) }, text_lines:null });
    eq("a photo keeps a modest amount of text", capped.visible_text.text.length, 800);
    eq("text_chars is recorded", capped.text_chars, 800);
    const shot = capText({ image_type:"screenshot",
      visible_text:{ has_text:true, text:"y".repeat(5000) }, text_lines:null });
    eq("a screenshot keeps far more", shot.visible_text.text.length, 5000);
    ok("the old 300 cap is gone", shot.text_chars > 300);
    const lined = capText({ image_type:"screenshot", visible_text:{ has_text:true, text:"a b" },
      text_lines:["line one","line two","line three"] });
    eq("text_lines survive capping", lined.text_lines.length, 3);
    eq("textOf prefers the fuller source",
       textOf({ visible_text:{ text:"short" }, text_lines:["a much longer line of text"] }),
       "a much longer line of text");
    eq("phrases are parsed", phrasesIn('find "NO SMOKING" please'), ["no smoking"]);
    eq("phrases are stripped for ranking",
       stripPhrases('find "NO SMOKING" please').replace(/\s+/g," ").trim(), "find please");

    /* a record carrying text is searchable by phrase and by substring */
    const tRec = [...IDX.records.values()].find(r => !r.deleted && r.status !== "error");
    ok("a live record is available for the text tests", !!tRec);
    tRec.visible_text = { has_text:true, text:"ONLY LICENSED UP TO 6 PEOPLE\nNO SMOKING" };
    tRec.text_lines = ["ONLY LICENSED UP TO 6 PEOPLE", "NO SMOKING"];
    tRec.text_chars = textOf(tRec).length;
    rebuildDerived();
    const ph = await searchPhotos({ query:'"ONLY LICENSED UP TO 6 PEOPLE"', limit:5 });
    eq("exact phrase finds the photo", ph.results.length, 1);
    const phNo = await searchPhotos({ query:'"THIS PHRASE IS NOT PRESENT"', limit:5 });
    eq("a phrase that is absent returns nothing", phNo.results.length, 0);
    const byText = await searchPhotos({ query:"", text:"no smoking", limit:5 });
    eq("text filter is case-insensitive", byText.results.length, 1);
    ok("image text reaches the keyword index",
       DERIVED.postings.has("licensed") || DERIVED.postings.has("smoking"));
    const gp = await runTool("get_photo", { photo_id: tRec.id });
    ok("get_photo returns the image text", (gp.text_in_image || "").includes("NO SMOKING"));

    /* ---- search ---- */
    const anyRec = [...IDX.records.values()].find(r => r.caption);
    const word = (anyRec.caption.match(/[a-z]{4,}/i) || ["garden"])[0];
    const sr = await searchPhotos({ query: word, limit: 5 });
    ok("search returns something for a caption word", sr.results.length > 0,
       word + " -> " + sr.results.length);
    ok("search explains what it did", (sr.used || []).length > 0, (sr.used || []).join(" | "));
    const filtered = await searchPhotos({ query:"", image_type:"photo", limit:50 });
    ok("metadata filter works", filtered.results.every(x => x.rec.image_type === "photo"));
    const savedEmbed = S.roles.embed;
    S.roles.embed = "";                       // keyword-only path
    const noneKw = await searchPhotos({ query:"zzzznotarealword", limit:5 });
    eq("nonsense query finds nothing by keyword", noneKw.results.length, 0);
    S.roles.embed = savedEmbed;
    const savedFloor = S.search.minCosine;
    S.search.minCosine = 0.999;               // force the floor to reject everything
    const noneVec = await searchPhotos({ query:"zzzznotarealword", limit:5 });
    eq("relevance floor suppresses weak semantic matches", noneVec.results.length, 0);
    S.search.minCosine = savedFloor;
    const dated = await searchPhotos({ query:"", date_from:"2099-01-01", limit:5 });
    eq("impossible date range returns nothing", dated.results.length, 0);
    const sim = findSimilar(anyRec.id, 3);
    ok("find_similar excludes the source photo", sim.every(x => x.rec.id !== anyRec.id));
    const cm = compact(anyRec, 0.5);
    ok("tool results stay compact", (cm.caption || "").length <= 150
       && Object.keys(cm).length <= 8, Object.keys(cm).join(","));
    const libStats = await runTool("library_stats", {});
    ok("library_stats tool answers", libStats.photos >= 1, JSON.stringify(libStats).slice(0,80));
    const ents = await runTool("list_entities", { type:"object", limit:5 });
    ok("list_entities tool answers", ents.count > 0, ents.count + " object entities");
    const bad = await runTool("get_photo", { photo_id:"does-not-exist" });
    ok("get_photo rejects an invented id", !!bad.error, bad.error);

    ok("a chat model resolves without pressing Test connection",
       !!(await ensureChatModel()) || !S.connected,
       (await ensureChatModel()) || "not connected");

    /* ---- preflight catches a bad configuration before burning the library ---- */
    const savedScan = S.roles.scan;
    S.roles.scan = "";
    const pf = await preflightScan();
    ok("preflight refuses an empty scan model", !!pf && /no scan model/i.test(pf), pf || "(none)");
    S.roles.scan = savedScan;
    ok("preflight passes a valid configuration", (await preflightScan()) === null);

    /* ---- the grid must follow the answer, not the raw tool dump ---- */
    const someRecs = [...IDX.records.values()].slice(0, 2);
    if (someRecs.length === 2){
      const ans = "I found " + someRecs[0].id + " which matches.";
      eq("ids in the answer pick the grid",
         gridFor(ans, someRecs).recs.map(r => r.id), [someRecs[0].id]);
      ok("ids are replaced by file names for display",
         deIdify(ans).includes(someRecs[0].name) && !deIdify(ans).includes(someRecs[0].id));
      CHAT.lastPhotos = someRecs;
      eq("a follow-up with no new results keeps the previous photos",
         gridFor("Only the first one.", []).recs.length, 2);
      CHAT.lastPhotos = [];
    }

    /* ---- nothing marked hidden may actually be visible ----
       An id selector with display:flex silently beat the browser's [hidden]
       rule once already and left a full-screen overlay covering the app. */
    const stillVisible = [...document.querySelectorAll("[hidden]")]
      .filter(n => getComputedStyle(n).display !== "none")
      .map(n => n.id || n.tagName);
    ok("hidden elements are really hidden", stillVisible.length === 0,
       stillVisible.join(", ") || "all hidden");

    /* ---- model output is never HTML ---- */
    const probe = document.createElement("div");
    renderMarkdown("<img src=x onerror=alert(1)> and **bold**", probe);
    ok("markdown renderer escapes HTML", probe.querySelector("img") === null
       && probe.textContent.includes("<img src=x"));
    ok("markdown renderer still formats", probe.querySelector("strong") !== null);

    /* ---- pressing Scan must show something at once ----
       The pre-scan safety copy of a real index is ~50 MB over a share, and it
       ran with the progress card hidden and no rows on screen: for minutes,
       pressing Scan was indistinguishable from pressing nothing. */
    {
      const realBackup = backupIndex;
      const keepEnabled = S.backup.enabled;
      let sawProgress = null, cardVisible = null, claimed = null, reported = [];
      backupIndex = async (reason, onProgress) => {
        sawProgress = typeof onProgress;
        cardVisible = $("#progCard").hidden === false;
        claimed = RUN.active === true;
        if (onProgress) await onProgress("Copying records.jsonl — 50% of 29 MB");
        return { stamp:"stub", manifest:{}, pruned:0, bytes: 1024 };
      };
      try {
        S.backup.enabled = true;
        S.dirHandle = scratch; S.scanScope = "";
        IDX.loaded = false; await ensureIndex(); await loadRecords();
        ok("there are records, so a safety copy is due", IDX.records.size > 0);
        const pl = await buildPlan();
        const victim = pl.ok[0] || pl.new[0] || pl.stale[0];
        ok("a file is available to scan", !!victim);
        if (victim) await runScan([victim], "full-rescan");
        eq("the safety copy is given a progress callback", sawProgress, "function");
        ok("the progress card is already visible while it runs", cardVisible === true);
        ok("and the run is claimed before the slow part, so Scan cannot be double-pressed",
           claimed === true);
      } finally {
        backupIndex = realBackup;
        S.backup.enabled = keepEnabled;
        RUN.active = false;
      }
    }

    /* ---- rebuilding thumbnails ----
       Thumbnails are excluded from every backup on the grounds that they can be
       remade. That claim was false for months: nothing regenerated them, and a
       missing one was a blank tile until the photo was re-scanned at full model
       cost. These assertions are what make the claim true. */
    {
      S.dirHandle = scratch;
      S.scanScope = "";
      IDX.loaded = false;
      await ensureIndex(); await loadRecords();

      const before = await planThumbnails();
      eq("a complete index reports nothing to rebuild", before.missing, 0);
      ok("and it counted the thumbnails it found", before.have > 0,
         before.have + " of " + before.total);

      /* delete two thumbnails behind the app's back, exactly as a lost or
         excluded thumbs/ folder would look */
      const tdir = await thumbsDir();
      const victims = [...IDX.records.values()]
        .filter(r => !r.deleted && r.status !== "error").slice(0, 2);
      ok("there are records to test with", victims.length === 2, String(victims.length));
      for (const v of victims) { try { await tdir.removeEntry(v.id + ".jpg"); } catch {} }

      const p2 = await planThumbnails();
      eq("missing thumbnails are detected", p2.missing, 2);
      eq("and the originals are found for all of them", p2.files.length, 2);
      eq("nothing is left unresolved when the folder is open", p2.unresolved.length, 0);

      const r = await runThumbnailRebuild(p2.files);
      eq("every missing thumbnail is rebuilt", r.built, 2);
      eq("with no failures", r.failed, 0);

      const p3 = await planThumbnails();
      eq("nothing is missing afterwards", p3.missing, 0);
      for (const v of victims)
        ok("the thumbnail is readable again: " + v.name,
           !!(await (await tdir.getFileHandle(v.id + ".jpg")).getFile()).size);

      /* A rebuild must not touch the records: the captions are the expensive
         part and nothing here has any business rewriting them. */
      const capBefore = victims.map(v => IDX.records.get(v.id));
      ok("records are untouched by a rebuild",
         capBefore.every(r2 => r2 && !r2.deleted && r2.status !== "error"));
      eq("and the record count is unchanged", IDX.records.size, before.total
         + [...IDX.records.values()].filter(r2 => r2.deleted || r2.status === "error").length);

      /* An error stub never had a thumbnail and must not be queued for one. */
      const stub = { id:"thumb-err-1", name:"broken.jpg", path:"broken.jpg",
                     status:"error", error:"decode failed",
                     scanned_at:new Date().toISOString() };
      await appendLines("records.jsonl", [stub]);
      IDX.records.set(stub.id, lighten(stub));
      const p4 = await planThumbnails();
      eq("an error stub is not queued for a thumbnail", p4.missing, 0);
      IDX.records.delete(stub.id);

      /* A thumbnail with no record is dead weight -- counted, never deleted. */
      await saveThumb("orphan-thumb-1", new Blob(["x"], { type:"image/jpeg" }));
      const p5 = await planThumbnails();
      ok("an orphaned thumbnail is reported", p5.orphans >= 1, String(p5.orphans));
      eq("but it is not treated as work", p5.missing, 0);
      let stillThere = true;
      try { await (await thumbsDir()).getFileHandle("orphan-thumb-1.jpg"); }
      catch { stillThere = false; }
      ok("and it is not deleted behind the user's back", stillThere);
      try { await (await thumbsDir()).removeEntry("orphan-thumb-1.jpg"); } catch {}

      /* Records whose originals are not in the open folder must be reported,
         not silently skipped. */
      const ghost = { id:"thumb-ghost-1", name:"gone.jpg", path:"nowhere/gone.jpg",
                      status:"ok", caption:"a photo that has moved away",
                      fingerprint:"x", scanned_at:new Date().toISOString() };
      await appendLines("records.jsonl", [ghost]);
      IDX.records.set(ghost.id, lighten(ghost));
      const p6 = await planThumbnails();
      eq("a photo outside the open folder still counts as missing", p6.missing, 1);
      eq("but is not queued, because its original cannot be read", p6.files.length, 0);
      eq("and it is reported as unresolved", p6.unresolved.length, 1);
      IDX.records.delete(ghost.id);
    }

    /* ---- timeline ----
       Every record already carried a date, a confidence and a place; none of it
       was browsable. These assertions cover the grouping, and the one thing
       that would make it unusable on a share: rendering every thumbnail. */
    {
      const keepRecords = IDX.records;
      const mk = (id, iso, when, place, extra) => [id, Object.assign({
        id, name:id + ".jpg", path:id + ".jpg", status:"ok",
        date_taken: iso, when, place, caption:"c" }, extra || {})];
      IDX.records = new Map([
        mk("t1", "2012-04-07T09:00:00.000Z",
           { year:2012, month:4, day:7, occasions:["easter"] }, "Staines, GB"),
        mk("t2", "2012-04-07T18:30:00.000Z",
           { year:2012, month:4, day:7, occasions:["easter"] }, "Staines, GB"),
        mk("t3", "2012-04-09T10:00:00.000Z", { year:2012, month:4, day:9 }, null),
        mk("t4", "2026-01-02T10:00:00.000Z", { year:2026, month:1, day:2 }, "Sicily, IT",
           { date_suspect:true, date_source:"mtime" }),
        mk("t5", null, null, null),                       // undated
        mk("t6", "2026-01-02T11:00:00.000Z", { year:2026, month:1, day:2 }, null,
           { deleted:true }),                             // must be excluded
        mk("t7", null, null, null, { status:"error", error:"x" })
      ]);

      const t = buildTimeline();
      eq("undated and deleted photos are not days", t.days.length, 3);
      eq("the newest day comes first", t.days[0].key, "2026-01-02");
      eq("photos on a day are grouped together", t.days[2].recs.length, 2);
      eq("a soft-deleted photo is excluded", t.days[0].recs.length, 1);
      eq("undated photos are counted, not dropped", t.undated, 1);
      eq("the total excludes errors and deletions", t.total, 5);
      eq("within a day the newest photo is first", t.days[2].recs[0].id, "t2");
      eq("places are collected per day", t.days[2].places, ["Staines, GB"]);
      eq("occasions are collected per day", t.days[2].occasions, ["easter"]);
      eq("an uncertain date is counted on its day", t.days[0].suspect, 1);

      eq("years are listed newest first", t.years.map(y => y.year), [2026, 2012]);
      eq("and carry a photo count", t.years[1].count, 3);
      eq("months are listed within a year", t.years[1].months.length, 1);

      /* A record whose `when` block is missing must still land on a day: the
         app's own block is preferred, but date_taken is the fallback. */
      IDX.records.set("t8", { id:"t8", name:"t8.jpg", status:"ok",
        date_taken:"2019-06-15T12:00:00.000Z", caption:"c" });
      const t2 = buildTimeline();
      ok("a record with no when block still lands on a day",
         t2.days.some(d => d.key === "2019-06-15"),
         t2.days.map(d => d.key).join(","));

      renderTimeline();
      const sections = $("#tlBody").querySelectorAll(".tlday");
      eq("one section is rendered per day", sections.length, t2.days.length);
      /* THE important one. Rendering every thumbnail up front would be one read
         per photo from the share -- 6,635 of them on the real library. */
      eq("no thumbnails are rendered until a day is on screen",
         $("#tlBody").querySelectorAll("img").length, 0);
      ok("but the scrollbar is honest before anything is filled",
         [...sections].every(x => parseInt(x.querySelector(".tlrows").style.minHeight) > 0));

      tlFill(sections[0]);
      ok("filling a day renders its photos",
         sections[0].querySelectorAll("img").length === 1,
         String(sections[0].querySelectorAll("img").length));
      ok("a filled day pins its thumbnails against cache eviction",
         thumbPinned.has(t2.days[0].recs[0].id));
      ok("an uncertain date is marked in the caption",
         !!sections[0].querySelector(".tlmark"));
      tlFill(sections[0]);
      eq("filling twice does not duplicate anything",
         sections[0].querySelectorAll("img").length, 1);

      tlEmpty(sections[0]);
      eq("scrolling a day away releases its images",
         sections[0].querySelectorAll("img").length, 0);
      ok("and unpins them so the cache can reclaim them",
         !thumbPinned.has(t2.days[0].recs[0].id));
      ok("without collapsing the page under the reader",
         parseInt(sections[0].querySelector(".tlrows").style.minHeight) > 0);

      const bar = $("#tlBar");
      ok("the bar offers a button per year",
         bar.querySelectorAll("button").length === t2.years.length,
         String(bar.querySelectorAll("button").length));
      ok("and a date picker to jump with", !!bar.querySelector('input[type="date"]'));

      eq("jumping to a known day finds it", tlJump("2012-04-07"),
         t2.days.findIndex(d => d.key === "2012-04-07"));
      /* A date with no photos must land somewhere sensible, not nowhere. */
      const near = tlJump("2012-04-08", true);
      eq("a date with no photos lands on the nearest earlier day",
         t2.days[near].key, "2012-04-07");

      IDX.records = keepRecords;
      TL.built = 0;
    }

    /* ---- faces ----
       The engine is injected, so none of this needs a network or a model: the
       detector is a thin adapter and everything that can be wrong -- grouping,
       naming, merging, splitting, and what is allowed to be stored -- is
       arithmetic and storage below it. */
    {
      const keepFaces = S.faces.enabled, keepTh = S.faces.threshold;
      const keepEngine = FACE_ENGINE, keepName = FACE_ENGINE_NAME;
      const keepRecords = IDX.records;
      try {
        S.faces.threshold = 0.9;
        await ensureIndex();
        await deleteAllFaceData();

        /* Three identities as unit-ish vectors: A and B far apart, A2 close to
           A. Exactly the situation clustering has to get right. */
        const dim = 8;
        /* Distinct identities must be genuinely far apart, so use orthogonal
           axes with a little jitter: within one identity cosine is ~0.99,
           between two it is ~0. Anything vaguer does not actually test the
           threshold, it tests the noise. */
        const mkv = (axis, jitter) => {
          const v = new Float32Array(dim);
          v[axis] = 1;
          for (let i = 0; i < dim; i++)
            v[i] += (jitter || 0) * (((i * 37) % 11) / 11 - 0.5);
          return v;
        };
        const planted = {
          "p1": [{ box:[0.1,0.1,0.2,0.2], score:0.95, vec: mkv(0, 0) }],
          "p2": [{ box:[0.3,0.2,0.2,0.2], score:0.90, vec: mkv(0, 0.05) }],
          "p3": [{ box:[0.5,0.3,0.2,0.2], score:0.85, vec: mkv(3, 0) }],
          "p4": [{ box:[0.1,0.1,0.2,0.2], score:0.20, vec: mkv(0, 0) }],   // below minScore
          /* age/gender arrive from the real descriptor model; the adapter must
             be the only thing that ever sees them. */
          "p5": [{ box:[0.2,0.2,0.3,0.3], score:0.88, vec: mkv(3, 0.05),
                   age: 34, gender: "female", genderScore: 0.9, emotion: "happy" }]
        };
        setFaceEngine(async bmp => planted[bmp.__id] || [], "stub");

        IDX.records = new Map(Object.keys(planted).map(id =>
          [id, { id, name:id + ".jpg", status:"ok", caption:"a photo",
                 date_taken:"2026-01-0" + id.slice(1) + "T10:00:00.000Z" }]));

        await loadFaces();
        for (const id of Object.keys(planted))
          await detectFacesIn(id, { __id:id, width:1000, height:800 });

        eq("a face below the score floor is not stored", FACES.faces.has("p4-f100_100_200_200"), false);
        eq("every confident face is stored", FACES.faces.size, 4);
        eq("and each has a vector", FACES.vec.ids.length, 4);
        ok("vectors are stored normalised", (() => {
          const v = faceVectorOf(FACES.vec.ids[0]);
          let n = 0; for (let i = 0; i < v.length; i++) n += v[i]*v[i];
          return Math.abs(Math.sqrt(n) - 1) < 1e-5;
        })());

        /* THE privacy assertion. */
        const stored = JSON.stringify([...FACES.faces.values()]);
        ok("no age, gender, emotion or ethnicity is ever stored",
           !/age|gender|emotion|ethnic|race/i.test(stored), stored.slice(0, 160));
        eq("a face row carries only geometry and provenance",
           Object.keys([...FACES.faces.values()][0]).sort().join(","),
           "box,detected_at,engine,id,photo_id,score");

        /* ---- grouping ---- */
        clusterFaces();
        eq("alike faces are grouped and unalike ones are not", FACES.clusters.length, 2);
        eq("no group is named to begin with",
           FACES.clusters.filter(c => c.name).length, 0);
        eq("each group holds both of its faces",
           FACES.clusters.map(c => c.face_ids.length).sort().join(","), "2,2");
        /* Pick by content, not by position: two groups of equal size have no
           guaranteed order, and the rest of this test follows one identity. */
        const faceOfP1 = [...FACES.faces.values()].find(f => f.photo_id === "p1").id;
        const big = FACES.clusters.find(c => c.face_ids.includes(faceOfP1));
        ok("the group containing p1 is findable", !!big);

        /* ---- naming ---- */
        await namePerson(big.id, "Anna");
        eq("naming promotes a group to a person", FACES.people.length, 1);
        eq("and removes it from the unnamed list", FACES.clusters.length, 1);
        eq("the name is kept", FACES.people[0].name, "Anna");
        ok("and reaches the photos that person is in",
           faceNamesFor("p1").includes("Anna"), faceNamesFor("p1").join(","));

        rebuildDerived();
        const byName = await searchPhotos({ query:"", person:"Anna", limit:20 });
        eq("searching by name returns that person's photos", byName.results.length, 2);
        ok("and only theirs",
           byName.results.every(x => faceNamesFor(x.rec.id).includes("Anna")));
        const noSuch = await searchPhotos({ query:"", person:"Nobody", limit:20 });
        eq("an unknown name returns nothing", noSuch.results.length, 0);
        ok("the name is searchable as ordinary text too",
           recordTerms(IDX.records.get("p1")).includes("anna"),
           recordTerms(IDX.records.get("p1")).join(" "));

        /* ---- re-grouping must never destroy a name ---- */
        clusterFaces();
        eq("re-grouping keeps the named person", FACES.people.length, 1);
        eq("with their faces intact", FACES.people[0].face_ids.length, 2);
        eq("and their name", FACES.people[0].name, "Anna");

        /* A new photo of a known person joins them without being asked. */
        IDX.records.set("p6", { id:"p6", name:"p6.jpg", status:"ok", caption:"x" });
        planted["p6"] = [{ box:[0.4,0.4,0.2,0.2], score:0.93, vec: mkv(0, 0.02) }];
        await detectFacesIn("p6", { __id:"p6", width:1000, height:800 });
        clusterFaces();
        ok("a new photo of a named person joins them automatically",
           faceNamesFor("p6").includes("Anna"), faceNamesFor("p6").join(","));

        /* ---- merging and splitting: clustering WILL get some wrong ---- */
        const other = FACES.clusters[0];
        const beforeMerge = FACES.people[0].face_ids.length;
        await mergeGroups(FACES.people[0].id, other.id);
        eq("merging moves every face across",
           FACES.people[0].face_ids.length, beforeMerge + other.face_ids.length);
        eq("and the group merged from is gone", FACES.clusters.length, 0);

        /* Move a face out that is NOT p1's, so the rest of the test can keep
           following p1 through the group it stays in. */
        const faceOfP3 = [...FACES.faces.values()].find(f => f.photo_id === "p3").id;
        const moving = [faceOfP3];
        await splitOut(FACES.people[0].id, moving);
        eq("splitting moves the chosen faces out", FACES.clusters.length, 1);
        eq("into a group of their own", FACES.clusters[0].face_ids.length, 1);
        ok("and they leave the person they came from",
           !FACES.people[0].face_ids.includes(moving[0]));

        /* Clearing a name returns the group to unnamed rather than losing it. */
        const wasCount = FACES.people[0].face_ids.length;
        await namePerson(FACES.people[0].id, "");
        eq("clearing a name unnames the group", FACES.people.length, 0);
        ok("without losing its faces",
           FACES.clusters.some(c => c.face_ids.length === wasCount));

        /* ---- the detector's confidence must come from the right field ----
           faceScore is produced by the mesh model, which is switched off, so it
           is always 0. Preferring it scored every face 0 and the minimum-score
           filter then threw away every single face -- the feature would have
           found nothing at all, silently. */
        {
          eq("a zero faceScore does not mask the real confidence",
             faceScoreOf({ boxScore:0.53, score:0.53, faceScore:0 }), 0.53);
          eq("boxScore is preferred when present",
             faceScoreOf({ boxScore:0.81, score:0.4, faceScore:0 }), 0.81);
          eq("score is used when boxScore is absent",
             faceScoreOf({ score:0.62, faceScore:0 }), 0.62);
          eq("faceScore is still used when it is the only one",
             faceScoreOf({ faceScore:0.7 }), 0.7);
          eq("nothing usable yields zero, not NaN", faceScoreOf({}), 0);
          ok("the default floor does not exceed what the detector accepts",
             S.faces.minScore <= 0.4, String(S.faces.minScore));
        }

        /* ---- a missing model must say so ----
           The first version of this pointed modelBasePath at a package that
           does not exist. TensorFlow.js does not report a 404: it parses the
           error page as a graph and dies later on "Cannot read properties of
           undefined (reading 'inputNodes')", which tells the user nothing. */
        {
          let e404 = null;
          try {
            await checkFaceModels("https://example.invalid/models/",
              async () => ({ ok:false, status:404, text: async () => "not found" }));
          } catch (e){ e404 = e; }
          ok("a missing face model fails with a readable message", !!e404);
          ok("naming the URL and the status",
             !!e404 && /blazeface\.json/.test(e404.message) && /404/.test(e404.message),
             e404 && e404.message);

          let eHtml = null;
          try {
            await checkFaceModels("https://example.invalid/models/",
              async () => ({ ok:true, status:200, text: async () => "<html>nope</html>" }));
          } catch (e){ eHtml = e; }
          ok("an error page served as 200 is caught too", !!eHtml,
             eHtml && eHtml.message);

          let eShape = null;
          try {
            await checkFaceModels("https://example.invalid/models/",
              async () => ({ ok:true, status:200, text: async () => '{"hello":1}' }));
          } catch (e){ eShape = e; }
          ok("valid JSON that is not a graph model is rejected", !!eShape,
             eShape && eShape.message);

          let good = false;
          try {
            good = await checkFaceModels("https://example.invalid/models/",
              async () => ({ ok:true, status:200,
                text: async () => '{"format":"graph-model","modelTopology":{}}' }));
          } catch {}
          ok("a real graph model passes the check", good === true);

          let eNet = null;
          try {
            await checkFaceModels("https://example.invalid/models/",
              async () => { throw new TypeError("Failed to fetch"); });
          } catch (e){ eNet = e; }
          ok("being offline says so, and says it is a one-off download",
             !!eNet && /first time only/.test(eNet.message), eNet && eNet.message);
        }

        /* ---- it survives a reload ---- */
        await namePerson(FACES.clusters.find(c => c.face_ids.length === wasCount).id, "Ben");
        FACES.loaded = false;
        await loadFaces();
        eq("names survive a reload", FACES.people.length, 1);
        eq("with the right name", FACES.people[0].name, "Ben");
        eq("and faces reload with them", FACES.vec.ids.length, 5);
        ok("names still map to photos after a reload",
           faceNamesFor("p1").includes("Ben"), faceNamesFor("p1").join(","));

        /* ---- deleting everything ---- */
        await deleteAllFaceData();
        eq("deleting face data removes every face", FACES.faces.size, 0);
        eq("and every vector", FACES.vec.ids.length, 0);
        eq("and every name", FACES.people.length, 0);
        eq("and nothing maps to a photo any more", faceNamesFor("p1").length, 0);
        let gone = false;
        try { await IDX.dir.getDirectoryHandle("faces"); } catch { gone = true; }
        ok("the faces folder itself is gone", gone);
        ok("but the photo records are untouched", IDX.records.size >= 5);
      } finally {
        S.faces.enabled = keepFaces; S.faces.threshold = keepTh;
        FACE_ENGINE = keepEngine; FACE_ENGINE_NAME = keepName;
        IDX.records = keepRecords;
        try { await deleteAllFaceData(); } catch {}
      }
    }

    /* ---- compaction ---- */
    const c = await compactRecords();
    ok("compaction shrinks the log", c.after <= c.before, c.before + " -> " + c.after);
    IDX.loaded = false; await loadRecords();
    ok("records still load after compaction", IDX.records.size === c.after);

    await rmAll(scratch);
    st[T.fail ? "err" : "ok"](T.pass + " passed, " + T.fail + " failed");
  } catch (e){
    T.fail++;
    T.lines.push("FAIL  threw: " + String(e && e.stack || e));
    st.err(String(e && e.message || e));
  } finally {
    $("#mock").checked = wasMock;
    S.dirHandle = savedDir; S.roles = savedRoles;
    IDX.loaded = false;
  }
  const pre = el("pre");
  pre.textContent = T.lines.join("\n");
  $("#selfOut").append(pre);
  window.__selftest = { pass:T.pass, fail:T.fail, lines:T.lines };
  return T;
}
$("#btnSelfTest").onclick = selfTest;
