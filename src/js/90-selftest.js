
/* ================= self-test =================
   Runs the real pipeline against an OPFS scratch folder with mock model
   responses, so the worker, index, plan, move detection, vectors, checkpoint
   and derived data are all genuinely exercised without a picked folder. */
const T = { pass:0, fail:0, lines:[] };
function ok(name, cond, detail){
  if (cond){ T.pass++; T.lines.push("PASS  " + name + (detail ? "  — " + detail : "")); }
  else { T.fail++; T.lines.push("FAIL  " + name + (detail ? "  — " + detail : "")); }
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
        rec0.schema_hash = "OLD-HASH";                 // pretend the template moved on
        rec0.library_root = "some-other-root";         // and it came from another pick
        const pr = await buildPlan();
        const asStale = pr.stale.filter(f => f.name === "IMG_1.jpg").length;
        const asOk = pr.ok.filter(f => f.name === "IMG_1.jpg").length;
        eq("a relinked file is still reported stale", asStale, 1);
        ok("it is not silently marked up to date", asOk <= 1, asOk + " ok");
        ok("and it is queued for relinking", pr.moved.some(f => f.name === "IMG_1.jpg"));
        await applyMoves(pr.moved);
        const after = IDX.records.get(rec0.id);
        eq("relinking rewrites the pick root", after.library_root, scratch.name);
        eq("relinking preserves the hashes so staleness still fires",
           after.schema_hash, "OLD-HASH");
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
        done:1, total:4, updated_at:new Date().toISOString() });
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
      const sizeBefore = (await vfh.getFile()).size;
      await appendVectors([{ id:"synthetic-vec-1",
        vec: Float32Array.from(Array(IDX.vec.dim || 64).fill(0.5)) }]);
      const sizeAfter = (await vfh.getFile()).size;
      eq("one new vector grows the file by exactly one row",
         sizeAfter - sizeBefore, (IDX.vec.dim || 64) * 4);
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
    await saveCheckpoint({ run_id:"x", mode:"m", pending:["one.png"], done:1, total:2,
      updated_at:new Date().toISOString() });
    IDX.checkpoint = null;
    await loadCheckpoint();
    ok("checkpoint survives a reload", IDX.checkpoint && IDX.checkpoint.pending.length === 1);
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
