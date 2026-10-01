# Roadmap

Closing the gap to a mainstream photo manager, without giving up the premise: one HTML file
that works offline against your own disk.

Written on 29 September 2026, after 6,635 photos were indexed and searchable, and updated on
1 October 2026 to record what has since been built.

## Index

## Index
<!-- index:start -->
- [Where things stand](#where-things-stand)
- [Findings that shape every option](#findings-that-shape-every-option)
  - [1. LM Studio cannot embed images](#1-lm-studio-cannot-embed-images)
  - [2. The precedent for that already exists](#2-the-precedent-for-that-already-exists)
  - [3. nomic-embed-vision-v1.5 shares the embedding space the index already uses](#3-nomic-embed-vision-v15-shares-the-embedding-space-the-index-already-uses)
  - [4. Video and RAW are classified and then silently dropped](#4-video-and-raw-are-classified-and-then-silently-dropped)
  - [5. A second pass over the originals is cheap; a second pass through the model is not](#5-a-second-pass-over-the-originals-is-cheap-a-second-pass-through-the-model-is-not)
- [Phase 1: People, and the browsing you already have the data for](#phase-1-people-and-the-browsing-you-already-have-the-data-for)
  - [1.1 People (face grouping): built](#11-people-face-grouping-built)
  - [1.2 Video: not started](#12-video-not-started)
  - [1.3 Timeline browsing: built](#13-timeline-browsing-built)
  - [1.4 Library and remove: built](#14-library-and-remove-built)
  - [1.5 Map view: not started](#15-map-view-not-started)
  - [1.6 Near-duplicates, bursts and best shot: not started](#16-near-duplicates-bursts-and-best-shot-not-started)
- [Phase 2: Better search](#phase-2-better-search)
  - [2.1 True image embeddings](#21-true-image-embeddings)
  - [2.2 Query understanding: partly built](#22-query-understanding-partly-built)
  - [2.3 Typo tolerance and synonyms](#23-typo-tolerance-and-synonyms)
  - [2.4 A retrieval test set](#24-a-retrieval-test-set)
- [Phase 3: Nice to have](#phase-3-nice-to-have)
- [Explicitly out of scope](#explicitly-out-of-scope)
- [Recommended order](#recommended-order)
- [Sources](#sources)
<!-- index:end -->

## Where things stand

What exists is the *hard* half. Every photo has a caption, a description, objects, activities,
transcribed text, a dated and confidence-scored timestamp, an offline place name, an occasion
and a 768-dimension embedding. Search fuses BM25 and cosine similarity, and chat drives nine
tools over it.

The gap was mostly **browsing** and **two whole media types**, not intelligence. Status:

| item | status |
|---|---|
| Timeline (browse by day) | **built**, 30 September 2026 |
| People (face grouping, named only by you) | **built**, 30 September 2026, ArcFace on 1 October |
| Library (all photos in one grid, zoom viewer) | **built**, 1 October 2026 |
| Remove from library (hide, undo, restore) | **built**, 1 October 2026 |
| Rotate photos from the Library (view-only, undoable) | **built**, 1 October 2026 |
| Any OpenAI-compatible server, not only LM Studio | **built**, 1 October 2026 |
| Video | not started |
| Perceptual hash, near-duplicates and bursts | not started |
| Place grouping (map view) | not started |
| True image embeddings | not started |
| Search field with suggestions and filter chips | **built**, 1 October 2026 |
| Typo tolerance, free-text query parsing | not started |

This document says what to add, in what order, and what each item actually costs.

[↑ Back to Index](#index)

---

## Findings that shape every option

These were measured or verified, not assumed.

### 1. LM Studio cannot embed images

```
$ curl localhost:1234/v1/embeddings -d '{"model":"text-embedding-nomic-embed-text-v1.5",
    "input":[{"type":"image_url","image_url":{"url":"data:image/png;base64,..."}}]}'
{"error":"'input' field must be a string or an array of strings"}
```

Text input works and returns 768 dimensions. So anything needing an *image* vector (faces,
visual similarity, true image-text search) must run **in the browser**. There is no way to push
it onto the server, however convenient that would be.

### 2. The precedent for that already exists

`exifr`, `libheif-js` and `utif` are fetched from jsDelivr at first use, and the GeoNames city
list is downloaded once and cached into `.photoindex/geo/cities.bin`, after which the app is
offline for ever. Every model below follows that pattern: **fetch once, cache in `.photoindex/`,
never call out again.** No new architectural principle is required.

### 3. `nomic-embed-vision-v1.5` shares the embedding space the index already uses

This is the luckiest fact available. The index is built with `nomic-embed-text-v1.5` at 768
dimensions, and Nomic's vision encoder (92M parameters) is deliberately aligned to *that exact
space*: the text tower was frozen and the image tower trained into it. Consequently:

- image vectors would be directly comparable to the text vectors already on disk;
- a typed query keeps being embedded by the server, for free, with the model already loaded;
- `vectors.bin` stays 768-wide, with no second vector store and no re-embedding of existing text.

The alternative (CLIP, SigLIP, MobileCLIP) is smaller and faster but lives in its own space,
which means shipping *two* encoders and a second vector file. ONNX weights for the Nomic vision
model exist; Transformers.js support has historically been awkward, so plan on
`onnxruntime-web` directly.

### 4. Video and RAW are classified and then silently dropped

`classifyFile()` already labels them, and the plan counts them ("38 RAW counted, skipped").
Nothing else happens. For a library with any phone video in it, a meaningful share of the
collection is simply invisible to search and to the Library.

### 5. A second pass over the originals is cheap; a second pass through the model is not

The 68 hours were **entirely** model time at about 21.5 s per photo. Work that only decodes
pixels runs at disk speed: the thumbnail rebuild proves the pipeline, and face detection plus
embedding is on the order of 100 ms per photo on Apple silicon.

> **6,635 photos: about 20 minutes for faces, versus 68 hours for a rescan.**

(In practice the I/O, not the computation, set the cost; see
[FINDINGS.md](FINDINGS.md#11-cost-the-io-not-the-computation).) Everything in Phase 1 was
chosen to need **no model calls**, so it never costs another 68 hours.

[↑ Back to Index](#index)

---

## Phase 1: People, and the browsing you already have the data for

### 1.1 People (face grouping): built

Each original or thumbnail is read, faces are detected, each face is embedded, the vectors are
clustered, and **you** name the clusters. Crops and vectors live in `.photoindex/faces/`.

- **Detection and embedding** run in the browser. Detection and landmarks come from `human`
  v3.3.6. Its built-in embedder was replaced by **ArcFace** on aligned 112×112 crops, once
  measurement showed the first embedder was describing pose rather than identity.
- **Clustering** is greedy against centroids with a member check, cosine distance, and no target
  cluster count. It can be re-run at any time without re-reading a photo, because the vectors
  are on disk.
- **Naming:** clusters start as "Group 1", "Group 2" and so on. Names are authoritative, merging
  and splitting both exist, and `people:"Anna"` filters search and chat.

**The standing rule on identity.** The app never identifies people or guesses anything about
them. Face grouping respects that as built:

- it groups faces that **look alike** and never decides *who* anyone is;
- every name comes from the user, and nothing is inferred, suggested or looked up;
- **age, gender, emotion and ethnicity inference is disabled.** The embedding model computes
  some of them as a side effect, so they are dropped at the adapter boundary, and a test asserts
  they never reach storage;
- face vectors are biometric data. They are written only into `.photoindex/faces/`, never
  transmitted, and one **Delete all face data** button removes them completely.

The `people.age_groups` field in the extraction schema is a separate thing: the vision model's
rough impression of a scene, worth revisiting on its own merits.

### 1.2 Video: not started

Currently invisible. A minimum viable version needs no new model:

1. Decode a handful of frames with `<video>` and `canvas` (no library, no WASM).
2. Send 3–5 evenly spaced frames to the vision model **as one request** with the existing
   schema, plus duration and dimensions.
3. Store a record with `kind: "video"`, a thumbnail from the middle frame, and the same
   captions, objects and text as a photo. Also use the file's creation date and any GPS metadata.

This costs one model call per video rather than per frame, so a few hundred videos is an hour or
two, not days. Audio transcription (Whisper is available in LM Studio) is a separate, later
question.

**Cost:** medium build, with model time proportional to video count. **Risk:** low, since codec
support is whatever Chrome already plays. The Library and viewer would need a video tile.

### 1.3 Timeline browsing: built

A Timeline tab grouped by day, newest first, with place and occasion headings, a year bar and a
date picker that lands on the nearest earlier day when the exact one has no photos. Uncertain
dates are marked per photo with their source in the tooltip. Thumbnails are **windowed**: only
days near the viewport are filled, and a day that scrolls away releases its images and unpins
them.

### 1.4 Library and remove: built

The Library is the flat counterpart to the Timeline: every photo in one virtualised grid with a
size slider, and a full-window viewer that grows out of the clicked tile. Photos can be removed
from the library (select several, or remove from the viewer), with an undo and a Removed list.
Removal is index-only and never touches the files. See
[ARCHITECTURE.md](ARCHITECTURE.md#browsing-library-and-timeline).

### 1.5 Map view: not started

GPS is resolved to offline place names already. A clustered-pin map needs an offline tile source
or a plain coordinate scatter with place labels. An online tile server would break the offline
rule, so the honest first version is **place-name grouping**: "Staines (412)", "Sicily (88)",
drilling into a grid.

**Cost:** low for place grouping, medium for real tiles. **Risk:** low.

### 1.6 Near-duplicates, bursts and best shot: not started

A 64-bit perceptual hash (dHash) per photo costs nothing at scan time and about a second across
the library at query time. It gives duplicate detection, burst grouping (near-identical hash
within seconds of each other) and a "review 8 near-identical shots" screen. Combined with the
existing `quality` field, the app can propose a best-of-burst. It proposes only, and the
Library's Remove (which hides, never deletes) is the natural action to attach to it.

**Cost:** low. **Risk:** low. **Add the hash to the scan now**, even if the UI comes later, so it
does not need another pass.

[↑ Back to Index](#index)

---

## Phase 2: Better search

### 2.1 True image embeddings

Today's "semantic" search embeds a *text summary of what the model said*. If the caption never
mentions a red car, no amount of cosine similarity finds one. Real image vectors fix the class
of query where the caption simply missed something, and give visual similarity ("more like
this") for free.

Use `nomic-embed-vision-v1.5` via `onnxruntime-web`, for the reasons in finding 3: it lands in
the space the index already uses, and the query side stays on the model server. Store the
vectors alongside the existing ones and fuse them as a third ranker in the RRF that already
exists.

**Cost:** one pass over originals (about 1–2 hours, no model calls), plus a model download in the
90–370 MB range depending on quantisation, by far the largest download in this document and the
main argument for MobileCLIP instead if that proves unacceptable. **Risk:** medium-high. This is
the one item to prove, download and runtime, on the user's machine before committing.

### 2.2 Query understanding: partly built

The header search field now covers the structured half: pick a person, a place, a year or a kind
of picture and the filters combine. What is still missing is *parsing* a typed sentence into
those filters.

"Photos of Anna in Sicily last summer" should decompose into a person filter, a place filter
and a date range, rather than being embedded whole. The chat agent already has the tools; this
is about doing the same for the plain search box too, so that `people:`, `year:`, `place:` and
`has:text` work next to free text.

**Cost:** low to medium. **Risk:** low.

### 2.3 Typo tolerance and synonyms

BM25 is exact. "pizzza" finds nothing, and "bike" does not find "bicycle". A trigram fallback
covers the former; the embeddings largely cover the latter already.

**Cost:** low. **Risk:** low.

### 2.4 A retrieval test set

Keep 30–50 queries with known-good photo ids and report recall@k in the self-test. Without one,
there is no way to tell whether a change to the embedder, the fusion weights or the prompt made
search better or worse.

**Cost:** low. **Risk:** low.

[↑ Back to Index](#index)

---

## Phase 3: Nice to have

| item | note |
|---|---|
| **Albums and favourites** | User-curated collections in `.photoindex/`. Simple, and expected. The Library's Select mode is the natural way to build them. |
| **Saved searches** | A query kept as a live "smart album". |
| **On this day** | Trivial now that the Timeline exists. |
| **Export** | Copy a selection or search result to a folder of your choice, or a contact-sheet HTML. Exporting to your own disk is not sharing. |
| **Index integrity check** | Report orphaned vectors and thumbnails and records whose file is gone; repair only on confirmation. |
| **Re-extract by version** | Offer to re-run extraction only for records made with an older prompt, to avoid a full rescan when the prompt improves. |
| **One viewer everywhere** | Open the Library viewer from Chat and Timeline results too, so they gain arrow-key stepping, Remove and Rotate. (Their tiles already show the saved rotation.) |
| **Write rotation to the file** | An opt-in "apply to the file" for users who want other apps to agree. It would be the first feature that modifies originals, so it needs its own safeguards. |
| **Pets as first-class** | Google Photos groups pets. The same clustering machinery applied to the `animals` field. |
| **RAW** | Lower value than it looks: most RAW files sit next to a JPEG that is already indexed. Better handled by pairing siblings than by decoding RAW in a browser. |
| **Live/Motion photos** | Recognise the paired video and treat it as one item. |
| **Audio transcription for video** | Whisper via LM Studio. Big payoff for home video, but its own project. |

[↑ Back to Index](#index)

---

## Explicitly out of scope

Sharing, cloud sync, editing, auto-enhance, and anything that uploads a photo anywhere. The
premise is one HTML file that works offline against your own disk. For the same reason, nothing
outside `.photoindex/` is ever modified: removing a photo hides it in the index, and never
deletes the file.

[↑ Back to Index](#index)

---

## Recommended order

1. ~~**Timeline (1.3)**~~ done, 30 September 2026.
2. ~~**People (1.1)**~~ done, 30 September 2026.
3. ~~**Library and remove (1.4)**~~ done, 1 October 2026.
4. **Perceptual hash into the scan (1.6).** Cheap, and it avoids a future re-pass. It is now the
   most urgent item, because every scan done without it is a scan that will need repeating.
5. **Query understanding and typo tolerance (2.2, 2.3).** Low cost, and they improve the box
   people use most.
6. **Video (1.2).** Closes the one gap where content is entirely invisible.
7. **Place grouping (1.5)**, then the near-duplicate review screen (1.6).
8. **Image embeddings (2.1).** The last of the substantial items, because it is the largest
   download and the least certain.

Ordered this way, the early items cost roughly a day of compute between them and **no model
time at all**. Nothing here requires rescanning what you already have.

[↑ Back to Index](#index)

---

## Sources

- [LM Studio embeddings endpoint](https://lmstudio.ai/docs/developer/openai-compat/embeddings)
- [nomic-embed-vision-v1.5](https://huggingface.co/nomic-ai/nomic-embed-vision-v1.5) ·
  [shared latent space](https://www.nomic.ai/news/nomic-embed-vision) ·
  [paper](https://arxiv.org/pdf/2406.18587)
- [human (browser face detection + embedding)](https://github.com/vladmandic/human) ·
  [on cdnjs](https://cdnjs.com/libraries/human)
- [InsightFace: SCRFD + ArcFace](https://github.com/deepinsight/insightface)
- [Transformers.js](https://huggingface.co/docs/transformers.js/index) ·
  [SigLIP ONNX](https://huggingface.co/Xenova/siglip-base-patch16-224) ·
  [MobileCLIP](https://huggingface.co/Xenova/mobileclip_blt)
- [Facet, a comparable local-first tool](https://github.com/ncoevoet/facet)

[↑ Back to Index](#index)
