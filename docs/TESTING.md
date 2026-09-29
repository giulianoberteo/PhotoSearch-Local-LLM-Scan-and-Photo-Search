# Testing

## The self-test

Open `PhotoSearch.html#selftest` and the suite runs automatically, or press **Run self-test**
in *Settings → Diagnostics*. It takes about 60 seconds and needs no model: it uses mock
responses and an [OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)
scratch folder, so your real photos and index are never touched.

**264 assertions** covering:

- pure logic — Easter/occasion dates, singularisation, validation caps, enum checks
- `image_type` correction from filename, EXIF, dimensions and caption
- the decode worker — resizing, thumbnails, format policy
- the index — append, reload, compaction, vectors appended a row at a time
- **identity matching** — scan a subfolder then the library root; same filename in two
  folders stays two photos; a forged name/size/mtime collision is rejected by content
- **crash safety** — the plan finds exactly the missing work when a record is lost
- **backup and restore** — including genuinely corrupting `records.jsonl` on disk
- search — BM25, filters, phrases, the relevance floor
- chat — history trimming, and that model output can never inject HTML
- UI invariants — nothing marked `hidden` is actually visible
- storage invariants — the vectors bin is always exactly as long as its id list claims,
  a torn final row is healed, and an unforced checkpoint save is throttled, not written

A real HEIC decode is skipped unless you supply a sample:

```
PhotoSearch.html#selftest&heic=file:///path/to/sample.heic
```

## Running it headlessly

`tools/selftest-runner.mjs` drives Chrome over the DevTools protocol and exits non-zero on
failure. Node 22+ (it uses the global `WebSocket`).

```bash
rm -rf /tmp/chrome-selftest
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --no-sandbox \
  --user-data-dir=/tmp/chrome-selftest --remote-debugging-port=9222 \
  --allow-file-access-from-files about:blank &

node tools/selftest-runner.mjs \
  "file://$PWD/PhotoSearch.html#selftest" "window.__selftest" 300000
```

`--allow-file-access-from-files` is required: without it OPFS is unavailable from `file://`
and the suite cannot create its scratch folder.

**`--dump-dom` does not work** for this. It fires at load, before any async work, and
`--virtual-time-budget` stalls indefinitely on IndexedDB and OPFS. Drive it over CDP.

### A modal dialog wedges the whole suite

`confirm()` and `alert()` are **synchronous** modals. Unhandled in headless Chrome they
block the renderer main thread *forever*: `Runtime.evaluate` stops returning, and even
`Runtime.enable` never completes. The symptom is indistinguishable from an infinite loop,
with no error and no timeout.

`runScan()` calls `confirm()` when the pre-scan safety copy fails, which is exactly what
happens the first time a test switches to an empty index location. The runner therefore
answers dialogs rather than assuming none appear:

```js
if (m.method === "Page.javascriptDialogOpening"){
  logs.push("DIALOG (" + m.params.type + "): " + m.params.message.split("\n")[0]);
  send("Page.handleJavaScriptDialog", { accept: true });
}
```

`Page.enable` must be sent **before** navigating, or the event never arrives.

### Locating a hang

Because a blocked main thread cannot be queried, the last assertion that *completed* is
the only evidence available. `ok()` therefore streams every assertion to the console, and
the driver prints console output live rather than buffering it to the end:

```
[ 60] PASS  nothing else is called missing
>>> main thread BLOCKED. last assertion: PASS  nothing else is called missing
```

The hang is in the code *after* the last line printed. Without this the suite simply ran
until killed, three times, with no output at all.

## Things worth knowing when writing tests

- **Absence of `FAIL` is not a pass.** Grep for `EXCEPTION` and `TIMEOUT` too — a suite that
  died on a syntax error prints no failures at all.
- **Headless has no file dialogs**, so picker behaviour cannot be tested that way.
- **OPFS does not preserve `lastModified`**, which usefully reproduces a NAS copy that loses
  its timestamp — the case the name+size matching tier exists for.
- Tests share one scratch folder and run in order; clean up what you create.

## Verifying a build

```bash
python3 build.py --check    # fails if PhotoSearch.html is out of date
```

Run the self-test before proposing a change. If you touched scanning, search or chat, run it
twice **in the same page** — not two fresh loads. Re-running in a fresh tab proves nothing
about state left behind by the first run:

```js
await ev("window.__selftest = null; selfTest();");
```

### Assert invariants, not deltas

Two assertions in this suite were wrong in the same way: they measured a *change* against
a starting state that an earlier test had deliberately damaged.

`"one new vector grows the file by exactly one row"` expected +256 bytes and saw +253 —
because an earlier test leaves a torn final row on disk and the append correctly **heals**
it. The code was right; the assertion was not. It now states the invariant that must always
hold: the bin is exactly `ids.length × dim × 4` bytes.

Likewise a checkpoint test wrote without `force` and read back a stale file, because
`saveCheckpoint` throttles to one write per 30 seconds. The throttle is deliberate — it was
roughly 3 GB of writes over a 50,000-photo run — so it is now asserted explicitly, including
the fact that memory moves ahead of disk.
