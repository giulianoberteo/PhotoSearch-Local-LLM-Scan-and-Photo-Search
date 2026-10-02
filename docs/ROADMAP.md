# Roadmap: dependable local photo finding

Updated 1 October 2026. Evidence and current limits:
[CONSUMER-REVIEW.md](CONSUMER-REVIEW.md).

The outcome is “I can find the people and moments I remember, and correcting a
mistake improves future results.” Scene metadata, recognition, recovery and a
clear search interface all contribute. The single-file app remains the delivery
format; a companion service is a later decision justified by measured limits.

## Delivered in this change

1. Persistent face separations/rejections, conservative matching, a review queue,
   saved undo, conflict notices and clearer People controls.
2. Direct Search with required people filters, exclusions, date/place controls,
   keyword-only operation, optional semantic ranking and full-result pagination.
3. Verified face-data backups, source validation on restore, protection against
   pruning the restore source, checked people saves and library cache isolation.

These are foundations, not parity with Google Photos. Historical names and
measurements are preserved. Finish recovery and safe migration before promising
better recognition across this library.

## Milestones

Effort estimates assume one experienced developer, excluding model compute and
user labelling. Owners are roles to assign.

| Milestone | Owner | Estimate | Dependency | Exit gate |
|---|---|---|---|---|
| **MU: the Photos-style interface** | **Product/frontend engineer** | **9.5–11.5 days** | **PR #1 merged** | **Visual parity with the fork, no contrast or keyboard regressions** |
| M0: recoverable library | Storage engineer | 5–8 days | Delivered recovery changes | Crash matrix and independent-device restore pass |
| M1: trustworthy people | ML/application engineer | 8–12 days | M0, labelled pilot | Held-out recognition targets; corrections survive migration |
| M2: search intent and quality | Search engineer | 6–10 days | Stable person IDs, query benchmark | Retrieval and interpretation targets met |
| M3: everyday experience | Product/frontend engineer | 5–8 days | M0; overlap M1/M2 | Five-person usability study passes core tasks |
| M4: scale and coverage | Application engineer | 8–15 days | M0–M3 | 100k benchmark, media and offline-restart gates |

## MU — the Photos-style interface

**This is the first milestone.** It is ordered ahead of M0 on the owner's instruction.
Stated once and then accepted: M0 carries data-integrity work rated P0, and running a
visual programme first means those defects stay open for longer. The mitigation is that
every MU step below is presentation-only except where it says otherwise, so none of them
makes the P0s worse.

The design to adopt is in the fork at `giulianoberteo/aiPhotos`, which became PR #1. Phase
costs come from a file-level review of that branch; the reasoning is in
`scratchpad/review/01-ui.md`.

### What makes their interface theirs

Five ideas carry the look. Adopting the first two gets most of the visual change:

1. **A context-switching canvas.** `body:has(#tab-library:not([hidden])){--bg:var(--lib)}`
   with `main{max-width:none}`, so photo screens go full-bleed while settings and scan stay
   as cards.
2. **Borders out, shadow and glass in.** `backdrop-filter:saturate(180%) blur(22px)`, pill
   buttons, radius 10 to 16px, circular 72px face tiles, accent-tinted secondary buttons.
3. **`--hdr:52px` as a layout contract.** A fixed-height glass header with a centred
   segmented tab rail. `.tlbar` and the timeline day headings both position against it, so
   the token comes with the header.
4. **Search as chip tokens in the toolbar**, not on a tab, with the person's cropped face as
   the suggestion icon, and results rendered into the Library grid so Select, rotate, remove
   and the viewer work on them unchanged.
5. **Arithmetic virtualisation.** The grid computes its own window with 700px of over-scan
   in one `requestAnimationFrame`, rather than using an IntersectionObserver.

### MU-01: tokens and re-skin (1.5–2 days)

