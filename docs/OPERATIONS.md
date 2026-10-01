# PhotoSearch — how it works and where everything is

Current workspace: `~/Desktop/PhotoSearch`; open its `PhotoSearch.html`.
The older measurements below are historical. See [the current review](CONSUMER-REVIEW.md)
for the live library audit and the people/search update at the end of this document
for the new face-backup format.

Operating notes: where everything lives, how to back up by hand, and what to do when
network storage misbehaves. Paths below use `/Volumes/Photos` as an example library.

---

## 1. Where the files are

### The app

| | |
|---|---|
| `~/Desktop/PhotoSearch/PhotoSearch.html` | The current app. Double-click to open in Chrome. |
| `~/Desktop/PhotoSearch/` | Active source, build script, review and roadmap. |
| GitHub | https://github.com/giuvilas/PhotoSearch-Local-LLM-Scan-and-Photo-Search |

To use it on another machine, copy **`PhotoSearch.html`** only. Nothing else is needed
except Chrome and LM Studio.

### The index — your scanned data

**`/Volumes/Photos/.photoindex/`** (on the NAS, hidden because of the leading dot)

| file | size | what it is |
|---|---:|---|
| `records.jsonl` | 29 MB | **The valuable one.** One JSON object per photo, 6,635 of them. Every caption, description, object list, date, place. This is the 68 hours of scanning. |
| `vectors.bin` | 20 MB | Embeddings — 768 float32 numbers per photo, for semantic search. |
| `vectors.json` | 125 KB | Which row of `vectors.bin` belongs to which photo. |
| `thumbs/` | 226 MB | 6,568 JPEG thumbnails, one per photo, named `<id>.jpg`. |
| `config.json` | 7 KB | Settings, the extraction schema, and hashes that detect when records are out of date. |
| `runs.jsonl` | 9 KB | One line per scan: when, how long, how many, every error. |
| `state.json` | 55 B | Resume checkpoint. 55 bytes means "nothing pending" — the scan finished. |
| `geo/` | 3.8 MB | Cached place-name data (170,540 cities) so GPS becomes "Staines, GB" offline. |
| `backups/` | — | Copies made by the app. One complete one exists, from 28 Sep. |

