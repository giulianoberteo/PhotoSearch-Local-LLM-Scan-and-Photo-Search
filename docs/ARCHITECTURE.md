# Architecture

How PhotoSearch is put together, and why. This is the document to read before changing
anything non-trivial. For *measurements* behind these decisions, see
[FINDINGS.md](FINDINGS.md); for running the thing, see [SETUP.md](SETUP.md).

## Index
<!-- index:start -->
- [Overview](#overview)
- [Where data lives](#where-data-lives)
  - [Photos and metadata are separate](#photos-and-metadata-are-separate)
  - [What reads what](#what-reads-what)
  - [The model server sees photos only in transit](#the-model-server-sees-photos-only-in-transit)
  - [Browser storage holds settings, not data](#browser-storage-holds-settings-not-data)
  - [Downloads](#downloads)
  - [What can be rebuilt, and what cannot](#what-can-be-rebuilt-and-what-cannot)
- [Navigation](#navigation)
- [Source layout](#source-layout)
- [The index](#the-index)
- [Identifying a photo](#identifying-a-photo)
- [The plan](#the-plan)
- [Scanning one photo](#scanning-one-photo)
- [Search](#search)
- [The chat agent](#the-chat-agent)
- [Browsing: Library and Timeline](#browsing-library-and-timeline)
  - [Library](#library)
  - [The search field](#the-search-field)
  - [Rotating photos](#rotating-photos)
  - [Removing photos](#removing-photos)
  - [Timeline](#timeline)
- [Faces](#faces)
- [The model server](#the-model-server)
- [Safety properties](#safety-properties)
- [Storage is assumed to be slow and unreliable](#storage-is-assumed-to-be-slow-and-unreliable)
- [Known gaps](#known-gaps)
<!-- index:end -->

## Overview

Everything runs in one browser tab. There is no server, no database engine and no
framework, deliberately: the project's premise is a file you can copy to any machine and
open. The only external dependency at run time is a model server you already have running
(LM Studio, Ollama and similar), and even that is reached over plain HTTP from the page.

```
PhotoSearch.html
├── decode worker (Blob URL)     decode · EXIF orientation · 1024px + 384px JPEG
├── index store                  .photoindex/ — JSONL, float32, thumbnails
├── planner                      walk · identity matching · new/changed/stale/missing
├── scan runner                  queue · retries · checkpoint · backup
├── search                       BM25 + cosine + reciprocal rank fusion
├── chat agent                   tool-calling loop over the index
├── library                      every photo in one grid · full-window viewer · remove/restore
├── timeline                     browse by day · lazy, windowed thumbnails
├── faces                        detect · embed · group by resemblance · you name them
└── fault proxy (test-only)      slow · hanging · failing · short-writing storage
```

The same data feeds every view. Scanning produces *records*; search, chat, the Library, the
Timeline and People are all different ways of looking at those records, and none of them
calls a model to do so (chat is the exception, because it talks to one by design).

[↑ Back to Index](#index)


## Where data lives

PhotoSearch deals with six places. Keeping them straight explains most of the design: what
survives what, what can be rebuilt, and what must be backed up.

| place | contents | who writes it | survives |
|---|---|---|---|
| **The photo folder** | the original files | you, never PhotoSearch | everything below being lost |
| **The index** (`.photoindex/`) | metadata, embeddings, thumbnails, face data | PhotoSearch | losing the browser profile |
| **Browser storage** | settings; remembered folder handles | PhotoSearch | losing the index |
| **The model server** | nothing durable, by design | n/a | n/a |
| **The browser cache** | libraries and models fetched from a CDN | the browser | being cleared (they are re-fetched) |
| **Memory** | the loaded records and vectors | PhotoSearch | nothing; it is rebuilt from the index |

### Photos and metadata are separate

The photo folder is **read-only as far as the app is concerned**. Every photo is read at most
a few times: once to scan it, and again if you open it full-size, run a face pass over
originals, or rebuild its thumbnail. Nothing outside `.photoindex/` is ever written, moved or
deleted, so the app cannot damage a library.

The metadata lives in the index and carries no full-size pixels. The only images in the index
are *derived*: a 384px thumbnail per photo (about 33 KB at the quality used) and, for faces, a
small aligned crop (about 5 KB). Embeddings are numbers, not pictures.

The two halves are joined by two keys stored in every record:

- **`path`**, relative to the folder that was picked, together with **`library_root`**, the
  name of that folder. This finds the file again when you open a photo or run a face pass.
- **A content fingerprint** (name, size, modified time, confirmed by a hash of the first 64
  KB). This lets the index follow a photo that was moved or renamed, and keeps two folders'
  `IMG_1.jpg` apart. See [Identifying a photo](#identifying-a-photo).

### What reads what

| view or action | needs the index | needs the photo folder |
|---|---|---|
| Library, Timeline, search, chat, People | yes | **no**: they use thumbnails and metadata |
| Open a photo full-size | yes | **yes**: reads the original; falls back to the thumbnail |
| Scan, Refresh plan, Rebuild thumbnails | yes | **yes** |
| Face pass over *thumbnails* | yes | no |
| Face pass over *originals* | yes | **yes**, and only for the folder that is open |
| Backup and restore | yes | no |

This is why the index can live on a different disk from the photos. With the index on a local
disk and the photos on a NAS, everything in the first row keeps working while the NAS sleeps.

### The model server sees photos only in transit

Scanning sends a resized 1024px JPEG of each photo, with the schema, to the model server. Chat
sends your questions and compact search results, and `look_at_photos` sends up to six stored
thumbnails. PhotoSearch asks the server to keep nothing, but what a server logs is its own
setting, so check it if that matters to you.

### Browser storage holds settings, not data

`localStorage` keeps the server URL, model roles, scan and date settings, and the Library tile
size. IndexedDB keeps *directory handles* for the last photo folder and index folder. A handle
is a permission-bound pointer, not a copy. Chrome drops the permission when the page reloads,
so the app asks you to re-approve the folder, and the index is untouched by that.

### Downloads

HEIC and TIFF decoders, `exifr`, the face detection and recognition models are fetched by the
browser from public CDNs on first use and kept in its normal cache. The GeoNames place list is
the one download the app stores itself, in `.photoindex/geo/`, after which place lookup is
fully offline.

### What can be rebuilt, and what cannot

| lost | recovered by | cost |
|---|---|---|
| thumbnails | **Rebuild thumbnails** from the originals | minutes; no model |
| embeddings (`vectors.bin`) | rescan the affected photos (**Refresh stale**); search is keyword-only meanwhile | model time |
| face groups | **Find faces** again | minutes (thumbnails) to hours (originals) |
| `state.json` | **Refresh plan** | a re-walk |
| `records.jsonl` | nothing but a backup or a rescan | **about 21.5 s per photo** |

`records.jsonl` is the one irreplaceable file, which is why the app backs it up after every
scan and why [OPERATIONS.md](OPERATIONS.md#backing-up-by-hand) has a command that always works.

[↑ Back to Index](#index)

---

## Navigation

The six tabs are addressed by the URL hash: `#library`, `#chat`, `#timeline`, `#people`, `#scan`
and `#settings`. `tabFromHash()` turns a hash into a tab name (case-insensitive, tolerating a
leading `/`, percent-encoding and trailing `&parameters`), and returns nothing for any other
hash. That matters because the self-test is started with `#selftest`, which must never be
mistaken for a tab.

- **Choosing a tab** sets the hash (adding a history entry, so Back and Forward work) and calls
  `showTab()`.
- **Opening or changing an address** calls `showTab()` for a valid tab name, at boot and on
  `hashchange`.
- **`showTab()`** selects the button, hides the other tabs and runs the tab's "shown" hook
  (the Library, Timeline and People build themselves on first view). It does not touch the
  hash, so it can be called from either direction without looping.
- **Deep links and reconnecting.** Chrome drops folder access on reload, so a page opened on
  `#library` usually appears before its folder is connected. When a folder or index location is
  connected afterwards, `refreshActiveTab()` re-runs the open tab's hook, so it fills in
  without the user having to switch away and back.

[↑ Back to Index](#index)

---

## Source layout

`PhotoSearch.html` is **generated**. The source lives in `src/js/` and `build.py`
concatenates it, in a fixed order, into `src/shell.html`. Later files may use names defined
earlier, never the reverse.

| file | responsibility |
|---|---|
| `00-core.js` | helpers, settings, the model-server client, tab switching and tab links |
| `25-datetime.js` · `26-geo.js` · `35-exif.js` | dates and occasions, offline place names, EXIF and date confidence |
| `30-worker.js` | the decode and resize worker |
| `40-store.js` · `42-backup.js` | the `.photoindex/` reader and writer; backup and restore |
| `45-plan.js` | folder walk, identity matching, the plan |
| `50-validate.js` · `55-extract.js` | normalising model output; the vision call, OCR pass, embeddings |
| `60-derived.js` · `65-search.js` | entities, events and the inverted index; ranking |
| `70-runner.js` | the scan runner |
| `80-ui.js` | Settings and Scan tabs |
| `85-chat.js` · `87-chatui.js` | the tool-calling agent; chat rendering and the lightbox |
| `82-timeline.js` · `83-library.js` | the Timeline tab; the Library tab and its viewer |
| `88-search.js` | the header search field: suggestions, chips, and results shown in the Library |
| `84-faces.js` · `86-peopleui.js` | face detection, grouping, naming; the People tab |
| `90-selftest.js` · `95-faultfs.js` | the in-browser test suite; the fault-injecting filesystem |
| `99-boot.js` | error surfacing and start-up |

`src/template.py` is the single source of truth for the extraction schema and prompt; the
build generates the JavaScript constant from it. See [CONTRIBUTING.md](../CONTRIBUTING.md).

[↑ Back to Index](#index)


## The index

The index is a folder of plain files, readable with anything. By default it is
`.photoindex/` beside the photos; Settings can point it somewhere else.

| file | contents |
|---|---|
| `records.jsonl` | one JSON object per photo, append-only; the last line for an id wins |
| `vectors.bin` | raw float32 rows, appended a row at a time |
| `vectors.json` | the id list mapping rows to photos |
| `thumbs/<id>.jpg` | 384px thumbnail |
| `faces/` | `faces.jsonl`, `facevecs.bin`/`.json`, `people.json` (see [Faces](#faces)) |
| `config.json` | settings, the full extraction schema, `schema_hash`, `prompt_hash` |
| `runs.jsonl` | one line per scan: timing, errors, models, hashes |
| `state.json` | resume checkpoint: the pending queue |
| `geo/` · `backups/` | cached place-name data; verified copies of the files above |

**Append-only is the durability strategy.** A crash can truncate at most the final line,
which the loader skips. The cost is that the file grows on every re-scan, since a changed
record is appended rather than edited; **Compact log** rewrites it to latest-state-only.

**Memory.** Records are *lightened* on load: `raw_model_json` and the embedding stay on
disk. A 50,000-photo library therefore costs kilobytes per record in memory, not tens of
kilobytes, and the few places that need the full record (rewriting it, for instance) read
it back from disk.

**A record has three independent lifecycle states.** They are easy to confuse, and the
distinction matters:

| state | meaning | who sets it | what the scan plan does |
|---|---|---|---|
| `status: "error"` | the model or decoder failed on this photo | the scanner | retries it ("failed") |
| `deleted: true` | the file is gone from disk ("missing") | **Mark missing** | treats it as absent, so the same file would be indexed again if it returned |
| `hidden: true` | *you* removed it from the library | the Library | leaves it alone: still matched, never rescanned, never re-surfaced |

A fourth field is a **view setting**, not a lifecycle state: `rotation` (0, 90, 180 or 270
degrees clockwise), set from the Library and applied only when a picture is drawn.

[↑ Back to Index](#index)


## Identifying a photo

A record is keyed to the **file**, not to where you pointed the folder picker. Matching is
tried in this order:

1. **Stored path**, qualified by the folder it was scanned from. Two different subfolders can
   each contain an `IMG_1.jpg`; an unqualified path match would merge them.
2. **Identity** = name + size + modified time. Free, because every file is already stat'd.
3. **Name + size**, for copies that lost their timestamp (a NAS transfer, `rsync` without `-t`).

Tiers 2 and 3 are then **confirmed by content**: size plus a hash of the first 64 KB, stored
at scan time while the file was already open. Only *candidates* are verified, so this costs a
handful of extra reads, not one per photo. A strict one-to-one requirement means true
duplicates are never guessed at.

The consequence: scan a subfolder today and the whole library tomorrow, and you get one
index, no duplicates, and nothing wrongly marked missing.

[↑ Back to Index](#index)


## The plan

Before scanning, PhotoSearch works out *what needs doing*: walk the folder, stat every file
(12 in parallel; over SMB that is the difference between fast and unusable), and classify:

| class | meaning |
|---|---|
| **new** | no record yet |
| **changed** | the file's fingerprint differs from the record's |
| **failed** | the record is an error stub |
| **stale** | the record was made with a different schema, prompt or model |
| **ok** | nothing to do |
| **missing** | a record whose file was not seen, but *only* among records from the folder actually walked |

**The plan is the source of truth, not the checkpoint.** A photo with no record is `new`;
a photo with an error record is `failed`. Delete the checkpoint entirely and you lose only
a re-walk. This is what makes "you can never restart from zero" true.

[↑ Back to Index](#index)


## Scanning one photo

1. Read the file (retried; network shares drop reads).
2. Decode and resize in the worker, applying EXIF orientation during decode.
3. Read EXIF: the date with a recorded **source** and **confidence**, camera, GPS.
4. Send the 1024px image with the schema in `response_format`. That is also what suppresses
   reasoning (see [FINDINGS.md](FINDINGS.md#1-structured-output-suppresses-reasoning)).
5. Validate and normalise in JavaScript: caps, enums, singular nouns, synonyms.
6. Correct `image_type` from the filename, EXIF, dimensions and the model's own caption.
7. For text-heavy types, make a second pass with an **array-of-lines** schema (OCR).
8. Resolve GPS to a place name offline; derive season, weekday and occasion.
9. Embed a document built from caption, description, objects, text, place and date.

Results are flushed in batches of 25: records first, then vectors, then the checkpoint. The
order is deliberate: a crash leaves the checkpoint *behind* the data, never ahead of it.

A rescan builds a record from scratch, so it carries one thing over by hand: `hidden`. A
photo you removed stays removed.

[↑ Back to Index](#index)


## Search

There is no vector database. At 20,000 photos a brute-force pass takes a few milliseconds;
an approximate-nearest-neighbour index would add a dependency and a build step to save time
nobody is spending.

1. **Filter** by dates, place, `image_type`, occasion, entities, person and text.
2. **BM25** over the inverted index (k1 = 1.4, b = 0.75), built at load.
3. **Cosine** over `vectors.bin`, with a **relevance floor**. Cosine similarity is never
   zero, so without a floor a nonsense query would return a confident list of junk.
4. **Reciprocal rank fusion**, `Σ 1/(60 + rank)`. Because it uses ranks, the two
   incompatible score scales need no normalisation.

Exact phrases in `"quotes"` are a filter, not a ranking signal. They are stripped before
ranking so the rest of the query still scores.

Records with `deleted` or `hidden` set, error stubs and probe records are excluded at the
start, so no later stage needs to remember to do it.

[↑ Back to Index](#index)


## The chat agent

A loop against `/v1/chat/completions` with `tools`, capped at six rounds. **Tools execute
locally.** The model never sees the index, only compact JSON rows (id, date, place,
caption of at most 150 characters, score). The single exception is `look_at_photos`, which
sends up to six stored thumbnails back to the vision model.

There are nine tools: `search_photos`, `filter_photos`, `list_people`, `find_similar`,
`get_photo`, `list_entities`, `list_events`, `library_stats` and `look_at_photos`.

- **History** is trimmed to a character budget and never orphans a tool reply from the
  assistant turn that requested it. Tool results are large and context is finite.
- **Models without tool support** are detected and fall back to retrieve-then-answer, with a
  badge showing which mode is live.
- **Model output is never inserted as HTML.** A small Markdown subset is rendered into DOM
  nodes, so a caption containing markup stays inert. A test asserts exactly that.

[↑ Back to Index](#index)


## Browsing: Library and Timeline

Both are views over the records already in memory. Neither reads a photo or calls a model;
the only I/O is reading thumbnails, and both are built so that **thumbnails are fetched only
for what is on screen**. Reading 6,635 of them from a network share up front is not an option.

### Library

A single flat grid of every photo, newest first (undated photos last), with a size slider
and a reverse-order toggle.

- **Virtualised.** The grid container is given the full height, and tiles are absolutely
  positioned inside it. Only the rows near the viewport exist as DOM nodes. Column count and
  tile size come from the container width and the slider; changing either re-lays out the
  grid and keeps the row at the top of the screen where it was.
- **Pinned thumbnails.** A tile pins its thumbnail while it exists and unpins it when it
  scrolls away, so the thumbnail cache stays bounded and eviction can never revoke an image
  that is visible. Each tile carries its own record id, because tiles outlive the list they
  were drawn from (see [FINDINGS.md](FINDINGS.md#17-things-outlive-the-list-that-created-them)).
- **The viewer** opens full-window from the clicked tile. It starts as the tile's rectangle,
  animates to the photo's real aspect ratio, and shows the stored thumbnail immediately; the
  original is decoded in the background and swapped into the same box, so nothing jumps.
  Arrow keys step through the photos, `I` toggles the details panel, `Esc` closes, and closing
  animates back into the tile (or fades, if that tile has scrolled out of view). Formats a
  browser cannot display, such as HEIC and TIFF, stay on the thumbnail and say so.
- **Select mode** allows click, shift-click range and select-all, then **Rotate** or **Remove**.
- **Rotation** is non-destructive; see [Rotating photos](#rotating-photos).

### The search field

The field in the header is the front door to search, and it reuses the Library as its results
view instead of building a second grid.

- **Suggestions are local and instant.** `sgSuggest()` works from the records, the entity index
  and the people, with no model call and no waiting. It offers *People* (with the face tile),
  *Dates* (`2021`, `june`, `june 2021` in any order, and occasions), *Places*, *Kinds of
  picture* and *In the picture* (objects, activities, keywords, animals, settings). The facts
  behind them are cached and rebuilt only when the index or the people change.
- **Tokens live inside the field.** Picking a suggestion adds a token to the search field and
  leaves the field focused with the list open, so "Mum" then "Dad" is two keystrokes and a pick
  each; results update behind it. `Backspace` on an empty field removes the last token and
  `+` or `,` finishes the current word. Words typed for the text search are tokens too, joined
  into one ranked query.
- **Several people from one phrase.** `mum + dad` (also `&`, `,`, `and`) is parsed by
  `sgPeopleParts()`: every part but the last must name exactly one person (exact name, then a
  unique prefix) and the last may still be partial, so `mum + da` already suggests `Mum + Dad`.
  The result is one suggestion that adds both person chips, and a finished all-people phrase
  is offered before the plain text search so Enter does the sensible thing.
- **A choice becomes a chip.** Each chip maps onto a filter `searchPhotos` already understood,
  and two new ones: `month` (any year) and `photo_sets`, a list of photo-id sets that must all
  contain the photo. A person chip uses the **set of that person's photos**, not the name, so
  it is exact even when two people share a name, and it works for unnamed groups. A second place,
  year or month replaces the first, because those only make sense one at a time; people, kinds
  and things combine (all people must appear; a photo may be any of the chosen kinds).
- **The words are a separate, ordinary search.** Enter on the first row sets the text and runs
  the usual hybrid search (BM25 plus embeddings, merged by rank fusion) inside the chip filters.
  This is the only part that can call the embedding model.
- **Results live in the Library.** Search switches the Library to a third view, `search`, whose
  list is the ranker's order (newest first when there are only chips). The viewer, Select,
  rotate and remove therefore work on results, and arrow keys step through them. The chat cap
  of 60 results does not apply here: `searchPhotos` takes a `max` for the Library.
- **Waiting for the index.** A search started from another tab opens the Library, waits for the
  one shared load of the index (`onLibraryShown()` returns the same promise to every caller),
  then loads face names, vectors and the keyword index if they are missing, as chat does.

### Rotating photos

Orientation is fixed once, at scan time: EXIF rotation is applied while decoding, so the
thumbnail and the model both see the picture the right way up. A rotation made later in the
Library is therefore a **correction on top of that**, and it is stored, not baked in.

- **Where it lives.** A `rotation` field (0, 90, 180 or 270, clockwise) on the photo's record,
  appended like any other change. Neither the original file nor the stored thumbnail is
  rewritten, which keeps the rule that nothing outside `.photoindex/` is modified. The cost is
  that other applications still show the file's own orientation.
- **Where it is drawn.** Tiles in the Library, Timeline and chat results, and the viewer, apply
  the angle with the CSS `rotate` property. That property composes with the `transform`
  already used for hover and selection scaling, where setting `transform` itself would have
  overridden them. A square, centre-cropped tile can simply be rotated: the centre square of a
  turned image is the turned centre square of the original.
- **The viewer** keeps an accumulating angle (90, 180, 270, 360 and so on), so each press
  animates the short way round. A quarter turn swaps the photo's width and height when its
  box is fitted to the window; the element is laid out with the dimensions swapped and the same
  centre, then turned. `R` turns right and `Shift+R` turns left, in the viewer and in Select
  mode, where the toolbar buttons turn every selected photo.
- **Relative, so undoable.** A turn adds to each photo's own current angle (modulo 360), so a
  mixed selection stays mixed and the opposite turn is an exact undo.
- **Serialised writes.** Every Library change goes through one queue. Rotating twice quickly
  would otherwise start both changes from the same old angle and lose one. Memory is updated
  only after the write succeeds, and the viewer turns back if saving fails.
- **Survives a rescan.** Like `hidden`, the angle is carried onto the rebuilt record.

### Removing photos

Removal is **index-only**. The original file is never read, moved or deleted, so the rule
that nothing outside `.photoindex/` is modified still holds.

- It appends the full record again with `hidden: true`. The full record is read back from
  disk first, so the model's raw output is not lost when the lightened in-memory copy would
  have dropped it. Memory is updated only after the write succeeds.
- It uses `hidden`, **not** `deleted`. The scan plan treats a deleted record as absent and
  would index the same file again on the next scan.
- Search, chat, the Timeline, statistics and the People tab all skip hidden records. The
  scanner keeps them matched but leaves them alone, and a rescan carries `hidden` forward.
- **Undo** appears for about nine seconds after any removal or restore. The **Removed** view
  lists hidden photos and restores them (which appends `hidden: false`).
- Compaction keeps hidden records, since restoring them depends on it.

### Timeline

Photos grouped by day, newest first, with place and occasion in each day's heading, a year
bar and a date picker. The picker lands on the nearest earlier day when the chosen date has
no photos. Dates whose source is uncertain are marked per photo. Day sections are
**windowed**: only days near the viewport are filled, and a day that scrolls away releases
its images and unpins them. Heights are estimated up front so the scrollbar is honest and
nothing shifts under the reader.

[↑ Back to Index](#index)


## Faces

Detection and embedding run **in the browser**, because the model server's embeddings
endpoint is text-only: there is no way to push this onto the server.
`.photoindex/faces/` holds `faces.jsonl` (geometry and provenance), `facevecs.bin`/`.json`
(unit-length vectors, reconciled in both directions on load like the photo vectors) and
`people.json` (groups and the names you gave them).

**Design decisions**

- **Alignment is mandatory.** The descriptor runs on the crop it is given, so `face.mesh` and
  `face.detection.rotation` are on. Without them the vector encodes head angle rather than
  identity (0.53 self-similarity versus 0.93; see
  [FINDINGS.md](FINDINGS.md#10-a-face-embedding-without-alignment-describes-the-pose-not-the-person)).
- **Grouping is greedy against centroids**, not all-pairs: 8,000 faces against a few hundred
  centroids takes seconds, where all-pairs would take minutes. A candidate must also be close
  to an actual member, not just the centroid, because centroid-only merging drifts until a
  group is a blur of several people.
- **The engine configuration is recorded on every face.** Vectors from different
  configurations are not comparable, so they are reported rather than silently mixed.
- **A name is authoritative.** Re-grouping never re-clusters a named person's faces away, and
  unnamed faces are matched against named people first, so new photos join by themselves.
  Merge and split exist because clustering gets some wrong.
- **Two passes.** Thumbnails first (fast, and tells us which photos contain people), then
  optionally the originals for just those photos, decoded large, because a face below 112 px
  is upscaled into the model. Re-measuring matches old faces to new by box overlap, so names
  survive.
- **The aligned 112×112 crop is stored** (about 5 KB a face). It is the output of work that
  cannot be cheaply redone, so keeping it turns a change of embedder into a minute's work
  instead of a day's. Display tiles, by contrast, store no crop: a 0..1 box plus the existing
  thumbnail renders the same picture for free.
- **Thumbnails need no photo folder.** They are keyed by record id, so a pass over thumbnails
  covers the whole index whichever folder is connected. Only the "originals" source needs a
  walk, and can therefore only reach the folder that is open.
- **Names work everywhere**, not only in the People tab: `ensureFaceNames()` reads the two
  small files (not the multi-megabyte vectors), so chat and the search box can filter by name
  without loading the grouping machinery.
- **One action deletes all of it**, leaving the rest of the index untouched.

**The privacy boundary**

Nothing is inferred. A group is "Group 1" until you type a name, and the app never decides
*who* anyone is. The descriptor model computes an age and gender guess as a side effect of
the embedding and cannot be asked not to, so both are dropped at the adapter boundary. A face
row is built field by field rather than spread, and a test asserts neither ever reaches
storage. Emotion, iris, antispoof and liveness are switched off outright.

[↑ Back to Index](#index)


## The model server

Any server that speaks the OpenAI API. Detection goes from most to least informative:

1. LM Studio's `/api/v0/models`: model type and load state.
2. Ollama's `/api/tags`: model families, where `clip` or `mllama` identifies a vision model as
   a fact rather than a guess.
3. Plain `/v1/models`: only ids exist, so types are guessed from the name. This is always
   overridable by hand in Settings.

Native endpoints resolve against the **root**, not the base URL, so a pasted `…/v1` does not
demote a recognised server to the generic path.

**Structured output is probed, not assumed.** A JSON schema is what stops a reasoning model
spending its whole budget thinking, so the connection test asks the server whether it can
enforce one. The app then degrades in steps: schema, then JSON-only, then prose. Which one is
in play is reported, because the weaker the contract, the more the validator has to repair.

[↑ Back to Index](#index)


## Safety properties

What the app guarantees, and how.

**Scope of writes**

- Writes are confined to `.photoindex/`. Nothing else is modified, moved or deleted, and
  removing a photo from the Library changes the index only.
- The model can fill in fields but never *identify* a record: `id`, `path`, `fingerprint`,
  `size`, `mtime`, `scanned_at`, `deleted` and `hidden` are reserved and stripped from model
  output.

**Protection against mass damage**

- **Mark missing** refuses to run when a folder returns no images at all, so an unmounted NAS
  cannot soft-delete a library.
- Five identical failures in a row stop a scan, rather than writing thousands of error
  records.
- Restoring a backup first copies the current state, so a mistaken restore is undoable.

**Consistency of what is on disk**

- Index writes are serialised. `appendLines` reads a size and then seeks to it, so concurrent
  appends would otherwise overwrite each other.
- A write that does not land at the expected length is refused before the ids describing it
  are recorded. `vectors.bin` is reconciled to its id list in both directions on load.
- An index that cannot be read is an **empty** index, never a stale one. Loading a location
  with no `records.jsonl` clears memory instead of leaving the previous location's records
  behind, where they would be planned against and then flushed into the new index.
- A stalled write cannot wedge the index: the serialising lock has a timeout, so one
  unresponsive NAS operation does not block every write that follows.

**What can be rebuilt**

- Thumbnails are the only derived part of the index and the only part excluded from backups.
  **Rebuild thumbnails** remakes them from the originals with no model calls, matching photos
  by content rather than by stored path.
- A failure keeps its `cause`, so callers can tell a deleted folder from an unreachable share.
  The two need opposite responses, and a `DOMException` loses its name when re-wrapped.

[↑ Back to Index](#index)


## Storage is assumed to be slow and unreliable

Not as an edge case, but as the normal case. The index lives on an SMB share where a single
round trip measured 24 seconds when the drives were asleep, and a directory listing 75.

- **Speed is measured, not guessed.** Opening `.photoindex/` and reading `config.json` are
  timed as they happen, so the probe costs nothing extra, and a listing is timed once on
  connect. The result is shown in Settings.
- **Every deadline is sized from that measurement** (`ioDeadline`), between a floor and a cap.
  The alternative was a guessed constant, raised from 30s to 120s and then 120s again, each
  time after it fired on storage that was merely slow rather than broken.
- **One wrapper for every index operation.** `indexOp(label, fn)` supplies the deadline, the
  progress reporting and the error naming. A failure always says both what was attempted and
  how far it got: `opening the index … [stuck at: Reading config.json…]`.
- **Writes are verified by length.** `appendLines` and `appendVectors` re-read the file and
  refuse to report success unless it grew by exactly what was written.

[↑ Back to Index](#index)


## Known gaps

- **Orphaned thumbnails are counted, not collected.** A thumbnail whose record is gone stays
  on disk. Deleting files is not a decision the rebuild makes on its own.
- **The fault-injection suite is a simulation.** `95-faultfs.js` reproduces latency, hangs,
  failing and short writes, and its assertions were verified by removing the fixes and
  watching them go red. It is still OPFS underneath: it models the failures observed on the
  real share rather than the share itself.
- **Chat and Timeline still open the older lightbox**, not the Library viewer, so they have
  no Remove button and no arrow-key stepping.
- **Videos and RAW files** are counted and skipped; they never appear in the Library. See
  [ROADMAP.md](ROADMAP.md).

[↑ Back to Index](#index)
