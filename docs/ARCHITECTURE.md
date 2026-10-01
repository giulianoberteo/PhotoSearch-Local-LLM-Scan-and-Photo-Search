# Architecture

Everything runs in one browser tab. There is no server, no database engine and no
framework — deliberately, because the project's premise is a file you can copy anywhere.

```
PhotoSearch.html
├── decode worker (Blob URL)     decode · EXIF orientation · 1024px + 384px JPEG
├── index store                  .photoindex/ — JSONL, float32, thumbnails
├── planner                      walk · identity matching · new/changed/stale/missing
├── scan runner                  queue · retries · checkpoint · backup
├── search                       BM25 + cosine + reciprocal rank fusion
├── chat agent                   tool-calling loop over the index
├── timeline                     browse by day · lazy, windowed thumbnails
├── faces                        detect · embed · group by resemblance · you name them
└── fault proxy (test-only)      slow · hanging · failing · short-writing storage
```

## The index

Plain files, readable with anything:

| file | contents |
|---|---|
| `records.jsonl` | one JSON object per photo, append-only; the last line for an id wins |
| `vectors.bin` | raw float32 rows, appended a row at a time |
| `vectors.json` | the id list mapping rows to photos |
| `thumbs/<id>.jpg` | 384px thumbnail |
| `config.json` | settings, the full extraction schema, `schema_hash`, `prompt_hash` |
| `runs.jsonl` | one line per scan: timing, errors, models, hashes |
| `state.json` | resume checkpoint: the pending queue |

Append-only means a crash truncates at most the last line, which the loader skips. It also
means the file grows on re-scans — **Compact log** rewrites it to latest-state-only.

**Memory.** Records are *lightened* before entering memory: `raw_model_json` and the
embedding stay on disk. A 50k-photo library costs kilobytes per record, not tens.

## Identifying a photo

A record is keyed to the **file**, not to where you pointed the picker. Matching order:

1. **stored path**, qualified by the folder it was scanned from — pick two different
   subfolders and both photos are literally `IMG_1.jpg`, so an unqualified path match would
   merge them
2. **identity** = name + size + modified time — free, since we already stat every file
3. **name + size** — for copies that lost their timestamp (NAS transfer, `rsync` without `-t`)

Tiers 2 and 3 are then **confirmed by content**: size plus a hash of the first 64 KB, stored
at scan time while the file is already open. Only *candidates* are verified, so it costs a
handful of extra reads, not one per photo. A 1:1 requirement means true duplicates are never
guessed at.

Consequence: scan a subfolder today and the whole library tomorrow — one index, no
duplicates, nothing wrongly marked missing.

## The plan

Walk → stat (12-way parallel; over SMB this is the difference between fast and unusable) →
classify each file as **new**, **changed** (fingerprint differs), **failed**, **stale**
(schema/prompt/model hash differs) or **ok**. Records not seen become **missing**, but only
those belonging to the folder actually walked.

**The plan is the source of truth, not the checkpoint.** A photo with no record is `new`; a
photo with an error record is `failed`. Delete the checkpoint entirely and you lose nothing
but a re-walk. This is what makes "you can never restart from zero" true.

## Scanning one photo

1. read the file (retried — network shares drop reads)
2. decode and resize in the worker; EXIF orientation applied during decode
3. read EXIF: date with a recorded **source** and **confidence**, camera, GPS
4. send the 1024px image with the schema in `response_format` — which is also what
   suppresses reasoning (see [FINDINGS.md](FINDINGS.md))
5. validate and normalise in JS: caps, enums, singularisation, synonyms
6. correct `image_type` from filename, EXIF, dimensions and the model's own caption
7. for text-heavy types, a second pass with an **array-of-lines** schema
8. resolve GPS to a place name offline; derive date context (season, weekday, occasion)
9. embed a document built from caption, description, objects, text, place and date

Flushed in batches of 25: records, then vectors, then the checkpoint — in that order, so a
crash leaves the checkpoint stale rather than ahead of the data.

## Search

No vector database. At 20k photos a brute-force pass is a few milliseconds; an ANN index
would add a dependency and a build step to save time nobody is spending.

1. **filter** — dates, place, `image_type`, occasion, entities, text
2. **BM25** over the inverted index (k1 = 1.4, b = 0.75), built at load
3. **cosine** over `vectors.bin`, with a **relevance floor** — cosine is never zero, so
   without one a nonsense query returns a confident list of junk
4. **reciprocal rank fusion**, `Σ 1/(60 + rank)` — rank-based, so the two incompatible
   score scales need no normalisation

Exact phrases in `"quotes"` are a filter, not a ranking signal, and are stripped before
ranking so the rest of the query still scores.

## The chat agent

A `while` loop against `/v1/chat/completions` with `tools`, capped at six rounds. **Tools
execute locally** — the model never sees the index, only compact JSON rows (id, date, place,
caption ≤150 chars, score). The one exception is `look_at_photos`, which sends up to six
stored thumbnails back to the vision model.

Eight tools: `search_photos`, `filter_photos`, `find_similar`, `get_photo`, `list_entities`,
`list_events`, `library_stats`, `look_at_photos`.

History is trimmed to a character budget, never orphaning a tool reply from the assistant
turn that requested it — tool results are large and context is finite.

Models without tool support are detected and fall back to retrieve-then-answer, with a badge
showing which mode is live.

**Model output is never inserted as HTML.** A small markdown subset is rendered into DOM
nodes, so a caption containing markup stays inert. There is a test asserting exactly that.

## Safety properties