To open it in Finder (it's hidden):

```bash
open /Volumes/Photos/.photoindex
```


---

## 2. Backing up by hand

The in-app button is unreliable against this NAS (see §6). This always works:

```bash
DEST=~/PhotoSearch-backups/$(date +%Y-%m-%d_%H%M)
mkdir -p "$DEST"
cp -p /Volumes/Photos/.photoindex/{records.jsonl,vectors.bin,vectors.json,config.json,runs.jsonl} "$DEST"/
ls -la "$DEST"
```

If your shell can't read `/Volumes/Photos` (macOS privacy restrictions), use Finder: open
`/Volumes/Photos/.photoindex` with Cmd+Shift+G and drag those five files somewhere.

**Verify a backup is readable:**

```bash
python3 -c "
import json,sys
n=bad=0; ids=set()
for l in open(sys.argv[1]):
    if not l.strip(): continue
    n+=1
    try: ids.add(json.loads(l)['id'])
    except Exception: bad+=1
print(f'{n} lines, {len(ids)} photos, {bad} unreadable')
" ~/PhotoSearch-backups/*/records.jsonl
```

Expect `6635 lines, 6635 photos, 0 unreadable`.

**Thumbnails are deliberately excluded from backups.** They are 226 MB of the 275 MB
index, and `records.jsonl` is the only file that cost 68 hours.

**Getting them back: Scan tab → Rebuild thumbnails.** It lists what is already there,
works out which photos have no thumbnail, finds those originals in the folder you have
open and re-makes the missing ones. **No model is involved** — it is a decode and a
resize, so it runs at disk speed rather than at 21 seconds a photo.

- Photos are found by **content**, so a library that has been reorganised since the scan
  still rebuilds correctly.
- If some photos live in a folder you do not currently have open, it says how many and
  rebuilds the rest. Open that folder afterwards and run it again.
- **Nothing in the index is rewritten.** Captions, dates, places and embeddings are not
  touched, and error records are left alone.
- Thumbnails belonging to photos no longer in the index are reported but **never
  deleted** — the command rebuilds, it does not tidy.
- It can be paused and stopped like a scan, and picks up where it left off next time.

Listing `thumbs/` takes about 75 seconds on this NAS (§6), so expect the count to take
that long before the rebuild itself starts.

### Restoring

Copy the files back into `/Volumes/Photos/.photoindex/`, overwriting, then reload the app,
reconnect the folder and press **Refresh plan**.

A backup made by the app contains four files — `records.jsonl`, `vectors.bin`,
`vectors.json`, `config.json`. The shell command above also takes `runs.jsonl`, which is
history rather than data. `state.json` is a resume checkpoint and is *not* worth restoring:
an old one points at a queue that no longer applies. Delete it and press **Refresh plan**
instead.

---

## 3. How a scan works

For each photo:

1. **Read** the file (retried 3× — network shares drop reads).
2. **Decode and resize** in a background thread: a 1024px JPEG for the model, a 384px
   thumbnail for the index. EXIF rotation is applied here.
3. **Read EXIF**: date, camera, GPS. The date's *source* and *confidence* are recorded —
   EXIF is often an export time rather than when the photo was taken.
4. **Ask the model**, sending the image plus a fixed JSON schema. The schema is what stops
   the model "thinking" out loud, which would cost 20× the tokens.
5. **Validate** in JavaScript: length caps, allowed values, singular nouns.
6. **Correct `image_type`** using the filename, camera tags, pixel dimensions and the
   model's own caption — it calls almost everything a "photo" otherwise.
7. **Extra text pass** for screenshots and documents, which reads far more text than the
   main pass.
8. **Resolve GPS** to a place name offline; work out season, weekday and occasion.
9. **Embed** a text summary for semantic search.

Written to disk every 25 photos, along with a checkpoint.

**Before the first photo**, pressing Scan takes a safety copy of the existing index — on a
29 MB `records.jsonl` over this share that is a couple of minutes on its own. The progress
card now appears immediately and names each step of it, so the wait is visible rather than
looking like a button that did nothing. Stop works during that phase too.

**Speed: ~21.5 seconds per photo.** Your 6,621-photo scan took 68 hours. Concurrency does
not help — LM Studio processes one request at a time.

---

## 4. If a scan is interrupted

**You never start from zero.** The plan compares what is on disk with what is in
`records.jsonl`:

- no record → **new**
- file changed since it was scanned → **changed**
- recorded as an error → **failed**
- schema or model changed since → **stale**

**Scan new & changed** picks up exactly what is missing. Worst case after a crash is
re-scanning the last 25.

Photos are identified by their *content* (name + size + modified time, confirmed by a hash
of the first 64 KB), not by their path — so moving folders around does not cause re-scans.

---

## 5. How search works

No database. Everything is loaded into memory from `records.jsonl` and `vectors.bin`:

- **Keywords**: BM25 over caption, description, objects, activities, visible text.
- **Meaning**: cosine similarity over the embeddings.
- **Merged** by reciprocal rank fusion, with a relevance floor so a nonsense query returns
  nothing rather than confident junk.
- **`"quoted phrases"`** must match exactly.

Chat sends your question plus nine tool definitions to the model. The model chooses which
tool to call; **the tools run locally** and return only small summaries — the model never
sees your index. The one exception is `look_at_photos`, which sends up to six thumbnails
back for a visual question.

---

## 6. Known problem: this NAS

Measured on your WD PR4100 over SMB:

| operation | time |
|---|---:|
| write 5 bytes, drives awake | 0.05 – 0.92 s |
| write 5 bytes, drives asleep | 24 s |
| copy 29 MB | 67.5 s (~430 KB/s) |
| **list `thumbs/` (6,568 files)** | **75.6 s** |
| list `.photoindex/` (sometimes) | **over 120 s — no response** |

The last row is the problem. It is not specific to the app — a plain `ls` from the command
line hangs the same way. Directory operations on this share intermittently stop responding,
and nothing in the browser can work around that.

**What the app now does about it:**

- **It measures your storage on connect** and says what it found, in Settings under the
  index location: *"storage: 24000 ms per operation (very slow — likely a sleeping network
  share); deadlines 180s"*. Every time limit is then sized from that measurement rather
  than from a fixed number — which is why the backup used to give up after 30 seconds on a
  share that needs 24 just to wake.
