# ChangeLog

All notable changes to PhotoSearch, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/), and versions are `MAJOR.MINOR.PATCH`.

The project had no version numbers before this file existed, so the history below was
reconstructed from the git log and starts at **0.1.0**. While the major version is 0, the
index format and settings may still change; any change that alters how existing data is
interpreted is listed under *Changed* with a note on how it is migrated.

The current version is shown in the app's footer and is defined as `APP_VERSION` in
[src/js/00-core.js](src/js/00-core.js). Bump both it and this file together.

## Index

## Index
<!-- index:start -->
- [0.5.0 (2026-10-01)](#050-2026-10-01)
  - [Added](#added)
  - [Changed](#changed)
  - [Fixed](#fixed)
- [0.4.0 (2026-10-01)](#040-2026-10-01)
  - [Added](#added-1)
  - [Changed](#changed-1)
- [0.3.0 (2026-09-30)](#030-2026-09-30)
  - [Added](#added-2)
  - [Changed](#changed-2)
  - [Fixed](#fixed-1)
- [0.2.0 (2026-09-29)](#020-2026-09-29)
  - [Added](#added-3)
  - [Changed](#changed-3)
  - [Fixed](#fixed-2)
- [0.1.0 (2026-09-23)](#010-2026-09-23)
  - [Added](#added-4)
  - [Fixed (in the days that followed, before 0.2.0)](#fixed-in-the-days-that-followed-before-020)
<!-- index:end -->

## 0.5.0 (2026-10-01)

**Summary:** a Photos-style interface, a Library gallery with a zoom viewer, removing photos
from the library, and a full rewrite of the documentation.

### Added

- **Library tab:** every photo in one grid, newest first, with a size slider and a
  reverse-order toggle. The grid is virtualised, so only the rows near the viewport exist and
  a 6,600-photo library stays smooth.
- **Full-window viewer** that grows out of the clicked tile, shows the stored thumbnail
  instantly and swaps in the decoded original. Arrow keys step through photos, `I` toggles the
  details panel, `Esc` closes, and closing animates back into the tile.
- **Remove from library.** Select mode (click, shift-click range, select all) or the viewer's
  Remove button or Delete key. Index-only: original files are never touched. An Undo bar
  follows every removal, and a **Removed** view lists hidden photos so they can be restored.
- A `hidden` flag on records (distinct from `deleted`). Hidden photos are excluded from search,
  chat, the Timeline, statistics and People, and a rescan keeps them hidden.
- Documentation: an Index at the top of every document, a "Back to Index" link at the end of
  every section, and `tools/doc_index.py` to keep them in sync with the headings.
- This ChangeLog, and an `APP_VERSION` constant shown in the footer.
- Self-test assertions for the Library, the viewer and removal.

### Changed

- **Restyled the interface after the Photos app:** translucent blurred bars, a segmented tab
  control, pill buttons, iOS-style switches, round face tiles, an edge-to-edge Timeline with
  large sticky day headings, chat bubbles, and a rounded viewer sheet. Dark mode uses true
  black. Animations are disabled for users who prefer reduced motion. This is CSS only; no
  behaviour changed.
- The photo-details list is shared by the Library viewer and the older lightbox.
- Documentation rewritten for accuracy and clarity. Corrected statements that had gone stale:
  face grouping now exists, chat has nine tools, and the built file is about 530 KB.
- `CONTRIBUTING.md` now states the actual rule on faces (group, never identify) and that
  nothing outside `.photoindex/` may be modified.

### Fixed

- A merge left a stray `=======` line in the self-test source, which is a JavaScript syntax
  error. The whole page failed to start (no error banner is possible, since the error handler
  is not yet registered). Caught only because the new footer version was blank.
- Clearing the Library grid after the list changed could read past the end of the list. Tiles
  now carry their own photo id.

[↑ Back to Index](#index)

---

## 0.4.0 (2026-10-01)

**Summary:** better face recognition, and support for model servers other than LM Studio.

### Added

- **Any OpenAI-compatible server:** LM Studio, Ollama, llama.cpp, vLLM and LocalAI. Model
  detection tries LM Studio's native endpoint, then Ollama's `/api/tags`, then `/v1/models`.
- **Structured-output probing.** Connection testing reports whether the server supports a JSON
  schema, JSON-only, or neither, and the scan degrades accordingly.
- Per-server CORS advice in Test connection, and an Ollama quick start.
- **ArcFace** face recognition, with five-point landmark alignment to 112×112.
- Aligned face crops are stored (about 5 KB each), so changing the embedder later costs
  minutes instead of a day of re-reading originals.
- An option to measure faces from **full-size originals** rather than 384px thumbnails.

### Changed

- The face grouping threshold now follows the active embedder, and the slider's range expresses
  ArcFace's scale (about 0.42).
- A saved threshold from the previous scheme is migrated rather than applied to ArcFace, where
  it would have prevented almost anything from merging.

[↑ Back to Index](#index)

---

## 0.3.0 (2026-09-30)

**Summary:** browsing by day, and face grouping.

### Added

- **Timeline tab:** photos grouped by day, newest first, with place and occasion headings, a
  year bar and a date picker. Thumbnails are windowed so only visible days are loaded.
- **People tab:** faces are detected and grouped *by resemblance* in the browser. Groups stay
  anonymous until you name them; merge, split and a single "delete all face data" action.
- Names work in the search box and in chat, through a new `list_people` tool (nine tools now).
- A live smoke test for the face model (`tools/face-smoke.mjs`) and a face-model preflight.
- Progress for the folder walk, and face-scan progress shown on the tab it was started from.

### Changed

- Face scans read the stored **thumbnails** instead of 14 GB of originals: about 8 minutes
  instead of 9.7 hours on the reference NAS. Coverage extends to the whole index, not just the
  connected folder.
- A current plan is reused instead of being rebuilt on every press.

### Fixed

- Face grouping accuracy: embeddings were describing head pose rather than identity because
  landmark alignment had been switched off. Self-similarity went from 0.53 to 0.93.
- The face model path (a package that does not exist) and the confidence field (always zero).
- Escape sequences such as `“` rendering literally in the interface.
- CI now waits for DevTools instead of sleeping for a fixed time.

[↑ Back to Index](#index)

---

## 0.2.0 (2026-09-29)

**Summary:** reliability on slow network storage, safer backups, thumbnail rebuild, and CI.

### Added

- **Rebuild thumbnails** from the original photos, matched by content, with no model calls.
- **Storage speed measurement.** Every index deadline is sized from the measured round-trip
  time instead of a guessed constant, and failures name the step that stalled.
- Verification of every append by re-reading the resulting file length.
- A fault-injecting filesystem (`95-faultfs.js`) for tests: latency, hangs, failing and short
  writes.
- GitHub Actions CI that builds and runs the self-test headlessly.
- `OPERATIONS.md` (where files live, manual backup, slow-storage notes), `FINDINGS.md`, and a
  researched `ROADMAP.md`.
- Clear messages in place of dead buttons: why there is nothing to scan, and a visible
  progress card for the pre-scan safety copy.

### Changed

- Opening the index no longer touches `thumbs/`, a folder that took 75 seconds to list.
- A backup no longer writes to the index it is backing up.
- `config.json` is no longer rewritten on every open.
- Any action re-acquires folder access instead of dead-ending when permission was dropped.
- Existing indexes are protected, and the location of a new one is confirmed before use. The
  "move index" button was removed.

### Fixed

- Eight data-loss paths found in code review, and a second round of review findings.
- An index that could not be read left the previous location's records in memory, which were
  then written into the new index. An unreadable index is now empty.
- `vectors.bin` is reconciled to its id list in both directions on load.
- A stalled write could wedge every later write; the lock now has a timeout.
- An error with an empty message could render as a blank notice.
- Two incorrect claims in the documentation.

[↑ Back to Index](#index)

---

## 0.1.0 (2026-09-23)

**Summary:** first working version.

### Added

- Single-file app (`PhotoSearch.html`) that scans a photo folder with a local vision model and
  stores a plain-text index in `.photoindex/`.
- Fixed-schema extraction: observations, caption, objects, activities, scene, text in image.
- EXIF dates with a recorded source and confidence, camera and GPS, offline place names, and
  derived season, weekday and occasion.
- Search: BM25 plus embedding similarity merged by reciprocal rank fusion, exact phrases, and a
  relevance floor.
- Tool-calling chat agent over the index, with a retrieve-then-answer fallback.
- Resumable scans with a checkpoint, retries, move detection by content, and per-run backups.
- An in-browser self-test.

### Fixed (in the days that followed, before 0.2.0)

- Output truncation on text-heavy images, and backup feedback that was not visible.

[↑ Back to Index](#index)
