# Findings

Measured results and behaviour that cost real time to discover. Everything here was
verified against a running system, not inferred from documentation. Where a number is an
estimate rather than a measurement, it says so.

Reference setup unless stated: Apple silicon Mac, 32 GB, LM Studio 0.4.12, MLX runtime,
`qwen3.5-9b-mlx` (4-bit), `text-embedding-nomic-embed-text-v1.5`.

---

## 1. Structured output suppresses reasoning — and that is the whole ballgame

Qwen3.5 reasons by default. On a trivial prompt it spent its **entire** 800-token budget
thinking and returned **empty content**:

| request | output tokens | seconds | result |
|---|---:|---:|---|
| plain | 799 | 26.7 | `content` empty — truncated mid-thought |
| `response_format: json_schema` | **13** | **2.4** | valid JSON |

Grammar-constrained generation leaves no room for a reasoning pass. Every scan call sends
the schema, so scanning gets thinking-off for free.

### What does *not* work in LM Studio 0.4.12

All of these were ignored. Verified by reading the actual prompt via `lms log stream`
(`llm.prediction.input`) — every one still ended with an open `<think>` tag:

- `chat_template_kwargs: {"enable_thinking": false}` ← the documented Qwen switch
- top-level `enable_thinking`, `thinking`, `reasoning: {enabled: false}`
- `reasoning_effort: "none"` / `"minimal"`
- the same options against the native `/api/v0/chat/completions`

The model's own `chat_template.jinja` *does* honour `enable_thinking` (it emits an empty
`<think></think>` block). LM Studio simply never passes the kwarg through.

### The gotcha that breaks naive clients

Because the template opened a `<think>` tag, LM Studio files the constrained JSON under
**`message.reasoning_content`** and leaves **`message.content` empty**.

```js
const payload = (m.content || "").trim() || (m.reasoning_content || "").trim();
```

Read only `.content` and you get an empty string on every single scan.

---

## 2. The same trick ruins OCR

Asking for one long verbatim string inside a schema lets the model satisfy the grammar and
stop. On a dense slide (ground truth **1,961 characters**):

| approach | output | result |
|---|---:|---|
| schema, one `text` field | **23 tokens** | stopped after the first line |
| no schema | 2,999 tokens | content empty — all budget spent reasoning |
| **schema, `lines: [string]` with `minItems`** | 509 tokens | **1,781 chars** |

A grammar demanding *many* array entries cannot be satisfied by stopping after one.
Scored at word level against macOS Vision OCR as ground truth:

| | recall | precision | F1 |
|---|---:|---:|---:|
| flat 300-char cap (original) | 17.8% | 93.3% | 29.9% |
| model's own, uncapped | 72.0% | 96.0% | 82.3% |
| **array-of-lines** | **88.1%** | 94.5% | **91.2%** |

Two lessons: the arbitrary cap was doing most of the damage, and the *shape* of a schema
changes how much a model will produce.

---

## 3. Throughput: the levers that do not work

Per photo, 1024px, full extraction schema:

| resolution | s/image | tokens |
|---|---:|---:|
| 1024px | 22.6 | 389 |
| 768px | 19.7 | 395 |
| 640px | 18.2 | 378 |

**Token count is flat.** Generation dominates; the image barely registers. Shrinking input
costs legibility (especially text) for ~19%.

| concurrency | throughput |
|---|---:|
| 1 | 236 img/hour |
| 2 | 231 img/hour |
| 4 | 235 img/hour |

**Flat.** LM Studio serialises unless the model is loaded with `--parallel`. No caching
confound: the same image twice gives 20.6s then 20.5s; three unseen images average 21.7s.

---

## 4. Consistency: what you can and cannot rely on

Five images scanned twice, identical settings:

| field group | agreement |
|---|---:|
| enums and scalars (`image_type`, `scene_type`, `weather`, `mood`) | **94%** |
| `search_keywords` | 64% |
| `activities` | 60% |
| `objects` | 59% |
| `observations` | **31%** |

**Design consequence:** enum filters are dependable; entity lists are not. Search leans on
embeddings and BM25 over caption/description rather than exact entity matching, because
"sword" on one pass may be "blade" on the next.

---

## 5. `image_type` needs help from outside the model

