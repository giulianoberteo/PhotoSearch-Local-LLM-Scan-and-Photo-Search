# ChangeLog

All notable changes to PhotoSearch, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/), and versions are `MAJOR.MINOR.PATCH`. While the major version is 0, every change bumps the
**patch** number (0.6.1, 0.6.2, …); the minor number only moves when the maintainer decides a
milestone has been reached.

The project had no version numbers before this file existed, so the history below was
reconstructed from the git log and starts at **0.1.0**. While the major version is 0, the
index format and settings may still change; any change that alters how existing data is
interpreted is listed under *Changed* with a note on how it is migrated.

The current version is shown in the app's footer and is defined as `APP_VERSION` in
[src/js/00-core.js](src/js/00-core.js). Bump both it and this file together.

## Index
<!-- index:start -->
- [0.6.17 (2026-10-02)](#0617-2026-10-02)
  - [Fixed](#fixed)
- [0.6.16 (2026-10-02)](#0616-2026-10-02)
  - [Added](#added)
- [0.6.15 (2026-10-02)](#0615-2026-10-02)
  - [Fixed](#fixed-1)
- [0.6.14 (2026-10-02)](#0614-2026-10-02)
  - [Changed](#changed)
- [0.6.13 (2026-10-02)](#0613-2026-10-02)
  - [Changed](#changed-1)
- [0.6.12 (2026-10-02)](#0612-2026-10-02)
  - [Added](#added-1)
- [0.6.11 (2026-10-02)](#0611-2026-10-02)
  - [Added](#added-2)
- [0.6.10 (2026-10-02)](#0610-2026-10-02)
  - [Changed](#changed-2)
- [0.6.9 (2026-10-02)](#069-2026-10-02)
  - [Changed](#changed-3)
- [0.6.8 (2026-10-02)](#068-2026-10-02)
  - [Added](#added-3)
- [0.6.7 (2026-10-02)](#067-2026-10-02)
  - [Fixed](#fixed-2)
- [0.6.6 (2026-10-02)](#066-2026-10-02)
  - [Fixed](#fixed-3)
- [0.6.5 (2026-10-02)](#065-2026-10-02)
  - [Added](#added-4)
- [0.6.4 (2026-10-02)](#064-2026-10-02)
  - [Added](#added-5)
- [0.6.3 (2026-10-01)](#063-2026-10-01)
  - [Added](#added-6)
  - [Changed](#changed-4)
- [0.6.2 (2026-10-01)](#062-2026-10-01)
  - [Added](#added-7)
  - [Changed](#changed-5)
- [0.6.1 (2026-10-01)](#061-2026-10-01)
  - [Added](#added-8)
  - [Changed](#changed-6)
- [0.6.0 (2026-10-01)](#060-2026-10-01)
  - [Added](#added-9)
  - [Changed](#changed-7)
- [0.5.4 (2026-10-01)](#054-2026-10-01)
  - [Changed](#changed-8)
- [0.5.3 (2026-10-01)](#053-2026-10-01)
  - [Fixed](#fixed-4)
- [0.5.2 (2026-10-01)](#052-2026-10-01)
  - [Added](#added-10)
  - [Changed](#changed-9)
- [0.5.1 (2026-10-01)](#051-2026-10-01)
  - [Changed](#changed-10)
- [0.5.0 (2026-10-01)](#050-2026-10-01)
  - [Added](#added-11)
  - [Changed](#changed-11)
  - [Fixed](#fixed-5)
- [0.4.0 (2026-10-01)](#040-2026-10-01)
  - [Added](#added-12)
  - [Changed](#changed-12)
- [0.3.0 (2026-09-30)](#030-2026-09-30)
  - [Added](#added-13)
  - [Changed](#changed-13)
  - [Fixed](#fixed-6)
- [0.2.0 (2026-09-29)](#020-2026-09-29)
  - [Added](#added-14)
  - [Changed](#changed-14)
  - [Fixed](#fixed-7)
- [0.1.0 (2026-09-23)](#010-2026-09-23)
  - [Added](#added-15)
  - [Fixed (in the days that followed, before 0.2.0)](#fixed-in-the-days-that-followed-before-020)
<!-- index:end -->

## 0.6.17 (2026-10-02)

**Summary:** the Plan names the real index location.

### Fixed

- The Plan's "Opening the index" step showed `<photo folder>/.photoindex` even when the index
  was set to a folder you chose, because it printed the photo folder whenever the chosen index
  folder had not been reconnected after a refresh. It now names the folder actually opened,
  says whether that is "the index folder you chose" or "beside the photos", and when the
  chosen index folder is not connected it stops with that explanation instead of guessing.
- The Plan's intro line also reports how many folders are left out.

[↑ Back to Index](#index)


## 0.6.16 (2026-10-02)

**Summary:** Select all and Deselect all for the folder list.

### Added

- **Select all** (formerly "Include everything") ticks every folder. **Deselect all** leaves
  every folder out, so you can tick back in only the few you want. Photos sitting directly in
  the library root belong to no folder and are still scanned.

[↑ Back to Index](#index)


## 0.6.15 (2026-10-02)

**Summary:** the left-out folders show again after a refresh.

### Fixed

- After a page refresh, Settings said "Every folder is scanned" although folders were still
  left out. The list was saved and applied correctly (scans and the Plan still skipped those
  folders); only the summary line was drawn before the saved list had been read. It now shows
  the real list on load.

[↑ Back to Index](#index)


## 0.6.14 (2026-10-02)

**Summary:** the folder list in Settings uses two columns.

### Changed

- **Choose folders to leave out** lists the top-level folders in two columns, so a long library
  needs half the scrolling. Folders opened with ▸ expand within their own column, and the list
  drops to one column on a narrow window.

[↑ Back to Index](#index)


## 0.6.13 (2026-10-02)

**Summary:** merged the original author's latest commit.

### Changed

- Brought in `efebd84`: the author's milestone plan for adopting the Photos-style UI (added to
  `docs/ROADMAP.md`, after our own roadmap sections) and their improved `tools/doc_index.py`,
  which adopts a hand-written "## Index" instead of duplicating it and skips governed files
  that do not exist.

[↑ Back to Index](#index)


## 0.6.12 (2026-10-02)

**Summary:** leave chosen folders out of scans.

### Added

- **Settings > Choose folders to leave out…** shows the library as a tree you can open
  (▸) and untick. An unticked folder, and everything inside it, is skipped by every scan and
  by the Plan. Unticking a folder whose parent is already left out is not offered; ticking a
  parent again brings back everything under it. "Include everything" clears the list.
- Photos already in the index from a folder you later leave out are not touched: they stay
  searchable, and are not reported missing or rescanned.
- The Plan reports "N folders left out by you". The list is a setting
  (`scanExclude`), relative to the library root, so it still applies when you scan a subfolder.

[↑ Back to Index](#index)


## 0.6.11 (2026-10-02)

**Summary:** refreshing the page no longer loses what you were doing.

### Added

- The **chat conversation** (last 40 turns, with its photo grids) comes back after a refresh,
  and the assistant keeps the earlier turns as context.
- The Library's **search chips, sort order, Removed view and open photo** come back once the
  index can be read. The selection is not kept.
- Kept in this browser's local storage, not in the index. The folder itself still has to be
  reconnected after a refresh (Chrome withdraws that permission); the view returns as soon as
  it is.

[↑ Back to Index](#index)


## 0.6.10 (2026-10-02)

**Summary:** the Plan explains what it is doing.

### Changed

- Choosing a folder used to show only "Building plan". It now says what is being checked and
  against which index, that it only reads, and then runs through named steps: opening the
  index, loading what is already in it, listing the photos in the folder (with a live count),
  and matching them to the index, each ending with a plain result such as "120 new, 4,300
  already known".
- The Scan tab's Plan card has a one-paragraph explanation, a legend for new / changed / stale
  / failed / missing / up to date, and a tooltip on each number.

[↑ Back to Index](#index)


## 0.6.9 (2026-10-02)

**Summary:** brought in the original repository's newer `main`.

### Changed

- Merged the original author's changes: durable people corrections, face vectors appended
  instead of rewritten, the **Search tab** (people, place and date filters with pagination),
  backup improvements and the consumer self-test. Both searches now exist: the Search tab and
  the header Search field.
- The self-test now restores the saved settings exactly as they were, which replaces the
  0.6.6 fix for the same problem; the load-time clean-up of stray mock models stays.
- Where the two sides edited the same documentation, the sections from both are kept. Expect
  some overlap in `docs/` until it is tidied.

[↑ Back to Index](#index)


## 0.6.8 (2026-10-02)

**Summary:** zoom in the photo viewer.

### Added

- **Zoom slider** at the bottom of the viewer, with − and + buttons and a readout (click it to
  return to **Fit**). Zoom goes up to 800%.
- **Scroll wheel and trackpad pinch** zoom into whatever the pointer is over. **Drag** pans a
  zoomed photo, **double-click** toggles between Fit and 250%, and the keys `+`, `-` and `0`
  zoom in, out and back to Fit. Stepping to another photo returns to Fit.

[↑ Back to Index](#index)


## 0.6.7 (2026-10-02)

**Summary:** RAW, HEIC and TIFF photos open at full size.

### Fixed

- Opening a NEF (or any RAW, HEIC or TIFF) showed only the small stored thumbnail, because the
  viewer could display JPEG-type files only. It now decodes the original again at display size
  (up to 6000 px) in the Library viewer and in the Chat lightbox.

[↑ Back to Index](#index)


## 0.6.6 (2026-10-02)

**Summary:** the self-test no longer leaves its fake models in your settings.

### Fixed

- Running the self-test could save `mock-embed` and `mock-vlm` as your selected models, so a
  later scan stopped with "The selected embedding model 'mock-embed' is not in LM Studio".
  The test now writes your real settings back when it ends, and any mock model left in saved
  settings by an earlier run is ignored on load.

[↑ Back to Index](#index)


## 0.6.5 (2026-10-02)

**Summary:** RAW files (NEF and other cameras) are now scanned.

### Added

- **RAW support through the embedded preview.** NEF, NRW, CR2, CR3, ARW, DNG, ORF, RW2, RAF, PEF
  and the rest of the RAW family are indexed by reading the full-size JPEG the camera stores
  inside the file. The sensor data is not decoded, so the Library shows the camera's own
  rendering, not a RAW development. The camera's orientation is applied. EXIF date, camera
  and GPS come from the RAW file as for any photo. Only NEF has been tried by construction in
  the self-test; the other brands use the same TIFF layout (or a byte scan) and are best effort.
- A RAW that sits beside a same-named JPEG is not scanned twice: the JPEG is used and the plan
  reports "N RAW beside a JPEG".
- Self-test assertions for the preview, the orientation and a RAW with no preview.

[↑ Back to Index](#index)


## 0.6.4 (2026-10-02)

**Summary:** Favourites.

### Added

- **Favourites tab** (and `PhotoSearch.html#favourites`): your hearted photos in the Library's
  grid, with the same viewer, Select, rotate and remove.
- **Heart a photo** from a tile (the ♡ appears on hover and stays once set), from the viewer
  (♡ button or `F`), or in Select mode with the **Favourite** button, which hearts the whole
  selection or removes the hearts if all are already hearted. An Undo follows.
- **Favourites in search:** a suggestion and a chip that combines with the rest.
- Stored as `favourite` on the photo's record like rotation: it survives a rescan, the model
  cannot set it, and the file is never touched.
- Self-test assertions for favourites.

[↑ Back to Index](#index)

---

## 0.6.3 (2026-10-01)

**Summary:** the self-test explains itself, errors say what to do, and search accepts several
people at once ("mum + dad").

### Added

- **Self-test report.** A verdict ("All 562 checks passed"), failures first with what each got
  and wanted, passed checks folded away, live progress while it runs, **Copy report** and
  **Run again**. If the run stops early it says what happened, the last check that completed,
  and what to do.
- **Up-front check** that the self-test can run. A page opened from disk is not given Chrome's
  private file area, which used to surface as a bare "FAIL threw: SecurityError: It was
  determined that certain files are unsafe for access…" (or a silent hang). It now says why and
  gives the two fixes (start Chrome with `--allow-file-access-from-files`, or serve the file).
- **Plain-language error hints** (`humanError`) for security, permission, not-found, full-disk,
  locked-file, unreachable-server and timeout errors, added after the browser's own text and used
  in toasts and Settings messages.
- **Keywords are tokens inside the search field.** Pick *Mum*, it becomes a token in the box and
  the list stays open for the next; results narrow as you go. `Backspace` on an empty field
  removes the last token and `+` or `,` finishes a word. (They were chips in the Library toolbar.)
- **Search several people at once.** Typing `mum + dad` (also `&`, `,` or `and`) offers one
  suggestion that adds both people as chips, matching photos that contain all of them. It works
  as you type: `mum + da` suggests `Mum + Dad`. Pressing Enter on a phrase whose every part is a
  person does the same. Names match exactly first, then by unique prefix.
- Self-test assertions for the hints, the report parsing and the multi-person search.

### Changed

- `TESTING.md` and `SETUP.md` explain the `SecurityError` and how to run the self-test from your
  own Chrome.

[↑ Back to Index](#index)

---

## 0.6.2 (2026-10-01)

**Summary:** a Photos-style search field in the toolbar.

### Added

- **Search field** in the header (press `/` or `Ctrl/⌘+K`). Click it to see your people; type to
  get grouped suggestions: **People** (with their face, including unnamed groups and "Photos
  with faces"), **Dates** (`2021`, `june`, `june 2021`, occasions), **Places**, **Kinds of
  picture** and **In the picture**.
- **Filter chips.** A chosen suggestion becomes a removable chip; chips combine (for example
  Anna + Sicily + 2022). Enter on the first row searches the typed words by keyword and meaning
  inside those filters.
- **Results in the Library.** Search opens the Library on a results view, so the viewer, arrow
  stepping, Select, rotate and remove all work on results. **Clear search** returns to the whole
  library.
- Two new search filters, `month` (any year) and `photo_sets` (photos that must belong to every
  given set), and a `max` option that lifts the 60-result chat cap for the Library.
- Self-test assertions for suggestions, chips and result ordering.

### Changed

- The Library now shares one in-flight load, so several callers (a tab click, a search) wait for
  the same index open instead of the second returning early.
- The header's "Mock LM Studio" label collapses to the switch on windows narrower than 1250px to
  make room for the search field.

[↑ Back to Index](#index)

---

## 0.6.1 (2026-10-01)

**Summary:** every tab now has its own link.

### Added

- **Tab links.** `PhotoSearch.html#library`, `#chat`, `#timeline`, `#people`, `#scan` and
  `#settings` open that tab directly. Choosing a tab updates the address, so views can be
  bookmarked or shared, and Back and Forward step through the tabs visited. Names are
  case-insensitive and ignore trailing parameters.
- Self-test assertions for the link parsing.

### Changed

- When a folder or index location is connected after the page has loaded, the open tab now
  refreshes itself. Previously a tab opened first, such as one reached by a link, could stay on
  "connect a folder in Settings" until you switched away and back.
- Tab switching is now a single `showTab()` function shared by clicks, links and the
  browser's history.
- `#selftest` is unchanged and is never treated as a tab.

[↑ Back to Index](#index)

---

## 0.6.0 (2026-10-01)

**Summary:** photos can be rotated from the Library.

### Added

- **Rotate from the Library.** In the viewer: ↺ / ↻ buttons, `R` to turn right and `Shift+R` to
  turn left, with an animated turn. In Select mode: the same buttons turn every selected photo.
  An Undo bar follows each turn.
- Saved rotation is shown on tiles in the **Library, Timeline and chat results**, and listed in
  a photo's details.
- Self-test assertions for rotation.

### Changed

- Rotation is **non-destructive**: it is a `rotation` view setting (0, 90, 180 or 270 degrees
  clockwise) stored on the photo's record in the index. The original file and the stored
  thumbnail are never rewritten, so other applications still show the original orientation.
- All Library index changes (rotate, remove, restore) now go through one write queue, so quick
  successive actions cannot overwrite each other. Removing and restoring behave as before.
- A rescan keeps a photo's rotation, as it already did for hidden photos.

[↑ Back to Index](#index)

---

## 0.5.4 (2026-10-01)

**Summary:** the README's opening diagram is now a real architecture diagram. Documentation
only.

### Changed

- Replaced the ASCII sketch with a Mermaid architecture diagram (rendered natively by GitHub).
  It shows the interface and engine inside the browser, the read-only photo folder, the
  `.photoindex/` index, the local model server with its three model roles, and the one-time CDN
  downloads, with each connection labelled. A short "Reading the diagram" note follows it.

[↑ Back to Index](#index)

---

## 0.5.3 (2026-10-01)

**Summary:** corrected the instructions for opening the index. Documentation only.

### Fixed

- `OPERATIONS.md` told every reader to run `open /Volumes/Photos/.photoindex`, which is the
  original author's library path and does not exist on other machines. It now explains that
  the index is a `.photoindex` folder inside either the photo folder or the folder chosen under
  *Where to save the index*, why Settings shows only a folder name, and how to reach it from
  Terminal, Finder (Cmd+Shift+.) or the app (*What's in it?*).
- The manual backup and restore commands take the index location from a variable you set,
  instead of a hard-coded path. `SETUP.md` points at the same explanation.

[↑ Back to Index](#index)

---

## 0.5.2 (2026-10-01)

**Summary:** the README and Architecture now explain where photos live, where the metadata
lives, and how the two are joined. Documentation only; no behaviour changed.

### Added

- README section **Where your photos and data live**: a diagram and a table separating the
  photo folder, the index, derived images, browser settings, the model server and downloaded
  helpers, plus what follows from that (what survives deleting the index, moving photos, or a
  sleeping NAS).
- Architecture section **Where data lives**: the six places data can be, how the photo folder
  and the index are joined (`path` + `library_root` and a content fingerprint), which views
  need the index and which need the photo folder, what the model server and the browser each
  hold, and what can be rebuilt and at what cost.

### Changed

- The README FAQ answer to "Where is my data?" now links to that section.

[↑ Back to Index](#index)

---

## 0.5.1 (2026-10-01)

**Summary:** the README was restructured for first-time readers. Documentation only; no
behaviour changed.

### Changed

- README reorganised around the reader's path: a short pitch, **At a glance**, a three-step
  **Quick start**, a tour of each tab in **Using the app**, **How it works**, **Principles**,
  models and costs, and requirements.
- Added a **FAQ** covering uploads, file safety, people, Ollama, CORS errors, scan time,
  resuming and where the data lives.
- The privacy statement is now precise: photos are never uploaded, while decoders, the face
  model and the place-name list are downloaded once and cached.
- The version is no longer repeated in the README; the footer and this file are the sources.

[↑ Back to Index](#index)

---

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
