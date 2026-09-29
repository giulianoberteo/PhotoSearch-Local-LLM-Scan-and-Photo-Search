// Minimal CDP driver: load a page, wait for window.__selftest, print results.
const PORT = 9222;
const target = process.argv[2];
const expr = process.argv[3] || "window.__selftest";
const maxMs = +(process.argv[4] || 180000);

async function http(path){
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`);
  return r.json();
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

let list = null;
for (let i = 0; i < 60; i++){
  try { list = await http("/json/list"); break; } catch { await sleep(250); }
}
if (!list) { console.error("could not reach devtools"); process.exit(2); }

const page = list.find(t => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const logs = [];
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)){ pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === "Runtime.consoleAPICalled")
    logs.push(m.params.args.map(a => a.value ?? a.description ?? "").join(" "));
  if (m.method === "Runtime.exceptionThrown")
    logs.push("EXCEPTION: " + (m.params.exceptionDetails.exception?.description
      || m.params.exceptionDetails.text));
  /* confirm()/alert() are synchronous modals: unhandled, they block the
     renderer main thread forever and the run looks like an infinite loop
     rather than a prompt. Accept them and record that one appeared. */
  if (m.method === "Page.javascriptDialogOpening"){
    logs.push("DIALOG (" + m.params.type + "): " + m.params.message.split("\n")[0]);
    send("Page.handleJavaScriptDialog", { accept: true });
  }
};
const send = (method, params) => new Promise(res => {
  const myId = ++id;
  pending.set(myId, res);
  ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
});
await new Promise(res => ws.onopen = res);
await send("Runtime.enable");
await send("Page.enable");
await send("Page.navigate", { url: target });

const t0 = Date.now();
let result = null;
while (Date.now() - t0 < maxMs){
  await sleep(1000);
  const r = await send("Runtime.evaluate",
    { expression: `JSON.stringify(${expr} || null)`, returnByValue: true, awaitPromise: false });
  const v = r.result?.result?.value;
  if (v && v !== "null"){ result = JSON.parse(v); break; }
}
if (logs.length) console.log("--- console ---\n" + logs.join("\n") + "\n---------------");
if (!result){ console.error("TIMEOUT after " + ((Date.now()-t0)/1000).toFixed(0) + "s"); process.exit(1); }
console.log(result.lines ? result.lines.join("\n") : JSON.stringify(result, null, 1));
if (result.pass != null) console.log(`\n==> ${result.pass} passed, ${result.fail} failed`);
process.exit(result.fail ? 1 : 0);
