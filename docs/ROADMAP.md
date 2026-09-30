# Roadmap — closing the gap to Google Photos

Written 29 September 2026, after 6,635 photos were indexed and searchable.

What exists today is the *hard* half: every photo has a caption, a description, objects,
activities, transcribed text, a dated and confidence-scored timestamp, an offline place
name, an occasion, and a 768-dimension embedding. Search fuses BM25 and cosine similarity,
and chat drives eight tools over it.

What is missing is mostly **browsing** and **two whole media types**, not intelligence.
This document says what to add, in what order, and what each one actually costs.

---

## Findings that shape every option below

These were measured or verified, not assumed.

### 1. LM Studio cannot embed images. Verified.

```
$ curl localhost:1234/v1/embeddings -d '{"model":"text-embedding-nomic-embed-text-v1.5",
    "input":[{"type":"image_url","image_url":{"url":"data:image/png;base64,..."}}]}'
{"error":"'input' field must be a string or an array of strings"}
```

Text input works and returns 768 dimensions. So anything needing an *image* vector — faces,
visual similarity, true image-text search — must run **in the browser**. There is no way to
push it onto LM Studio, however convenient that would be.

### 2. The precedent for that already exists in this app

`exifr`, `libheif-js` and `utif` are fetched from jsDelivr at first use, and the GeoNames
city list is downloaded once and cached into `.photoindex/geo/cities.bin`, after which the
app is offline for ever. Every model below follows that same pattern: **fetch once, cache
in `.photoindex/`, never call out again.** No new architectural principle is required.

### 3. `nomic-embed-vision-v1.5` shares the embedding space the index already uses

This is the single luckiest fact available. The index is built with
`nomic-embed-text-v1.5` at 768 dimensions, and Nomic's vision encoder (92M parameters) is
deliberately aligned to *that exact space* — the text tower was frozen and the image tower
trained into it. Consequently:

- image vectors would be directly comparable to the text vectors already on disk
- a typed query keeps being embedded by LM Studio, for free, with the model already loaded
- `vectors.bin` stays 768-wide; no second vector store, no re-embedding of existing text

The alternative (CLIP, SigLIP, MobileCLIP) is smaller and faster but lives in its own
space, which means shipping *two* encoders and a second vector file. ONNX weights for the
Nomic vision model exist; Transformers.js support has historically been awkward, so plan on
`onnxruntime-web` directly.

### 4. Video and RAW are classified and then silently dropped

`classifyFile()` already labels them, and the plan counts them — `38 RAW counted, skipped`.
Nothing else happens. For a library with any phone video in it, a meaningful share of the
collection is simply invisible to search.

### 5. A second pass over the originals is cheap; a second pass through the model is not

The 68 hours were **entirely** model time at ~21.5 s/photo. Work that only decodes pixels
runs at disk speed: the thumbnail rebuild proves the pipeline, and face detection plus
embedding is on the order of 100 ms/photo on Apple silicon.

> **6,635 photos: ~20 minutes for faces, versus 68 hours for a rescan.**

Everything in Phase 1 below is deliberately chosen to need **no model calls**, so it never
costs another 68 hours.

---

## Phase 1 — People, and the browsing you already have the data for

### 1.1 People (face grouping) — the headline ask

**How it works.** Re-read each original (the thumbnail-rebuild path already does exactly
this), detect faces, embed each face as a 512-d vector, cluster the vectors, and let **you**
name the clusters. Store crops and vectors in `.photoindex/faces/`.

- **Detection + embedding:** `human` v3.3.6 (on cdnjs and jsDelivr, browser-native,
  TensorFlow.js) gives detection *and* face embeddings in one library. The alternative is
  SCRFD + ArcFace ONNX through `onnxruntime-web`, which is the stack every serious local
  tool uses and is more accurate, at the cost of wiring two models by hand. **Start with
  `human`** to get the whole flow working end to end, and swap the embedder later if
  accuracy disappoints — the clustering and UI do not care where a 512-d vector came from.
- **Clustering:** agglomerative, cosine distance, threshold ~0.6, no target cluster count.
  Runs on 6,635 photos in memory in seconds. Re-clusterable at any time without re-reading
  a single photo, because the vectors are on disk.
- **Naming:** clusters start as *Person 1, Person 2…*. You name the ones you care about.
  Merging and splitting clusters must both be possible — clustering will get some wrong.
- **Search:** `people:"Anna"` as a filter, and a People tab of face tiles.

**Where I need your agreement before building this.** A standing rule on this project is
that the app never identifies people or guesses anything about them. Face grouping does not
break that rule as I intend to build it, but it sits close enough that I want it stated
plainly rather than assumed:

- the app groups faces that **look alike**; it never decides *who* anyone is
- every name comes from you. Nothing is inferred, suggested, or looked up
- **age, gender, emotion and ethnicity inference will be explicitly disabled.** `human`
  ships all four. They will be switched off in code, with a comment saying why, and a test
  asserting the fields never appear in a record
- face vectors are biometric data. They are written only into `.photoindex/faces/`, never
  transmitted, and a single **Delete all face data** button removes them completely
- the existing `people.age_groups` field in the extraction schema is a separate thing —
  the vision model's rough impression of a scene. Worth revisiting on its own merits