Port the custom properties, the glass and shadow treatment, the pill buttons, the radius
scale and the heading typography. Re-skin the existing Chat, Timeline, People, Scan and
Settings screens against the new tokens. No behaviour changes.

Fix two measured regressions rather than inheriting them. Their `.btn` label contrast is
4.02:1 in light and **3.65:1 in dark**, against 4.55 and 6.12 in the current build, and
their search glyph is 2.92:1 with `#8e8e93` hard-coded inside a data URI, so it ignores the
theme. Keep the current palette's contrast and take their shapes.

Acceptance: every existing screen renders with the new tokens; no text or control falls
below 4.5:1 in either theme; the self-test's hidden-element invariant still passes.

### MU-02: header, tab rail and hash routing (0.5 days)

Adopt the 52px glass header, the centred segmented rail, and per-tab links
(`#library`, `#chat`, `#timeline`, `#people`, `#scan`, `#settings`). Keep `#selftest`
working, and fix a defect in their version while porting: clicking a tab discards a
`#selftest&heic=…` hash, which breaks the documented decode fixture.

Acceptance: every tab is linkable and reloads to the same place; `#selftest` and its
fixture parameters survive navigation.

### MU-03: the Library grid and viewer (4–5 days)

Take `83-library.js` and its markup: the flat gallery, Select mode, rotate, remove, the
full-window viewer with slider, wheel, pinch, drag and double-click zoom, and opening
RAW, HEIC and TIFF at full size.

Three things must be fixed on the way in, all verified in the merged branch:

- **The viewer's keydown handler has no input guard.** Its sibling at `83-library.js:430`
  guards with `e.target.closest("input,textarea,select")`; the viewer's at line 729 does
  not, and line 738 maps Backspace to `vwRemove()`. The viewer contains its own
  `<input type="range" id="vwZr">`, and `openViewer` neither hides the header nor traps
  focus. So arrow keys on the zoom slider navigate photos instead of zooming, and Backspace
  there removes the photo from the library. Copy the guard from line 430.
- **No focus trap and no `aria-modal`** on a `role="dialog"`.
- **`.gheart` is tab-focusable at `opacity:0` with no `:focus-visible`**, so keyboard users
  reach an invisible control.

The `hidden`, `rotation` and `favourite` fields this depends on cross six modules
(`50-validate` reserved fields, `60-derived`, `65-search`, `82-timeline`, `86-peopleui`,
`70-runner` rescan preservation). Land them together or removed photos reappear on some
surfaces. Their `galPersist` also has to respect the `libraryMaintenance` interlock, which
has nine call sites here.

Acceptance: a removed photo is absent from the grid, search, timeline, events and stats;
rotation survives a rescan; no keystroke in a form control mutates the library.

### MU-04: toolbar search with chips (2.5–3 days)

Take `88-search.js`: grouped local suggestions, chip tokens, results in the Library grid.

**This is a product fork, not a merge.** Two search designs now coexist in the build, and
both ship their own self-tests:

| | `88-search.js` (theirs) | `88-searchui.js` (ours) |
|---|---|---|
| Entry point | header field, chips | Search tab, explicit controls |
| Results | Library grid, paged | own list, paged |
| People | chips resolved to photo sets | required-person filter, exclusions |

Decide one of: keep the header field and retire the Search tab; keep both with the tab as
the advanced surface; or merge the tab's filters into the chip grammar. Until that is
decided, rename one module out of slot 88, which currently holds two files.

Two defects to fix while porting: `photo_sets` is unguarded, so a hallucinated tool
argument throws a `TypeError` from `runTool`; and `args.max` removes the 60-result cap that
protects the chat context. Their `month` filter also slices the UTC month while the local
`r.when.month` sits unused.

Acceptance: a person chip returns exactly the photos the Search tab returns for the same
person; no tool argument can throw; the chat cap still holds for chat.

### Out of scope for MU

Nothing in MU changes the index format, the face pipeline or recovery. If a step appears to
need that, it belongs in M0 or M1 instead.

