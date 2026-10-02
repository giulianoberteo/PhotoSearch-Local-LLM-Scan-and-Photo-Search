# Testing

How the project is tested, how to run the tests, and the techniques that turned out to
matter: injecting failures, proving a test can fail, and exercising the UI without a photo
library.

## Index
<!-- index:start -->
- [The self-test](#the-self-test)
- [Running the self-test in your own Chrome](#running-the-self-test-in-your-own-chrome)
  - [Reading the report](#reading-the-report)
- [Running it headlessly](#running-it-headlessly)
- [Verifying a build](#verifying-a-build)
- [Testing against storage that misbehaves](#testing-against-storage-that-misbehaves)
- [Exercising the UI without a photo library](#exercising-the-ui-without-a-photo-library)
- [Tests that need the real thing](#tests-that-need-the-real-thing)
  - [A synthetic benchmark cannot rank recognition models](#a-synthetic-benchmark-cannot-rank-recognition-models)
  - [The face model needs a live check](#the-face-model-needs-a-live-check)
- [Prove the test can fail](#prove-the-test-can-fail)
- [Pitfalls when writing tests](#pitfalls-when-writing-tests)
  - [A modal dialog wedges the whole suite](#a-modal-dialog-wedges-the-whole-suite)
  - [Locating a hang](#locating-a-hang)
  - [Assert invariants, not deltas](#assert-invariants-not-deltas)
  - [Smaller things worth knowing](#smaller-things-worth-knowing)
<!-- index:end -->

## The self-test

Build with `python3 build.py`, then open `PhotoSearch.test.html#selftest`. (The shipped `PhotoSearch.html` does not contain the test suite.)

Open `PhotoSearch.test.html#selftest` and the suite runs automatically, or press **Run
self-test** in *Settings → Diagnostics*. It takes about 60 seconds and needs no model: it uses
mock responses and an
[OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)
scratch folder, so your real photos and index are never touched.

**About 500 assertions** cover:
**534 assertions** (479 baseline plus 55 consumer-readiness regressions) covering:

- **pure logic:** Easter and occasion dates, singularisation, validation caps, enum checks
- **`image_type` correction** from filename, EXIF, dimensions and caption
- **the decode worker:** resizing, thumbnails, format policy
- **the index:** append, reload, compaction, vectors appended a row at a time
- **identity matching:** scan a subfolder then the library root; the same filename in two
  folders stays two photos; a forged name/size/mtime collision is rejected by content
- **crash safety:** the plan finds exactly the missing work when a record is lost
- **backup and restore**, including genuinely corrupting `records.jsonl` on disk
- **search:** BM25, filters, phrases, the relevance floor
- **chat:** history trimming, and that model output can never inject HTML
- **UI invariants:** nothing marked `hidden` is actually visible
- **storage invariants:** the vectors file is always exactly as long as its id list claims, a
  torn final row is healed, and an unforced checkpoint save is throttled, not written
- **any OpenAI-compatible server:** URL forms with and without `/v1`, model-type guessing for
  Ollama names, the three structured-output contracts, and per-server CORS advice
- **storage that misbehaves:** slow, hanging, failing and short writes (see below)
- **faces:** grouping by resemblance, naming, merge and split; that re-grouping never
  destroys a name; that a new photo of a named person joins them; and that **no age, gender,
  emotion or ethnicity ever reaches storage**
- **timeline:** day grouping, newest-first ordering, deleted and undated handling, and that
  no thumbnail is rendered until its day is on screen
- **library:** ordering (newest first, undated last, in either direction), that deleted and
  failed records are left out, that only tiles near the viewport are created and their
  thumbnails pinned then released, and the viewer's open, step, details and close cycle
- **removing photos:** that a removal sets `hidden` and not `deleted`, leaves the library and
  search, appears in the Removed view, and is undone by restoring
- **header search:** the month and photo-set filters; several people from one phrase (`anna + ben`,
  `&`, `and`, partial last name, unique prefix); tokens in the field and Backspace; suggestions for people, places, dates, kinds
  and things (and that hidden photos are not counted); how chips become filters, including the
  replace-not-add rule and the exact person photo set; and that results keep ranked order and
  never include a removed photo
- **tab links:** that `#library` and its case, parameter, slash and encoded variants name the right
  tab, that `#selftest` and unknown hashes are never tabs, and that showing a tab selects it
- **favourites:** a heart is stored on the record and written to the index, the Favourites view
  lists only hearted photos and drops one when it is unhearted, `#favourites` and its search chip
- **rotating photos:** that a turn is stored on the record and written to the index, wraps
  at 360 degrees, applies to each photo from its own angle, survives three quick clicks, and
  is drawn on the tile
- **thumbnail rebuild:** missing ones are detected and remade, error stubs are not queued,
  orphans are reported but never deleted, and photos outside the open folder are reported
  rather than silently skipped

The consumer suite in `src/js/91-consumer-selftest.js` additionally exercises persistent
separations/rejections, one-step undo, same-photo exclusions, ambiguous-match review,
hard name constraints, exclusions, literal quotes, duplicate-name disambiguation,
multi-person/date/place intersections, full-result pagination, the actual Search form,
failed-save rollback, checksum corruption, face-data restore, legacy restore, `keep=1`,
maintenance exclusion and library identity isolation. All writes use OPFS scratch data.

The runner loads a fresh build using a unique query parameter and then runs the suite
**twice in the same page** by default. A navigation to the identical URL can leave an old
build loaded; this is why refreshing the document explicitly matters. The optional fifth
argument sets the number of runs. Settings are restored after the test.

No connected interactive browser was available during this change. The Search screen's
DOM and actions were exercised in isolated headless Chrome; visual appearance, real-model
recognition precision, NAS write recovery, and a full private-library migration are not
claimed as validated. See CONSUMER-REVIEW.md and ROADMAP.md for the remaining gates.

A real HEIC decode is skipped unless you supply a sample:

```
PhotoSearch.test.html#selftest&heic=file:///path/to/sample.heic
```

[↑ Back to Index](#index)

---

## Running the self-test in your own Chrome

The self-test builds a scratch folder in Chrome's private file area (OPFS), and Chrome does not
give that to a page opened from disk (`file://`). Depending on the version, you either see
**"SecurityError: It was determined that certain files are unsafe for access within a Web
application, or that too many calls are being made on file resources"** or nothing happens at
all. It means only this; your photos and index are fine, and the app itself works from a file.
The self-test now checks first and explains it, instead of failing deep inside.

Pick one:

1. **Start Chrome with a flag.** Quit Chrome completely (it ignores the flag if it is already
   running), then:
   ```bash
   open -a "Google Chrome" --args --allow-file-access-from-files
   ```
   and open `PhotoSearch.test.html#selftest`.
2. **Serve the file.** In the folder containing `PhotoSearch.html`:
   ```bash
   python3 -m http.server 8000
   ```
   and open `http://localhost:8000/PhotoSearch.test.html#selftest`.

### Reading the report

The result opens with a verdict, for example "All 562 checks passed" or "3 of 562 checks
failed". Failures come first, each with what it got and what it wanted. The passed checks are
folded away. If the run stops early, the report says what happened in words, which check was the
last to complete (the problem is in what runs after it), and what to do. **Copy report** puts a
plain-text version on the clipboard for an issue.

[↑ Back to Index](#index)


## Running it headlessly

`tools/selftest-runner.mjs` drives Chrome over the DevTools protocol and exits non-zero on
failure. It needs Node 22 or later (it uses the global `WebSocket`).

```bash
rm -rf /tmp/chrome-selftest
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --no-sandbox \
  --user-data-dir=/tmp/chrome-selftest --remote-debugging-port=9222 \
  --allow-file-access-from-files about:blank &

node tools/selftest-runner.mjs \
  "file://$PWD/PhotoSearch.test.html#selftest" "window.__selftest" 300000
```

`--allow-file-access-from-files` is required. Without it OPFS is unavailable from `file://`
and the suite cannot create its scratch folder.

**`--dump-dom` does not work** for this. It fires at load, before any async work, and
`--virtual-time-budget` stalls indefinitely on IndexedDB and OPFS. Drive the suite over CDP.

[↑ Back to Index](#index)

---

## Verifying a build

```bash
python3 build.py --check          # fails if PhotoSearch.html is out of date
python3 tools/doc_index.py --check  # fails if a doc's Index or links are out of date
```

Run the self-test before proposing a change. If you touched scanning, search or chat, run it
twice **in the same page**, not as two fresh loads. A fresh tab proves nothing about state left
behind by the first run:

```js
await ev("window.__selftest = null; selfTest();");
```

[↑ Back to Index](#index)

---

## Testing against storage that misbehaves

Every other test here runs against OPFS, which is fast, local and never fails. The conditions
that actually broke this app are the opposite, and until `src/js/95-faultfs.js` existed none
of them were reproducible: three defects shipped that no number of green assertions could
have caught.

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
`S.indexDirHandle` assignments. Nothing in the app calls `faultFS`; it is test-only.

`shortWrites` is the nastiest of the five, and the reason `appendLines` checks the resulting
file length: a write that reports success having stored half its data raises no error
anywhere, so the caller carries on believing those records are safe.

For a share that drops a connection and then recovers (the case retries exist for), use the
supplied rng:

```js
faultFS(dir, { failWrites: 1, rng: failFirstWrites(2) })   // first two writes fail
```

**A hang is deliberately unrecoverable.** `hangPaths` awaits a promise that never settles,
exactly as the real share behaves. Anything that must survive it has to impose its own
deadline, which is the point of asserting against it. Set `S.io.deadlineCapMs` low (a few
hundred ms) for the duration of such a test and restore it afterwards. Never let a hang happen
inside `exclusive()`: that lock serialises every index write, and a wedged chain would stall
the rest of the suite.

The **face engine is injected** the same way. `setFaceEngine(fn)` replaces the detector with a
stub returning planted vectors, so nothing in the face tests needs a network, a GPU or a model
download. Use orthogonal vectors with a little jitter for distinct identities; vaguer ones do
not test the clustering threshold, they test the noise.

[↑ Back to Index](#index)

---

## Exercising the UI without a photo library

The self-test checks logic. To *see* a view such as the Library or Timeline, or to drive its
interactions, you do not need a real folder: fake the data and the I/O.

1. Open the built file in headless Chrome, with a small script appended before `</body>`.
2. Fill `IDX.records` with synthetic records, and set `IDX.dir = {}`, `IDX.loaded = true` and
   `S.dirHandle = {}` so the tab believes an index is open.
3. Stub the I/O the view uses: `thumbUrl` (return SVG data URIs), `fileByPath` (return
   `null`), and for write paths `ensureIndex`, `readFullRecords` and `appendLines`.
4. Click the tab, drive the UI with `.click()` and synthetic `KeyboardEvent`s, record what
   happened, and write it into a `data-` attribute you read back with `--dump-dom`.
5. Use `--screenshot` for the visual check, and `--window-size` to try a narrow window.

Two limits to know about. Headless Chrome delivers **no scroll events without a rendered
frame**, so call the render function directly (`galRender()`) after `scrollTo`, instead of
waiting for the listener. And the stubs must be assigned to the global function names, which
works because the app is one classic script.

This caught a real bug the logic tests had missed: after a removal the Library cleared its
tiles by looking up each one's photo in the *new*, shorter list and read past the end. Tiles
now carry their own id (see
[FINDINGS.md](FINDINGS.md#17-things-outlive-the-list-that-created-them)).

[↑ Back to Index](#index)

---

## Tests that need the real thing

### A synthetic benchmark cannot rank recognition models

Drawn faces were good enough to prove that **alignment** works, because alignment is geometry:
the same face rotated must embed to nearly the same vector, and that showed up clearly
(0.527 → 0.925 self-similarity). The same benchmark then said ArcFace was *worse* than
`faceres` (separability 0.176 against 0.339), because two crude cartoons look like the same
person to a model trained on real faces, which scored them 0.774 alike.

So use synthetic faces for geometry, never for identity. The only valid labels for ranking
embedders are the groups the **user** has named, which is what `compareEmbedders()` uses:
same-person against different-person cosine on their own photos, with a suggested threshold
derived from the gap.

### The face model needs a live check

The self-test injects the face engine, so it never loads the real one. That is deliberate (no
test should need a 15 MB download), but it makes a whole class of failure invisible to it, and
two of them shipped:

- `modelBasePath` pointed at a package that does not exist. TensorFlow.js does not report a
  404; it parses the error page as a graph and dies later on **"Cannot read properties of
  undefined (reading 'inputNodes')"**, which names nothing. `checkFaceModels()` now fetches
  the detector manifest first and fails with a sentence.
- The confidence was read from `faceScore`, which is produced by the **mesh** model. Mesh is
  deliberately disabled, so it is always `0`, and the minimum-score filter then discarded every
  face. The feature would have found nothing, silently. Real confidence lives in
  `boxScore`/`score`.

`tools/face-smoke.mjs` drives a real browser against the real model and reports the model
base, the preflight, the load, a blank image (0 faces expected) and a drawn face. **Check that
the score is non-zero.** That is the assertion that would have caught the second bug:

```
drawn face : DETECTED 1 | vec dim 1024 | score 0.46 | box 0.20,0.29,0.56,0.56
             | adapter keys: box,score,vec
```

`adapter keys: box,score,vec` shows the privacy boundary holding against the *real* engine,
which does return `age`, `gender`, `genderScore` and `emotion` on its raw objects. Run this
after touching anything in `84-faces.js` above the vector maths.

[↑ Back to Index](#index)

---

## Prove the test can fail

A test that cannot fail is decorative. Both fault-injection guarantees were verified by
removing the fix and confirming the suite goes red:

| mutation | caught by |
|---|---|
| `ensureIndex` opens `thumbs/` eagerly again | 3 assertions, including *opening the index never touches thumbs/* |
| `appendLines` stops checking the resulting length | *a write that silently lands short is caught* |
| the pre-scan safety copy goes back to running silently | *the safety copy is given a progress callback*, *the progress card is already visible while it runs* |
| the thumbnail rebuild stops calling `saveThumb` | *nothing is missing afterwards* plus a read-back throw |
| a face row carries everything the engine returned | *no age, gender, emotion or ethnicity is ever stored* |
| face vectors rewrite the whole file instead of appending | *adding one face writes exactly one row* (counts bytes written, not file size) |
| face vector memory is published before the write commits | *memory is unchanged by a failed write* |
| a saved threshold is carried straight across a meaning change | *an old threshold is not applied to ArcFace* |
| the face plan walks with no progress callback | *the walk is given a progress callback* |
| the People tab stops mirroring run progress | *the People tab shows how far along it is* |

Do this for any new assertion that guards a defect which has actually shipped.

[↑ Back to Index](#index)

---

## Pitfalls when writing tests

### A modal dialog wedges the whole suite

`confirm()` and `alert()` are **synchronous** modals. Unhandled in headless Chrome they block
the renderer main thread *forever*: `Runtime.evaluate` stops returning, and even
`Runtime.enable` never completes. The symptom is indistinguishable from an infinite loop, with
no error and no timeout.

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

A blocked main thread cannot be queried, so the last assertion that *completed* is the only
evidence available. `ok()` therefore streams every assertion to the console, and the driver
prints console output live rather than buffering it to the end:

```
[ 60] PASS  nothing else is called missing
>>> main thread BLOCKED. last assertion: PASS  nothing else is called missing
```

The hang is in the code *after* the last line printed. Without this, the suite simply ran
until killed, three times, with no output at all.

### Assert invariants, not deltas

Two assertions in this suite were wrong in the same way: they measured a *change* against a
starting state that an earlier test had deliberately damaged.

`"one new vector grows the file by exactly one row"` expected +256 bytes and saw +253, because
an earlier test leaves a torn final row on disk and the append correctly **heals** it. The
code was right and the assertion was not. It now states the invariant that must always hold:
the file is exactly `ids.length × dim × 4` bytes.

Likewise a checkpoint test wrote without `force` and read back a stale file, because
`saveCheckpoint` throttles to one write per 30 seconds. The throttle is deliberate (it was
roughly 3 GB of writes over a 50,000-photo run), so it is now asserted explicitly, including
the fact that memory moves ahead of disk.

### Smaller things worth knowing

- **Escape sequences reach the screen silently.** `"Press \\u201cFind faces\\u201d"` in a
  source file renders the backslashes literally, and nothing else notices. One assertion walks
  the rendered DOM (skipping `<script>`) plus every `placeholder` and `title`, looking for
  `\\uXXXX`, `\\n` and `\\t`.
- **Absence of `FAIL` is not a pass.** Grep for `EXCEPTION` and `TIMEOUT` too, because a suite
  that died on a syntax error prints no failures at all.
- **Headless has no file dialogs**, so picker behaviour cannot be tested that way.
- **OPFS does not preserve `lastModified`**, which usefully reproduces a NAS copy that loses its
  timestamp, the case the name+size matching tier exists for.
- **Tests share one scratch folder and run in order**, so clean up what you create. Tests that
  swap `IDX.records` or stub a global function must restore it in a `finally`.

[↑ Back to Index](#index)