- **Nothing sits on a label any more.** If an operation does stall, it fails with both what
  it was attempting and how far it got: *"opening the index did not finish within 180s
  [stuck at: Reading config.json…]"*. That names the step, which is the difference between
  a report and a shrug.
- **Opening the index never touches `thumbs/`** — the 75-second row above. That folder is
  opened only when a thumbnail is actually displayed.
- **Writes are checked, not assumed.** After appending records the file is re-read and its
  length compared; a write that came back short is reported instead of being treated as
  saved.

**Still true:**

- If the share genuinely stops responding, nothing in a browser can fix that. The shell
  command in §2 is the fallback, and it always works.
- Scanning is mostly model time with occasional writes, which is why it ran for 68 hours
  without trouble while single operations were failing.

The index stays on the NAS. There is no "move the index elsewhere" command in the app —
it was removed. If you ever want the index somewhere faster, set **Where to save the
index** to a local folder in Settings and re-scan; the photos stay where they are.

---

## 7. Settings that matter

| setting | why |
|---|---|
| **Where to save the index** | Beside the photos, or a folder you choose. |
| **Embeddings model** | Without one, search is keyword-only. Adding it later means re-embedding everything. |
| **Scan order** | Newest first by default, so the index is useful on day one of a long scan. |
| **Scan scope** | Optional: work through a big library one folder at a time. |
| **Max tokens** | 2000. Lower values truncate photos containing a lot of text. |
| **Back up after every scan** | On by default. Keeps the last 3. |
| **Rebuild thumbnails** (Scan tab) | Remakes missing thumbnails from the originals. No model time. |

### Faces

**People tab → Find faces.** With **Read from** on *Thumbnails* it covers the **whole
index**, whatever folder happens to be connected — thumbnails are keyed by photo, not by
folder. *Originals* is more accurate but can only reach the folder you have open, and on
this NAS means re-reading 14.3 GB rather than 214 MB.

It is resumable: photos already looked at are skipped, so stopping and pressing it again
carries on. Progress, speed, time remaining and Pause/Stop are shown on the People tab
itself while it runs.

Names you assign are searchable immediately — in the search box, and in chat, where
`list_people` tells the model which names exist.

### Picking a different photo folder

Choosing another folder to scan does **not** move or replace your index. The two settings
are independent:

- **Where to save the index** decides where the data goes.
- The **picked folder** decides which photos are scanned into it.

With the index location fixed, scanning a second folder adds to the *same* index. Photos
are matched by content, not by path, so you can scan a subfolder today and the whole
library tomorrow without duplicates and without anything being wrongly marked missing.

With the index set to live *beside the photos*, each folder you pick gets its own
`.photoindex/` — which is the reason the fixed-location setting exists.

Records from a folder you are not currently looking at are never reported missing: only
records belonging to the folder actually walked are considered.

---

## 8. Checklist after any interruption

1. Open `PhotoSearch.html` in Chrome.
2. Reconnect the folder when asked — Chrome drops permission on reload.
3. **Refresh plan** to see what is outstanding.
4. **Retry failed** recovers anything that errored.
5. Back up with the shell command in section 2 if the share is slow.

## People/search update — 1 October 2026

The active app is now `~/Desktop/PhotoSearch/PhotoSearch.html`; source and builds live
in that Desktop folder. The index remains `/Volumes/Photos/.photoindex/`.

New backups include the essential `faces/` records, vector files, `people.json`
(names, corrections and undo), and `people.previous.json`. Face files have checksums.
The older instructions above describe backups that predate face support. Manual
backups must also copy those face files to protect naming work. Face crops and
photo thumbnails are excluded from in-app backups and require originals to regenerate.

Use the current build to restore these backups. Older builds do not understand the
face manifest or correction fields. Restore retains a safety copy; old-format backups
without a face manifest preserve the current faces. A separate-device copy is still
necessary to protect against failure of the NAS itself.

The live library contains historical face vectors. Do not delete them to change
models. See `CONSUMER-REVIEW.md` and the staged migration in `ROADMAP.md` before a
whole-library remeasurement. Existing names remain searchable and correctable.