[↑ Back to Index](#index)

---

## MN — merging the non-UI changes from PR #1

Reviewed file by file against the merge base; the evidence is in
`scratchpad/review/03-nonui.md`. The reviewer ported their RAW reader to Node and ran it on
three real 85MB Sony ARW files rather than reasoning about it.

| Change | Verdict |
|---|---|
| `50-validate.js` reserving `hidden`, `hidden_at`, `rotation`, `favourite` | take as is |
| `60-derived.js` and `65-search.js` excluding hidden photos | take as is |
| `70-runner.js` preserving user flags across a rescan | take as is |
| `00-core.js` `ERR_HELP` and `humanError` | take as is |
| `30-worker.js` RAW previews | take with changes, see below |
| `90-selftest.js` calling `saveSettings()` in `finally` | **leave** |
| `00-core.js` mock-role sanitiser | leave, dead code |
| `65-search.js` `photo_sets` and `args.max` | take with changes, see MU-04 |

**RAW previews: a real capability, with one serious flaw.** The byte-scan fallback runs
only when the tag walk found nothing usable. For a TIFF-container RAW whose IFD0 holds just
a small thumbnail, the walk "succeeds" with roughly 160 by 120 pixels, so the vision model
captions a thumbnail and the stored `width` and `height` silently become the preview's. On
the evidence of the file layout that describes **Nikon NEF, the format the commit is named
after**, because its large preview lives in MakerNote and is never reached. Fix: run the
byte scan unconditionally, union it with the tagged spans, and trim each span at the next
`FF D9`, which also avoids copying an 85MB Blob per photo.

**Their self-test must not persist settings.** The suite mutates `S.baseUrl`,
`S.structuredMode` and `S.indexChosen` in blocks restored outside a `finally`, so a throw
now writes `structuredMode:"none"` or a localhost base URL into saved settings. That is the
bug class it set out to fix. Keep the `localStorage` snapshot already used here.

**One test gap to close.** Renaming the fixture `raw.CR2` to `one.CR2` means no RAW file
reaches `plan.new` or `runScan`, so the headline behaviour is untested end to end, and the
deleted `plan.counts.raw` assertion was not replaced, leaving `counts.raw` permanently 0,
which the plan summary reads. Add a `raw=` fixture hook beside the documented `heic=` one
and assert `decoder === "raw-preview"` with a long edge of at least 640.

**Unverified, and why.** Only ARW samples exist on this machine, so NEF, CR2, CR3, DNG, ORF,
RW2 and RAF previews are unconfirmed; whether `createImageBitmap` tolerates tens of
megabytes of sensor data after the end-of-image marker is unconfirmed, and it is the only
path for CR3 and RAF; and orientation was verified as arithmetic, not as pixels. The `raw=`
hook above settles all three.

[↑ Back to Index](#index)

---

## M0 — recoverable library first

**ST-01: immutable generations (3–4 days).** Introduce a manifest identifying the
committed record, vector and people generation. Stage new files, verify hashes,
byte counts, dimensions and references, then commit one pointer. Keep the previous
generation. Publish memory/checkpoints only after commit. Add a single-writer
library lock and fencing so a timed-out write cannot overwrite newer work.

Acceptance: inject termination/failure before and after every write, close,
verification and pointer update. Reload yields a complete old or new generation,
never a hybrid. Two tabs have at most one writer. Originals are never modified.

**ST-02: backup/recovery UX (1–2 days).** Support a separate-device backup target;
display last verified time, included data and crop/thumbnail regeneration cost.
Offer a read-only recovery screen for damaged people data with a preview of the
previous file and backup versions. Export diagnostics stripped of personal names,
captions, paths, images and vectors by default.

Acceptance: restore a copy of the actual library onto local disk, compare hashes
and counts, then find five known people/photos. Disconnect the NAS at every stage:
the app must show a recoverable error, never success. Preserve the pre-restore copy.
Recover captions without a vision-model rescan.

**ST-03: independent stage jobs (1–2 days).** Track decode, EXIF, face detection,
face embedding, captions, OCR and each embedding space independently. Persist
stage version, success/zero-results/failure, retry count and elapsed time. Add
waiting-for-drive/model, pause, retry and resume states; show indexed coverage.

Acceptance: killing the tab loses at most one uncommitted batch. Zero-face photos
are not repeatedly processed. A caption-model change does not redo faces. An
unavailable share cannot become an empty/missing library.

## M1 — trustworthy people

**PE-01: labelled pilot and evaluation command (2–3 days).** Select 300–500 local
photos covering children across years, siblings/relatives, profiles, spectacles,
low light, small faces, groups, mirrors, collages and no-face images. Keep labels
separate from automatic groups. Split by event/time to prevent near-duplicate
leakage. Report detection recall, false detections, identity precision/recall,
mixed-group rate, fragmentation, unresolved rate and review burden. The six
existing named groups are not reliable ground truth.

Initial held-out targets: automatic identity precision >=99.5%; recall >=90% on
reviewable faces at least 80px wide; zero explicit-rejection violations. Report
small-face and child age-gap results separately, with confidence intervals.
These are targets, not measured results. Prefer unresolved faces to lower
precision; tune thresholds only on the calibration split.

**PE-02: safe model/resolution migration (3–4 days).** Use ST-01 to replace old
1,024-d vectors with the chosen space without appending incompatible dimensions.
Sample original reads to estimate end-to-end I/O time. Detect at a suitable
resolution, align, and store quality/provenance: original face pixels, blur,
pose, detector/model version, source dimensions and crop revision. Re-read
originals if crops are absent or too small; enlargement is not recovered detail.

Maintain one-to-one old/new detection mapping. Preserve names, confirmations,
rejections and separations; ambiguous mappings go to review. Test same-box IDs,
detection reordering, missed detections and partial jobs. Preview conflicts before
switching the generation. Rollback restores previous groups and search results.

For this NAS, start with 100 photos sampled from the 2,674 known to contain faces.
Verify timing, mapping and precision before expanding. Save an independent backup.
Do not ask the user to delete face data to change models.

**PE-03: recognition quality and execution (2–3 days).** Compare the current
detector/ArcFace pipeline with a pinned SCRFD/recognition candidate on PE-01.
Choose by measured accuracy, latency, memory and permitted model use. Add several
confirmed prototypes per person for pose/ageing, quality-weighted comparisons and
calibrated automatic/review thresholds. Compare robust clustering with the greedy
baseline. Move detection, embedding and grouping into workers.

**PE-04: corrections people understand (1–2 days).** Show the face in its original
photo; add “not a face”, move directly to an existing person, cover photo, merge
preview, nicknames, hidden people and review history. Explain suggestions without
presenting cosine similarity as probability. Explicit confirmations may handle
mirrors/collages that automatic same-photo exclusion conservatively leaves apart.

Acceptance: five users can name, merge, split, reject, undo and find someone
without tuning a numeric threshold. Median correction takes under 10 seconds.

## M2 — search intent and quality

**SE-01: explicit query plan (2–3 days).** Add an AST covering person IDs,
include/exclude/any/all, dates, places and free text. Parse known names, aliases,
years, occasions, relative dates and geography with documented timezone/locale.
Show editable chips; ask one choice for ambiguity. “Anna and Ben in Sicily last
summer” must display the interpreted season/date range. Keep literal keyword mode.

Acceptance: a versioned set of at least 100 queries, including duplicate names,
non-Latin names, quotes, exclusions, uncertain dates and boolean language. Require
100% person-constraint correctness and >=95% interpretation accuracy on the
supported grammar. Never silently broaden a requested identity.

**SE-02: image/text hybrid retrieval (2–4 days).** Add separately versioned image
embeddings to find details omitted by captions. Choose a paired text/image encoder
by local benchmark: equal dimensions alone do not imply comparable vectors.
Fuse keywords, scene-text and image rankings after hard person/metadata filters.
Record model revision, preprocessing and normalization for every vector space.

Acceptance: >=100 judged searches with caption misses, screenshots/OCR, objects,
activities and genuine no-match cases. Target Recall@20 >=90% and nDCG@20 >=0.85
on the agreed set. Report people/scene/OCR separately and require no regression
on exact names or phrases. Compare against the existing baseline.

**SE-03: trust and speed (2–3 days).** Explain confirmed/suggested people, date
provenance and retrieval evidence. Add typo suggestions, saved searches, sorting
and image-based similarity. Cache query embeddings, cancel stale requests and
show useful keyword results when the server is unavailable.

Acceptance: warm keyword/person search p95 <250ms at 10k records and <1s at 100k
on the documented reference Mac. Report cold load, NAS thumbnail latency and
embedding time separately. Keep search and corrections keyboard operable.

## M3 — everyday experience

**UX-01: onboarding/reconnect (2 days).** Lead with Search and a sample import.
Explain photo location versus index location. Offer a local cache for NAS
originals once relocation/recovery is safe. Check capabilities, storage health
and model availability. Make faces/EXIF/thumbnails useful before background
captioning finishes. Show measured progress and searchable coverage.

**UX-02: browsing/lightbox (2–3 days).** Add next/previous and keyboard navigation,
people overlays, clear original/thumbnail state, reveal-original, date/place
correction and confidence display. Add favorites, local albums, place browsing
and a date scrubber. Preserve scroll, filters and selection. Virtualize large
groups/days and release unused image resources.

**UX-03: accessibility/usability (1–2 days).** Audit focus order/return, labels,
screen-reader status, contrast, 200% zoom, narrow windows and empty/error/loading
states. Test five participants on connecting, finding two people together,
correcting a false match, reconnecting a drive and restoring a backup. At least
four of five complete each task unaided; no task silently loses data.

## M4 — scale, offline and media coverage

**PL-01: offline asset installation (2–3 days).** Pin immutable model/runtime
revisions and checksums, show download size/progress, verify installation and
recover interrupted downloads. Persist assets intentionally rather than relying
on HTTP caches. Prove detection/search after restarting the browser with networking
disabled. Confirm model distribution terms before product release.

**PL-02: media coverage (3–5 days).** Add video records with timecoded keyframes
and face appearances; add speech transcription as an optional stage. Pair Live
Photos and RAW/JPEG siblings. Show unsupported codecs and decode failures;
metadata-only records should remain browseable. Never imply skipped video is
indexed. Group duplicates/bursts for review without deleting originals.

**PL-03: scale/soak testing (3–5 days).** Benchmark 10k/50k/100k libraries and long
jobs. Measure memory, UI responsiveness, I/O amplification, requests, storage
growth and recovery time. Evaluate a database/cache or companion service only
when measured limits justify it. Scope caches to a library and keep heavy work
off the UI thread.

## Release gates and rollout

1. CI: reproducible build and syntax; repeated same-page regressions; corruption,
   short-write, permission and timeout cases; separate real-model smoke tests
   using pinned artifacts. Synthetic vectors cannot establish recognition accuracy.
2. Recovery: independent backup and restore drill, old-format migration, crash
   matrix and rollback; originals untouched.
3. Private pilot: 100-photo subset, labelled evaluation and measured NAS timings.
   Inspect false positives before expanding to the existing face subset.
4. Library migration: pause/resume, preview and previous generation retained
   until representative results are reviewed.
5. Consumer beta: M0–M3 gates complete; publish measured coverage and remaining
   limits. Feature-gate unfinished media/offline support; do not claim parity.

Track locally: searchable coverage, failed stages, person-constraint failures,
identity precision, correction survival, review burden, p95 search time, time to
first useful result, and last independently verified backup. No telemetry or
personal photo data collection by default.
