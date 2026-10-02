/* ================= backups ================= */
$("#sBackup").onchange = () => { S.backup.enabled = $("#sBackup").checked; saveSettings(); };
$("#sKeep").onchange = () => {
  const v = parseInt($("#sKeep").value, 10);
  S.backup.keep = isFinite(v) ? Math.min(20, Math.max(1, v)) : 3;
  $("#sKeep").value = S.backup.keep; saveSettings();
};
$("#btnBackup").onclick = async () => {
  if (RUN.active){ toast("A scan is running — back up when it finishes."); return; }
  const host = $("#backupOut"); resetChecks(host);
  host.scrollIntoView({ block:"nearest" });
  const btn = $("#btnBackup"); btn.disabled = true; btn.textContent = "Backing up…";
  try {
    if (!(await ensureIndexConnected()) || !(await ensureConnected("the backup"))){
      checksBox(host).append(checkRow({ status:"err", title:"Could not open the index",
        detail:"Access to the folder was not granted." }));
      btn.disabled = false; btn.textContent = "Back up now";
      return;
    }
  } catch (e){
    checksBox(host).append(checkRow({ status:"err", title:"Could not open the index",
      detail:humanError(e) }));
    btn.disabled = false; btn.textContent = "Back up now";
    return;
  }
  const st = step(host, "Backup");
  try {
    const b = await backupIndex("manual", m => st.note(m));
    const r = b.manifest.records;
    st.ok((b.bytes/1048576).toFixed(1) + " MB copied"
      + (r ? " · " + r.lines + " records, " + r.unique + " unique"
             + (r.bad ? ", " + r.bad + " UNREADABLE" : ", all readable") : "")
      + (b.pruned ? " · " + b.pruned + " older backup(s) removed" : ""));
    toast("Backup complete: " + (b.bytes/1048576).toFixed(1) + " MB");
    await showBackups();
  } catch (e){
    st.err(humanError(e));
    toast("Backup failed: " + humanError(e));
  } finally {
    btn.disabled = false; btn.textContent = "Back up now";
  }
};
$("#btnBackups").onclick = async () => {
  if (!(await ensureIndexConnected())) return;
  if (!(await ensureConnected("the backup list"))) return;
  resetChecks($("#backupOut"));
  await showBackups();
};
async function showBackups(){
  const host = $("#backupOut");
  try {
    await ensureIndex();
    const list = await listBackups();
    const box = el("div"); box.style.marginTop = "12px";
    if (!list.length){ box.append(el("span","dim","No backups yet.")); host.append(box); return; }
    const t = el("table");
    t.innerHTML = "<thead><tr><th>When</th><th>Reason</th><th>Records</th>"
      + "<th>Size</th><th></th></tr></thead>";
    const tb = el("tbody");
    for (const b of list){
      const tr = el("tr");
      tr.append(el("td","mono", (b.meta && b.meta.created_at || b.name).slice(0,19).replace("T"," ")));
      tr.append(el("td", null, (b.meta && b.meta.reason) || "—"));
      const rec = b.meta && b.meta.records;
      tr.append(el("td", rec && rec.bad ? "err" : null,
        rec ? rec.unique + (rec.bad ? "  (" + rec.bad + " bad)" : "") : "—"));
      tr.append(el("td","mono", (b.bytes/1048576).toFixed(1) + " MB"));
      const td = el("td");
      const btn = el("button","btn sec"); btn.textContent = "Restore";
      btn.style.padding = "2px 8px"; btn.style.fontSize = "12px";
      btn.onclick = async () => {
        if (RUN.active){ toast("Stop the scan before restoring."); return; }
        if (!confirm("Replace the current index with the backup from "
          + b.name.slice(0,19).replace("T"," ") + "?\n\n"
          + "The current index is copied to a new backup first.")) return;
        const st2 = step(host, "Restore");
        try {
          const r2 = await restoreBackup(b.name, m => st2.note(m));
          st2.ok("Restored " + r2.records + " records, " + r2.vectors + " vectors.");
          await refreshPlan();
        } catch (e){ st2.err(humanError(e)); }
      };
      td.append(btn); tr.append(td);
      tb.append(tr);
    }
    t.append(tb); box.append(t);
    host.append(box);
  } catch (e){ renderChecks(host, [{ status:"err", title:"Could not list backups",
    detail:humanError(e) }]); }
}

/* ================= geonames button ================= */
$("#btnGeo").onclick = async () => {
  if (!(await ensureIndexConnected()) || !(await ensureConnected("place names"))) return;
  const host = $("#geoOut"); resetChecks(host);
  const st = step(host, "Place names");
  try {
    await st.note("Opening the index…");
    await ensureIndex();
    await st.note("Checking for a cached copy…");
    if (await geoCached()){ st.ok(GEO.count.toLocaleString() + " places loaded from the cached copy."); return; }
    await st.note("Fetching the cities dataset once (~17 MB)…");
    await geoFetchAndCache((phase, detail) =>
      st.note(phase + (detail ? "  " + detail : "")));
    st.ok(GEO.count.toLocaleString() + " places cached in .photoindex/geo/ — this is now offline.");
  } catch (e){ st.err(humanError(e) + " — photos will store coordinates only."); }
};

/* ================= settings wiring ================= */
["mScan","mEmbed","mChat"].forEach(id => $("#" + id).onchange = syncRoles);
function syncScan(){
  const beforeEvents = { ...S.events }, beforeHemi = S.date.hemisphere;
  const num = (id, def, lo, hi) => {
    const v = parseFloat($("#" + id).value);
    return isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def;
  };
  S.scan.concurrency     = num("sConc", 1, 1, 4);
  S.scan.statConcurrency = num("sStat", 12, 1, 32);
  S.scan.maxTokens       = num("sMaxTok", 2000, 200, 12000);
  S.scan.temp            = num("sTemp", 0.1, 0, 1);
  S.events.gapHours      = num("sGap", 6, 0.25, 168);
  S.events.km            = num("sKm", 25, 1, 5000);
  S.search.minCosine     = num("sMinCos", 0.30, 0, 1);
  S.date.hemisphere      = $("#sHemi").value;
  S.ocr.enabled          = $("#sOcr").checked;
  saveSettings();
  /* Only these three change derived data. Rebuilding the whole inverted index
     because concurrency moved from 1 to 2 freezes the tab for seconds. */
  if (IDX.records.size && (S.events.gapHours !== beforeEvents.gapHours
      || S.events.km !== beforeEvents.km || S.date.hemisphere !== beforeHemi))
    rebuildDerived();
}
["sConc","sStat","sMaxTok","sTemp","sGap","sKm","sHemi","sMinCos","sOcr"]
  .forEach(id => $("#" + id).onchange = syncScan);

/* Date overrides: one per line, "path/prefix = YYYY-MM-DD". */
function loadOverrideBox(){
  $("#sOverrides").value = (S.date.overrides || [])
    .map(o => o.prefix + " = " + o.date.slice(0,10)).join("\n");
}
$("#sOverrides").onchange = () => {
  const list = [];
  for (const line of $("#sOverrides").value.split("\n")){
    const m = line.match(/^(.*?)\s*=\s*(\d{4}-\d{2}-\d{2})\s*$/);
    if (m) list.push({ prefix:m[1].trim(), date:new Date(m[2] + "T12:00:00").toISOString() });
  }
  S.date.overrides = list;
  saveSettings();
  toast(list.length + " date override(s) saved. Re-scan those files to apply.");
};
