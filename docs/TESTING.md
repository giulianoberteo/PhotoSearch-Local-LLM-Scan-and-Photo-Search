# Testing

## The self-test

Open `PhotoSearch.html#selftest` and the suite runs automatically, or press **Run self-test**
in *Settings → Diagnostics*. It takes about 60 seconds and needs no model: it uses mock
responses and an [OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)
scratch folder, so your real photos and index are never touched.

**479 assertions** covering:

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
- **any OpenAI-compatible server** — URL forms with and without `/v1`, model-type guessing
  for Ollama names, the three structured-output contracts, and per-server CORS advice
- **storage that misbehaves** — slow, hanging, failing and short writes (see below)
- **faces** — grouping by resemblance, naming, merge and split, that re-grouping never
  destroys a name, that a new photo of a named person joins them, and that **no age,
  gender, emotion or ethnicity ever reaches storage**
- **timeline** — day grouping, newest-first ordering, deleted and undated handling,
  and that no thumbnail is rendered until its day is on screen
- **thumbnail rebuild** — missing ones are detected and remade, error stubs are not queued,
  orphans are reported but never deleted, and photos outside the open folder are reported
  rather than silently skipped

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

## Testing against storage that misbehaves

Every other test here runs against OPFS, which is fast, local and never fails. The
conditions that actually broke this app are the opposite, and until `src/js/95-faultfs.js`
existed none of them were reproducible: three defects shipped that no number of green
assertions could have caught.

`faultFS(handle, opts)` wraps a directory handle in a Proxy that can be told to misbehave.
Everything it returns is wrapped too, so one call at the entry point covers the whole tree:

```js
const stats = {};
S.indexDirHandle = faultFS(dir, {
  latencyMs: 250,                  // added to every operation
  slowPaths: { "thumbs": 75000 },  // the measured 75-second listing
  hangPaths: [".photoindex"],      // never resolves, like the real share
  failWrites: 0.1,                 // fraction of writes that throw
  shortWrites: 0.5,                // fraction of each write silently dropped
  stats                            // ops, failures, and every path touched
});
```

Handles enter the app at four points, so wrapping is contained: `useDirectory` and three
`S.indexDirHandle` assignments. Nothing in the app calls `faultFS` — it is test-only.

The **face engine is injected** the same way: `setFaceEngine(fn)` replaces the detector
with a stub returning planted vectors, so nothing in the face tests needs a network, a GPU
or a model download. Use orthogonal vectors with a little jitter for distinct identities —
vaguer ones do not test the clustering threshold, they test the noise.

`shortWrites` is the nastiest of the five, and the reason `appendLines` checks the
resulting file length: a write that reports success having stored half its data raises no
error anywhere, so the caller carries on believing those records are safe.

For a share that drops a connection and then recovers — the case retries exist for — use
the supplied rng:

```js
faultFS(dir, { failWrites: 1, rng: failFirstWrites(2) })   // first two writes fail
```

**A hang is deliberately unrecoverable.** `hangPaths` awaits a promise that never settles,
exactly as the real share behaves. Anything that must survive it has to impose its own
deadline, which is the point of asserting against it — so set `S.io.deadlineCapMs` low
(a few hundred ms) for the duration of such a test, and restore it afterwards. Never let a
hang happen inside `exclusive()`: that lock serialises every index write, and a wedged
chain would stall the rest of the suite.

### A synthetic benchmark cannot rank recognition models

Drawn faces were good enough to prove that **alignment** works, because alignment is
geometry: the same face rotated must embed to nearly the same vector, and that showed up
clearly (0.527 → 0.925 self-similarity). The same benchmark then said ArcFace was *worse*
than `faceres` — separability 0.176 against 0.339 — because two crude cartoons look like
the same person to a model trained on real faces, which scored them 0.774 alike.

So: use synthetic faces for geometry, never for identity. The only valid labels for ranking
embedders are the groups the **user** has named, which is what `compareEmbedders()` uses —
same-person versus different-person cosine on their own photos, with a suggested threshold
derived from the gap.

### The face model needs a live check

The self-test injects the face engine, so it never loads the real one. That is deliberate
-- no test should need a 15 MB download -- but it means a whole class of failure is
invisible to it, and two of them shipped:

- `modelBasePath` pointed at a package that does not exist. TensorFlow.js does not report
  a 404; it parses the error page as a graph and dies later on **"Cannot read properties
  of undefined (reading 'inputNodes')"**, which names nothing. `checkFaceModels()` now
  fetches the detector manifest first and fails with a sentence.
- The confidence was read from `faceScore`, which is produced by the **mesh** model. Mesh
  is deliberately disabled, so it is always `0`; the minimum-score filter then discarded
  every face. The feature would have found nothing, silently. Real confidence lives in
  `boxScore`/`score`.

`tools/face-smoke.mjs` drives a real browser against the real model and reports the model
base, the preflight, the load, a blank image (0 faces expected) and a drawn face. **Check
the score is non-zero** — that is the assertion that would have caught the second bug:

```
drawn face : DETECTED 1 | vec dim 1024 | score 0.46 | box 0.20,0.29,0.56,0.56
             | adapter keys: box,score,vec
```

`adapter keys: box,score,vec` is the privacy boundary holding against the *real* engine,
which does return `age`, `gender`, `genderScore` and `emotion` on its raw objects.

Run it after touching anything in `84-faces.js` above the vector maths.

### Prove the test can fail

A test that cannot fail is decorative. Both fault-injection guarantees were verified by
removing the fix and confirming the suite goes red:

| mutation | caught by |
|---|---|
| `ensureIndex` opens `thumbs/` eagerly again | 3 assertions, incl. *opening the index never touches thumbs/* |
| `appendLines` stops checking the resulting length | *a write that silently lands short is caught* |
| the pre-scan safety copy goes back to running silently | *the safety copy is given a progress callback*, *the progress card is already visible while it runs* |
| the thumbnail rebuild stops calling `saveThumb` | *nothing is missing afterwards* + a read-back throw |
| a face row carries everything the engine returned | *no age, gender, emotion or ethnicity is ever stored* |
| a saved threshold is carried straight across a meaning change | *an old threshold is not applied to ArcFace* |
| the face plan walks with no progress callback | *the walk is given a progress callback* |
| the People tab stops mirroring run progress | *the People tab shows how far along it is* |

Do this for any new assertion that guards a defect which has actually shipped.

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

- **Escape sequences reach the screen silently.** `"Press \\u201cFind faces\\u201d"` in a
  source file renders the backslashes literally, and nothing else notices. One assertion
  walks the rendered DOM (skipping `<script>`) plus every `placeholder` and `title`,
  looking for `\\uXXXX`, `\\n` and `\\t`.
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
