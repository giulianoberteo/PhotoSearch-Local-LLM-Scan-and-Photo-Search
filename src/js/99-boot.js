
/* ================= error surfacing ================= */
function fatal(msg){
  const w = $("#browserWarn"); w.hidden = false; w.innerHTML = "";
  w.append(el("b", null, "Script error: "));
  w.append(document.createTextNode(msg));
}
window.addEventListener("error", e => fatal(e.message));
window.addEventListener("unhandledrejection", e => {
  const r = e.reason;
  if (r && r.name === "AbortError") return;      // expected on Stop
  fatal(String(r && r.message || r));
});

/* ================= boot ================= */
loadSettings();
exclSummary();          // the summary was drawn before the saved list was read
loadOverrideBox();
$("#baseUrl").onchange = () => { S.baseUrl = $("#baseUrl").value.trim(); saveSettings(); };
$("#mock").onchange = saveSettings;
setConn("off","Not connected");
if (checkBrowser()){
  $("#sIndexMode").value = S.indexMode;
  idbGet("lastIndexDir").then(async h => {
    if (!h) return;
    try {
      if ((await h.queryPermission({ mode:"readwrite" })) === "granted"){
        S.indexDirHandle = h;
        if (typeof renderIndexWhere === "function") renderIndexWhere();
      }
    } catch {}
  }).catch(() => {});
  idbGet("lastDir").then(async h => {
    if (!h) return;
    $("#btnReconnect").disabled = false;
    $("#btnReconnect").dataset.noLast = "0";
    // Chrome sometimes still holds the grant. If so, reopen without a click so a
    // reload does not look like the previous scan vanished.
    try {
      if ((await h.queryPermission({ mode:"readwrite" })) === "granted"){
        await useDirectory(h);
        toast("Reopened " + h.name + " — your index is loaded.");
      } else {
        /* Chrome will not re-grant without a gesture. Say so once, plainly, and
           let any action re-acquire it rather than dead-ending. */
        const w = $("#browserWarn");
        w.hidden = false; w.innerHTML = "";
        w.append(el("b", null, h.name + " is not connected. "));
        w.append(document.createTextNode(
          "Chrome drops folder access when the page reloads. Anything you do will "
          + "ask for it back — or press here."));
        const b = el("button","btn");
        b.textContent = "Reconnect " + h.name;
        b.style.marginLeft = "10px";
        b.onclick = async () => { if (await ensureConnected()) w.hidden = true; };
        w.append(b);
      }
    } catch {}
  }).catch(() => {});
  // Connect straight away so the Chat and Scan tabs are usable without a detour
  // through Settings. Failure is silent here; the dot and diagnostics show it.
  autoConnect().catch(() => {});
}
{ const t = tabFromHash(); if (t) showTab(t); }       // open straight onto a linked tab
$("#sVersion").textContent = "PhotoSearch v" + APP_VERSION;
/* Headless hook: open with #selftest to run the suite automatically. */
if (location.hash === "#selftest") setTimeout(() => selfTest(), 50);