The model defaults almost everything to `photo` — and contradicts itself doing it. Real
examples where its own caption said otherwise:

- a Google Maps screenshot → `photo`, caption *"A digital map view…"*
- a presentation slide → `photo`, caption *"A presentation slide showing a flowchart"*
- a film poster → `photo`, caption *"A movie poster featuring…"*

Corrected locally, in priority order: **filename** (`Screenshot 2025-…`) → **camera EXIF**
(a real capture is a photo, whatever the model says) → **exact screen dimensions** →
**keywords in the model's own caption**. All four are free; none needs a second model call.

---

## 6. EXIF dates are frequently wrong

Files exported, edited or generated carry the *processing* time in **every** date field.
A verified example — `DateTimeOriginal`, `CreateDate`, `ModifyDate`, `DigitalCreationDate`,
`DateCreated`, `TimeCreated` and `SubSecTime` all agreeing, sub-second precision, timezone
offset present — and **no Make/Model/Software tags at all**. The owner is confident the
pictures are from years earlier. Nothing in the file records that.

**The signal that works:** a date from EXIF with *no camera tags* is suspect. Genuine
captures nearly always carry Make/Model. A large gap between `DateTimeOriginal` and
`ModifyDate` indicates an edit.

**Do not hand-roll an EXIF parser.** A naive "first `YYYY:MM:DD` in the bytes" grabs
`ModifyDate`, not `DateTimeOriginal`. Use [exifr](https://github.com/MikeKovarik/exifr).
Priority: `DateTimeOriginal` → `CreateDate` → filename → `lastModified`.

Filenames beat `lastModified` surprisingly often — `WhatsApp Image 2023-06-10 at 10.06.41`,
`Screenshot 2025-05-21 at 11.44.18`. Only year-first patterns are trusted; `04-07-2012` is
ambiguous and ignored.

---

## 7. Browser and filesystem behaviour

**Appends cost O(file size).** `createWritable({keepExistingData: true})` copies the whole
file. Measured: 5.2 ms at 0.5 MB → 9.1 ms at 4.9 MB. Rewriting `vectors.bin` in full was
worse: 19 ms at 12 MB → 105 ms at 61 MB, every flush. Fixed by appending only new rows and
raising the batch size.

**`requestAnimationFrame` never fires in a hidden tab.** Any `await` on a repaint hangs
*forever* when the window is backgrounded or occluded — no error, no timeout. If you await
a paint for progress updates, always race it against a timer.

**`content-length` is the compressed size.** Streaming a gzipped 17 MB file and computing
`got / content-length` produced *"515%"*. Report bytes, not percentages.

**One file picker at a time.** `showDirectoryPicker` throws *"File picker already active"*
for a second concurrent call. Worse, on macOS the panel helper process
(`com.apple.appkit.xpc.openAndSavePanelService`) can outlive the dialog, blocking every
later picker until Chrome is quit:

```bash
pkill -9 -f openAndSavePanelService   # clears an orphaned dialog
```

Do **not** disable the button that opened the picker — that can dismiss the dialog and leave
a promise that never settles.

**`libheif-js` 1.18 exports an async factory**, not a namespace:

```js
importScripts(LIBHEIF_URL);
const ns = await libheif();          // NOT `new libheif.HeifDecoder()`
const dec = new ns.HeifDecoder();
```

**Hash width matters.** A 32-bit id collides around 77,000 items (birthday bound) — well
inside a real photo library. Ids are 64-bit.

**A `DOMException` keeps its identity in its `name`, not its message** — and re-wrapping it
destroys that. A generic retry helper that did this:

```js
throw new Error(label + " failed after 3 tries: " + String(last.message || last));
```

turned `NotFoundError: A requested file or directory could not be found` into a plain
`Error` whose text contains the *message* but not the *name*. Callers testing
`/NotFoundError/` then silently never matched, so "this folder was deleted" became
indistinguishable from "the share is down" — and a scan scope pointing at a removed folder
hard-failed the entire plan instead of widening to the library. Carry the original as
`cause` and walk the chain:

```js
function isNotFound(e){
  for (let x = e, d = 0; x && d < 5; x = x.cause, d++)
    if (x.name === "NotFoundError") return true;
  return false;
}
```

The same helper also retried genuinely-absent entries three times with backoff. A missing
file does not appear by waiting.

**`confirm()` and `alert()` block the renderer main thread indefinitely** when nothing
answers them. In headless Chrome this is not a dialog you cannot see — it is a full stop:
`Runtime.evaluate` stops returning and even `Runtime.enable` never completes, so the page
cannot be queried to find out why. It presents exactly as an infinite loop, with no
exception and no timeout. Any CDP driver must handle `Page.javascriptDialogOpening`
(after `Page.enable`, before navigating), and any code path a test can reach should be
assumed to prompt.

---

## 8. In-memory state outlives the file it came from

The index is loaded into memory once and consulted from there. Every loader must therefore
treat "this file does not exist" as **a value** — an empty index — rather than as a reason
to return early:

```js
try { fh = await IDX.dir.getFileHandle("records.jsonl"); }
catch { IDX.loaded = true; return 0; }        // leaves the PREVIOUS index in memory
```

Switching the index to a fresh location left 6,635 records from the old location in
memory. The planner then judged photos against records that location had never held, and
the next flush wrote those foreign records *into* the new index. The sibling loader,
`loadVectors`, resets its state as its first statement and was never affected — the
asymmetry is what made it hard to see.

The same class of bug appears wherever memory is updated before the write that justifies
it. `vectors.bin` is the sharpest case: rows are placed by buffer length but indexed by
`ids.length`, so if the two ever disagree, every subsequent embedding maps to *another
photo's* vector. Dying between the `.bin` and `.json` writes produces exactly that
disagreement, and only the "bin is shorter" direction was originally handled. The file on
disk is the truth, and the id list must be reconciled to it in **both** directions.

---

## 9. A guessed deadline is always wrong somewhere

The backup's time limit went 30s → 120s → 120s again, raised each time after it fired on
storage that was slow rather than broken. No constant can be right for both a local SSD
and a sleeping SMB share, where these were measured on the same hardware:

| operation | local SSD | NAS awake | NAS asleep |
|---|---:|---:|---:|
| open a directory handle | < 1 ms | ~50 ms | **24 s** |
| read a small file | < 1 ms | ~90 ms | ~900 ms |
| list a 6,568-file folder | ~15 ms | **75.6 s** | 75.6 s+ |

That is four orders of magnitude on the first row. A limit generous enough for the third
column is no limit at all for the first, and one tuned for the first fails constantly in
the third.

**Measure instead.** Opening `.photoindex/` and reading `config.json` happen on every
index open, so timing them costs nothing, and the slowest observed round trip becomes the
unit that every deadline is expressed in. Unmeasured storage gets the floor rather than an
optimistic guess — assuming it is fast is precisely the mistake that produced a 30-second
deadline on a share needing 24 seconds to wake up.

**And report the step, not just the failure.** `"Backup failed"` is unactionable;
`"opening the index did not finish within 180s  [stuck at: Reading config.json…]"` names
the operation that hung. The backup that failed four times in a row reported the least of
anything in the app, which is why it took four attempts to find four different causes.

---

## 10. A face embedding without alignment describes the pose, not the person

`human`'s descriptor runs on whatever crop it is handed. Disabling `face.mesh` and
`face.detection.rotation` to avoid loading models that were not wanted removed the landmark
alignment the descriptor depends on, and the resulting vectors encoded head angle rather
than identity. Measured on the same drawn face across rotations and scales, against a
second face with different proportions:

| configuration | same face, different pose | different people | separability |
|---|---:|---:|---:|
| mesh + rotation **off** | 0.527 | 0.393 | **0.134** |
| mesh + rotation **on** | **0.925** | 0.586 | **0.339** |

Self-similarity is the number that matters: at 0.527 a photo of someone barely resembled
another photo of the same person, so no threshold could separate anybody. The docs do say
*"it is highly recommended to have face.mesh and face.detection.rotation enabled"* — for
recognition it is not a recommendation, it is a requirement.

**The threshold has to be measured too, not guessed.** At 0.55 — chosen before any of this
was measured — the cutoff sat *below* the 0.586 that two different faces score, so the
clusterer was merging different people by construction. 0.75 sits between the two.

**Centroid-only clustering cascades.** One wrong face moves the centre, which admits more
wrong faces, and a group becomes a blur of several people. Requiring a candidate to be
close to an actual member as well as to the centroid stops the drift.

**Small faces are noise.** A face 30 px across still yields a descriptor; it is simply not
about that person, and one of them poisons a whole group.

---

## 11. Cost the I/O, not the computation

The face backfill was estimated at "~20 minutes for 6,635 photos" from a measurement of the
detector: 8–19 ms per image, no degradation over hundreds of calls. That number was real
and completely beside the point.

| what is actually read | volume | at the measured 430 KB/s |
|---|---:|---:|
| the original photos | **14.3 GB** (2.2 MB average) | **9.7 hours** |
| the 384px thumbnails already in the index | **214 MB** | **8 minutes** |

The same photos, 69× less data. Detection was never the bottleneck; getting the pixels off
the share was the entire job, and the first version read every original one at a time.

Three corrections follow from this, and they generalise:

- **Read what you already have.** Thumbnails are in the index, are the right shape for a
  detector, and cost nothing to produce. They only lose faces that are small in the frame,
  which is a trade worth offering rather than deciding silently.
- **Overlap latency-bound reads.** A share answers one request at a time but happily
  handles several in flight. Reads run five-wide; detection stays serial because one
  TensorFlow instance is not re-entrant.
- **Size a gate in the unit that matters.** "A face must be 5% of the frame" means 51 px on
  an original and 19 px on a thumbnail. In pixels the question has one answer.

---

## 12. Store the expensive intermediate, not the cheap one

Face recognition has three stages with wildly different costs:

| stage | cost per photo |
|---|---|
| getting the pixels off the share | **~350 ms** (2.2 MB at 430 KB/s) |
| detect + landmarks | ~15 ms |
| embed an aligned crop | ~47 ms |

Changing embedder therefore costs 9.7 hours if the originals have to be re-read, and about
a minute if the **aligned 112×112 crop** was kept. The crop is ~5 KB; 15,000 faces is
75 MB, against the 226 MB of thumbnails already stored.

That inverts an earlier decision in this project. Display tiles deliberately store no crop,
because a box in 0..1 plus the existing thumbnail renders the same picture for free. The
*aligned* crop is a different thing: it is the output of work that cannot be cheaply
redone, and keeping it is what makes trying another model a minute's work rather than a
day's.

**ArcFace needs that alignment, not a box crop.** It is trained on faces warped onto a
fixed five-point template; hand it a raw rectangle and a recognition model behaves like a
texture matcher. The pipeline is: 468-point mesh → five canonical points (eyes, nose,
mouth corners) → least-squares similarity transform → 112×112 → `(x−127.5)/127.5` NCHW.

**Two embedders are two different spaces.** `faceres` cosines for one person sit around
0.93; ArcFace's sit far lower. A single threshold cannot serve both, so each carries its
own — and a face records which model measured it, because mixing them in one cluster is
meaningless.

**Browser facts worth keeping:** `onnxruntime-web` runs from `file://` with
`ort.env.wasm.wasmPaths` pointed at the CDN and `numThreads = 1` — threads need
`SharedArrayBuffer`, which needs COOP/COEP headers a local file cannot send. And despite
advertising `access-control-allow-origin: https://huggingface.co` on its redirect,
huggingface.co **does** serve model weights to a `file://` page; jsDelivr's `gh` endpoint
returns 133-byte Git-LFS pointers for model files, which is not obvious until you read what
you downloaded.

---

## 13. Index size

Measured on real photos, then projected:

| photos | records | vectors | thumbnails | total |
|---:|---:|---:|---:|---:|
| 10,000 | 50 MB | 31 MB | 329 MB | 0.41 GB |
| 100,000 | 500 MB | 307 MB | **3.3 GB** | 4.10 GB |

Thumbnails dominate at ~80%. 512px @ q0.75 measured **33 KB each** — not the ~2 KB assumed.
Dropping to 384px @ q0.7 roughly halves the index. They are also the only part that can be
rebuilt without model calls, which is why backups exclude them.

---

## Reproducing any of this

The measurement scripts are not shipped, but every number above came from either the
in-browser self-test (`PhotoSearch.html#selftest`) or a short script against
`http://localhost:1234`. See [TESTING.md](TESTING.md).