If you would rather this stayed out of the app entirely, say so and I will drop it; the rest
of the roadmap stands without it.

**Cost:** ~20 minutes of compute for the existing library. Model download ~15 MB, cached.
**Risk:** medium. Clustering quality is the thing that will need iterating.

### 1.2 Video

Currently invisible. Minimum viable version needs no new model:

1. Decode a handful of frames with `<video>` + `canvas` (no library, no WASM).
2. Send 3–5 evenly spaced frames to the vision model **as one request** with the existing
   schema, plus duration and dimensions.
3. Store as a record with `kind: "video"`, a thumbnail from the middle frame, and the same
   captions, objects and text as a photo.

Costs one model call per video rather than per frame, so a few hundred videos is an hour or
two, not days. Audio transcription (Whisper is available in LM Studio) is a separate, later
question.

**Cost:** medium build, model time proportional to video count. **Risk:** low — codec
support is whatever Chrome already plays.

### 1.3 Timeline browsing — **BUILT, 30 September 2026**

A Timeline tab grouped by day, newest first, with place and occasion headings, a year bar,
and a date picker that lands on the nearest earlier day when the exact one has no photos.
Uncertain dates are marked per photo with their source in the tooltip.

Thumbnails are **windowed**: only days near the viewport are filled, and a day that scrolls
away releases its images and unpins them. Rendering all 6,635 up front would have been
6,635 reads from the share. Heights are reserved up front so the scrollbar is honest and
nothing shifts under the reader.

### 1.4 Map view

GPS is resolved to offline place names already. A clustered-pin map needs an offline tile
source or a plain coordinate scatter with place labels — an online tile server would break
the offline rule, so the honest first version is **place-name grouping**: "Staines (412)",
"Sicily (88)", drilling into a grid.

**Cost:** low for place grouping, medium for real tiles. **Risk:** low.

### 1.5 Near-duplicates, bursts and best-shot

A 64-bit perceptual hash (dHash) per photo costs nothing at scan time and about a second
across the library at query time. Gives: duplicate detection, burst grouping (near-identical
hash within seconds of each other), and a "review 8 near-identical shots" screen. Combined
with the existing `quality` field, the app can propose a best-of-burst — proposing only,
never deleting.

**Cost:** low. **Risk:** low. Add the hash to the scan now even if the UI comes later, so it
does not need another pass.

---

## Phase 2 — Better search

### 2.1 True image embeddings

Today's "semantic" search embeds a *text summary of what the model said*. If the caption
never mentions a red car, no amount of cosine similarity finds one. Real image vectors fix
the class of query where the caption simply missed something, and give visual
similarity ("more like this") for free.

Use `nomic-embed-vision-v1.5` via `onnxruntime-web` for the reasons in Finding 3: it lands
in the space the index already uses, and the query side stays on LM Studio. Store alongside
the existing vectors and fuse as a third ranker in the RRF that already exists.

**Cost:** one pass over originals (~1–2 hours, no model calls), plus a model download in the
90–370 MB range depending on quantisation — by far the largest download in this document,
and the main argument for MobileCLIP instead if that proves unacceptable.
**Risk:** medium-high. This is the one item where I would want to prove the download and
runtime on your machine before committing to it.

### 2.2 Query understanding

"photos of Anna in Sicily last summer" should decompose into a person filter, a place filter
and a date range, rather than being embedded whole. The chat agent already has the tools;
this is about doing it for the plain search box too.

**Cost:** low-medium. **Risk:** low.

### 2.3 Typo tolerance and synonyms

BM25 is exact. "pizzza" finds nothing, and "bike" does not find "bicycle". Trigram fallback
for the former; the embeddings largely cover the latter already.

**Cost:** low. **Risk:** low.

---

## Phase 3 — Nice to have

| item | note |
|---|---|
| **Albums and favourites** | User-curated collections in `.photoindex/`. Simple, and expected. |
| **On this day** | Trivial once the timeline exists. |
| **Pets as first-class** | Google Photos groups pets. The same clustering machinery, applied to the `animals` field. |
| **RAW** | Lower value than it looks: most RAW files sit next to a JPEG that is already indexed. Better handled by pairing siblings than by decoding RAW in a browser. |
| **Live/Motion photos** | Recognise the paired video and treat it as one item. |
| **Audio transcription for video** | Whisper via LM Studio. Big payoff for home video, own project. |

## Explicitly out of scope

Sharing, cloud sync, editing, auto-enhance, and anything that uploads a photo anywhere.
The premise is one HTML file that works offline against your own disk.

---

## Recommended order

1. ~~**Timeline (1.3)**~~ — done, 30 September 2026.
2. **Perceptual hash into the scan (1.5)** — cheap, and avoids a future re-pass.
3. **People (1.1)** — the headline feature, ~20 minutes of compute, pending your agreement
   on the privacy design above.
4. **Video (1.2)** — closes the one gap where content is entirely invisible.
5. **Place grouping (1.4)**, then near-duplicate UI (1.5).
6. **Image embeddings (2.1)** — last of the substantial items, because it is the largest
   download and the least certain.

Ordered this way, the first three cost roughly one day of compute between them and **no
model time at all**. Nothing here requires re-scanning what you already have.

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
- [Facet — a comparable local-first tool](https://github.com/ncoevoet/facet)