- writes are confined to `.photoindex/`; nothing else is modified, moved or deleted
- **Mark missing** refuses to run when a folder returns no images at all — an unmounted NAS
  cannot soft-delete a library
- five identical failures in a row stop a scan rather than writing thousands of error records
- index writes are serialised: `appendLines` reads a size then seeks to it, so concurrent
  appends would otherwise overwrite each other
- restoring a backup first copies the current state, so a mistaken restore is undoable
- thumbnails are the only derived part of the index, and the only part excluded from
  backups — which is honest because **Rebuild thumbnails** remakes them from the originals
  with no model calls, matching photos by content rather than by stored path
- an index that cannot be read is an **empty** index, never a stale one: loading a location
  with no `records.jsonl` clears memory rather than leaving the previous location's records
  behind, where they would be planned against and then flushed into the new index
- `vectors.bin` is reconciled to its id list in both directions on load, and a write that
  does not land at the expected length is refused before the ids describing it are recorded
- a stalled write cannot wedge the index: the serialising lock has a timeout, so one
  unresponsive NAS operation does not block every write that follows
- the model can fill in fields but never *identify* a record: `id`, `path`, `fingerprint`,
  `size`, `mtime` and `scanned_at` are reserved and stripped from model output
- a failure keeps its `cause`, so callers can tell a deleted folder from an unreachable
  share — the two need opposite responses, and a `DOMException` loses its name when wrapped

## Storage is assumed to be slow and unreliable

Not as an edge case — as the normal case. The index lives on an SMB share where a single
round trip measured 24 seconds when the drives were asleep, and a directory listing 75.

- **Speed is measured, not guessed.** Opening `.photoindex/` and reading `config.json` are
  timed as they happen, so the probe costs nothing extra, and a listing is timed once on
  connect. The result is shown to the user in Settings.
- **Every deadline is sized from that measurement** (`ioDeadline`), between a floor and a
  cap. The alternative was a guessed constant, raised from 30s to 120s to 120s again, each
  time after it fired on storage that was merely slow rather than broken.
- **One wrapper for every index operation.** `indexOp(label, fn)` supplies the deadline,
  the progress reporting and the error naming. A failure always says both what was
  attempted and how far it got — `opening the index … [stuck at: Reading config.json…]` —
  because the backup that failed four times reported the least of anything in the app.
- **Writes are verified by length.** `appendLines` and `appendVectors` both re-read the
  file and refuse to report success unless it grew by exactly what was written.

## Faces

Detection and embedding run **in the browser** — LM Studio's embeddings endpoint is
text-only, so there is no alternative. `.photoindex/faces/` holds `faces.jsonl` (geometry
and provenance), `facevecs.bin`/`.json` (unit-length vectors, reconciled both ways on load
like the photo vectors), and `people.json` (groups and the names you gave them).

- **No crops are stored.** A face box is kept in 0..1, so a tile is the photo's existing
  thumbnail zoomed to that box. One less file per face, and one less write path.
- **Alignment is mandatory.** The descriptor runs on the crop it is given, so `face.mesh`
  and `face.detection.rotation` are on: without them the vector encodes head angle rather
  than identity (0.53 self-similarity versus 0.93 — see FINDINGS §10).
- **Grouping is greedy against centroids**, not all-pairs: 8,000 faces against a few
  hundred centroids is seconds, where all-pairs would be minutes. A candidate must be
  close to an actual member as well as to the centroid, because centroid-only merging
  drifts until a group is a blur of several people.
- **The engine configuration is recorded on every face.** Vectors from a different
  configuration are not comparable, so they are reported rather than silently mixed in.
- **A name is authoritative.** Re-grouping never re-clusters a named person's faces away,
  and unnamed faces are matched against named people first, so new photos join by
  themselves. Merge and split exist because clustering gets some wrong.
- **Nothing is inferred.** A group is "Group 1" until you type a name. `human`'s descriptor
  model computes age and a gender guess as a side effect of the embedding and cannot be
  asked not to; both are dropped at the adapter boundary, a face row is built field by
  field rather than spread, and a test asserts neither ever reaches storage. Emotion, iris,
  antispoof and liveness are switched off outright.
- **Thumbnails need no photo folder.** They are keyed by record id, so a face pass covers
  the whole index regardless of which folder is connected. Only the "originals" source
  needs a walk, and it can therefore only reach the folder that is open.
- **Names work everywhere**, not only in the People tab: `ensureFaceNames()` reads the two
  small files (not the vectors, which are tens of megabytes) so chat and the search box can
  filter by a name without loading the grouping machinery.
- **The aligned 112×112 crop is stored** (~5 KB a face). It is the output of work that
  cannot be cheaply redone — reading a photo off the share and detecting — so keeping it
  makes changing embedder a minute's work instead of a day's.
- **Two passes.** Thumbnails first (fast, and tells us which photos have people in them),
  then optionally the originals for just those photos, decoded large, because a face below
  112 px is upscaled into the model. Re-measuring matches old faces to new by box overlap
  so names survive.
- **One action deletes all of it**, leaving the rest of the index untouched.

## Known gaps

- **Orphaned thumbnails are counted, not collected.** A thumbnail whose record is gone
  stays on disk; deleting files is not a decision the rebuild makes on its own.
- **The fault-injection suite is simulation.** `95-faultfs.js` reproduces latency, hangs,
  failing and short writes, and the assertions were verified by removing the fixes and
  watching them go red. It is still OPFS underneath: it models the failures observed on
  the real share rather than the share itself.
