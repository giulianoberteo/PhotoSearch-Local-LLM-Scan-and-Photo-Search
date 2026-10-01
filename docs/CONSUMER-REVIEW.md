# Consumer readiness review

Reviewed 1 October 2026 against base commit `d9a4237` in `~/Desktop/PhotoSearch`.
Source review covers extraction, search, chat, people, storage, backups, planning,
UI and tests. The NAS inspection was read-only: no photos or index data changed.

## Assessment

PhotoSearch has a useful retrieval foundation: resumable extraction, EXIF
provenance, local text search, semantic ranking, alignment, and a portable index.
It is not yet consumer ready for dependable people recognition. Weak historical
measurements, permissive assignment, forgotten corrections and incomplete
recovery reinforce one another. A model replacement alone cannot fix that.

The local vision language model should describe scenes, objects and visible
text. A separate face pipeline should produce similarity evidence. Names must
come from the user; a requested person must be a search requirement.

## Actual library evidence

Aggregates read from `/Volumes/Photos/.photoindex/`; no names or captions appear here.

| Measure | Observed |
|---|---:|
| Unique index records / malformed lines | 7,106 / 0 |
| Error records | 67 |
| Text embedding rows / dimensions | 7,025 / 768 |
| Faces / distinct photos containing faces | 5,247 / 2,674 |
| Face vector rows / dimensions | 5,247 / 1,024 |
| Named groups / unnamed groups | 6 / 1 |
| Faces assigned to named groups | 5,245 |
| Stored face engine | `human@3.3.6+aligned` |
| Faces with pixel-size evidence | 4,973 |
| Median / tenth-percentile face size | 76 px / 47 px |
| Measured faces below the 112px model input | 3,547 (71.3%) |
| Extra same-person assignments within a photo | 864 |

All face rows lack the newer `src` field. That does not prove their source, but
the measured sizes show why enlargement cannot recover identity detail. The six
named groups have respectively 89, 87, 120, 0, 367 and 201 extra assignments within
the same photo. This signals conflicts, not a measured false-positive rate:
mirrors, posters, collages and duplicate detections are possible exceptions.
Existing named groups are not clean ground truth for model evaluation.

NAS directory reads stalled for several minutes; later small-file reads worked.
End-to-end throughput must include storage, not just inference time.

## Three changes implemented

**1. Corrections, conservative grouping and review.** Splits persist separation
decisions. Named-person rejections are remembered. Automatic grouping excludes
a second face from one photo, rejects incompatible engine measurements and uses
fixed confirmed anchors. Conflicting anchor sets cannot attract new assignments.
Ambiguous matches enter a review queue and stay out of named search until
confirmed. The 0.06 similarity margin is a heuristic, not an accuracy claim.
Legacy memberships are preserved because manual and automatic additions were
not distinguished in the old file.

One previous people edit can be undone, including its constraints. Failed saves
roll memory back; people data is checked after writing, and a verified previous
version is retained. Damaged people files produce an error rather than an empty
library. The screen adds conflict notices, name filtering, keyboard selection,
bounded group/face rendering and review actions.

**2. Direct retrieval without chat.** The Search tab promotes known unquoted names
to hard filters, requires everyone named/selected, supports `without Anna`, and
combines people with place/date controls. `Ann` cannot match `Anna`; quoted text
remains literal; duplicate names require a person selection. Name interpretation
can be switched off. Visible applied filters, empty-result guidance and full-count
pagination replace the twelve-result chat bottleneck. A named person's Photos
button opens this album. Chat uses the same search constraints.

Keyword/metadata search needs no model server. Optional semantic search falls
back to keywords if embedding fails. Relative dates, aliases, arbitrary boolean
grammar and typo correction remain roadmap items; use date/place controls now.

**3. Face recovery.** New backups include face records, vector data/mapping,
people/corrections, and the previous people version. Face copies have SHA-256
checksums and vector-length validation. Read errors are not treated as optional
missing files. Restore validates the face source first, retains a safety copy,
and avoids deleting its source when `keep=1`. Legacy backups preserve live faces;
new backups explicitly record their presence/absence. Library switches reset
identity caches. The dormant relocation helper also copies essential face data.

Crops and thumbnails remain excluded and need originals to regenerate. Restore
is not a multi-file transaction: storage failure during restore can leave partial
live data, with a safety copy for recovery. Use this build for new-format restores;
old builds ignore the new face manifest and correction fields.

## Remaining release blockers

| Priority | Source finding | Next action |
|---|---|---|
| P0 | Historical 1,024-d vectors cannot append into the 512-d space | Staged migration with a generation pointer and rollback |
| P0 | Refinement can reuse an ID, skip its vector update, then tombstone that ID | Generation replacement; identical-box and one-to-one remapping tests |
| P0 | Refinement does not remap new correction/undo references; now guarded when corrections exist | Preserve confirmed/rejected IDs and separation decisions through migration |
| P0 | Vector append changes memory before persistence succeeds | Publish memory after verified commit; inject write failures |
| P0 | A timed-out filesystem write can resume late | Fence generations; timeout is not cancellation |
| P0 | CDN/browser caching is not an offline install; model URL uses `main` | Immutable revisions, checksums, explicit offline asset installation |
| P0 | Backups share the live NAS failure domain | Independent-device backup and restore drill |
| P1 | Zero-face photos have no completion marker | Per-stage completion/version/outcome, including zero results |
| P1 | Face vector file is rewritten while growing | Batch or append safely; profile bytes and SMB throughput |
| P1 | Heavy face work runs on UI thread; grouping is greedy/order-sensitive | Worker execution and a labelled clustering benchmark |
| P1 | Semantic search embeds descriptions, not pixels | Separate versioned image embeddings; caption-miss evaluation |
| P1 | Videos are skipped | Explicit coverage plus timecoded video indexing |

No recognition-quality benchmark was run on private images. Synthetic regression
tests prove correction/retrieval contracts, not real-world identity accuracy.
Baseline: 479 passing assertions; the expanded suite has 534. Validation details
and limitations are in TESTING.md.

## External checks

InsightFace distinguishes its MIT code from its pretrained model/data usage terms.
Appropriate model licensing is a dependency for commercial distribution, separate
from this app's MIT code. [Model policy](https://github.com/deepinsight/insightface#license).

Writable streams commit at close; they do not transact across multiple index
files. [File System Access semantics](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createWritable).

Naming, merging and reassigning people are useful reference workflows for local
photo managers. [Immich's people workflow](https://docs.immich.app/features/facial-recognition/).
