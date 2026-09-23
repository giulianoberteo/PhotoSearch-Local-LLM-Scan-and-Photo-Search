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

---

## 8. Index size

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
