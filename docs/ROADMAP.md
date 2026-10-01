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
| M0: recoverable library | Storage engineer | 5–8 days | Delivered recovery changes | Crash matrix and independent-device restore pass |
| M1: trustworthy people | ML/application engineer | 8–12 days | M0, labelled pilot | Held-out recognition targets; corrections survive migration |
| M2: search intent and quality | Search engineer | 6–10 days | Stable person IDs, query benchmark | Retrieval and interpretation targets met |
| M3: everyday experience | Product/frontend engineer | 5–8 days | M0; overlap M1/M2 | Five-person usability study passes core tasks |
| M4: scale and coverage | Application engineer | 8–15 days | M0–M3 | 100k benchmark, media and offline-restart gates |

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
