# Operations

Operating notes: where everything lives, how to back up by hand, how a scan behaves when it
is interrupted, and what to do when network storage misbehaves.

The numbers come from the reference library (6,635 photos on an SMB NAS). Where a command
needs a path, it uses `/Volumes/Photos` as a stand-in for **your own photo folder**; replace
it with your own, as explained in [Finding your index](#finding-your-index).

## Index
<!-- index:start -->
- [Where the files are](#where-the-files-are)
  - [The app](#the-app)
  - [The index: your scanned data](#the-index-your-scanned-data)
  - [Finding your index](#finding-your-index)
- [Backing up by hand](#backing-up-by-hand)
  - [Thumbnails are deliberately not backed up](#thumbnails-are-deliberately-not-backed-up)
  - [Restoring](#restoring)
- [How a scan works](#how-a-scan-works)
- [If a scan is interrupted](#if-a-scan-is-interrupted)
- [How search works](#how-search-works)
- [Known problem: slow network storage](#known-problem-slow-network-storage)
- [Settings that matter](#settings-that-matter)
  - [Library: removing and restoring photos](#library-removing-and-restoring-photos)
  - [Faces](#faces)
  - [Picking a different photo folder](#picking-a-different-photo-folder)
- [Checklist after any interruption](#checklist-after-any-interruption)
<!-- index:end -->

## Where the files are

### The app

| | |
|---|---|
| `PhotoSearch.html` | The app. One file, about 530 KB. Double-click to open in Chrome. |
| `PhotoSearch-dev/` | Source code and build script (a git clone of the repository). |

To use it on another machine, copy **`PhotoSearch.html`** only. Nothing else is needed except
Chrome and a model server.

### The index: your scanned data

The index is a folder named **`.photoindex`**, hidden because of the leading dot. In the
reference library that was `/Volumes/Photos/.photoindex/`. Yours is wherever
[Finding your index](#finding-your-index) says.

| file | size | what it is |
|---|---:|---|
| `records.jsonl` | 29 MB | **The valuable one.** One JSON object per photo: every caption, description, object list, date and place. It represents 68 hours of scanning. |
| `vectors.bin` | 20 MB | Embeddings: 768 float32 numbers per photo, for semantic search. |
| `vectors.json` | 125 KB | Which row of `vectors.bin` belongs to which photo. |
| `thumbs/` | 226 MB | One 384px JPEG per photo, named `<id>.jpg`. |
| `faces/` | varies | Face geometry, vectors, aligned crops and the names you gave people. Deleted by one button in the People tab. |
| `config.json` | 7 KB | Settings, the extraction schema, and the hashes that detect when records are out of date. |
| `runs.jsonl` | 9 KB | One line per scan: when, how long, how many, every error. |
| `state.json` | 55 B | Resume checkpoint. 55 bytes means "nothing pending"; the scan finished. |
| `geo/` | 3.8 MB | Cached place-name data (170,540 cities), so GPS becomes "Staines, GB" offline. |
| `backups/` | | Copies made by the app. |

### Finding your index

The index is always a folder called `.photoindex` **inside one parent folder**, and which
parent depends on a setting:

| *Where to save the index* in Settings | the index is at |
|---|---|
| **Beside the photos** (the default) | `<the photo folder you picked>/.photoindex` |
| **A folder I choose** | `<the folder you chose>/.photoindex` |

Settings shows this as "Saving the index to *name*/.photoindex/". It shows only the folder's
**name**, not its full path, because a browser does not reveal full paths to a page. You
already know where that folder is, so:

- **In Terminal**, give `open` the full path to *your* folder:
  ```bash
  open "/path/to/your/photo-folder/.photoindex"
  ```
  For example `open "/Volumes/Photos/.photoindex"` if your photos are in `/Volumes/Photos`.
- **In Finder**, open your photo (or index) folder and press **Cmd+Shift+.** to show hidden
  files, then open `.photoindex`. Or press **Cmd+Shift+G** and type the path.
- **Without leaving the app**, *Settings → What's in it?* lists every file in the index with
  its size.

A bare `open .photoindex` only works if your terminal is already inside the parent folder.

[↑ Back to Index](#index)

---

## Backing up by hand

The in-app button can be unreliable against a slow NAS (see
[Known problem: slow network storage](#known-problem-slow-network-storage)). This always works:

```bash
INDEX="/Volumes/Photos/.photoindex"        # change this to YOUR index folder
DEST=~/PhotoSearch-backups/$(date +%Y-%m-%d_%H%M)
mkdir -p "$DEST"
cp -p "$INDEX"/{records.jsonl,vectors.bin,vectors.json,config.json,runs.jsonl} "$DEST"/
ls -la "$DEST"
```

If your shell cannot read that folder (macOS privacy restrictions), use Finder instead: open
the index folder (see [Finding your index](#finding-your-index)) and drag those five files
somewhere.

**Verify that a backup is readable:**

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

Expect `6635 lines, 6635 photos, 0 unreadable` for the reference library. A library that has
been rescanned or had photos removed has more lines than photos, because the file is
append-only and the last line for an id wins.

### Thumbnails are deliberately not backed up

They are 226 MB of the 275 MB index, whereas `records.jsonl` is the only file that cost 68
hours. Getting thumbnails back is cheap: **Scan tab → Rebuild thumbnails**. It lists what is
already there, works out which photos have no thumbnail, finds those originals in the folder
you have open, and remakes the missing ones. **No model is involved**; it is a decode and a
resize, so it runs at disk speed rather than at 21 seconds a photo.

- Photos are found by **content**, so a library reorganised since the scan still rebuilds
  correctly.
- If some photos live in a folder you do not currently have open, it says how many and
  rebuilds the rest. Open that folder afterwards and run it again.
- **Nothing in the index is rewritten.** Captions, dates, places and embeddings are not
  touched, and error records are left alone.
- Thumbnails belonging to photos no longer in the index are reported but **never deleted**.
  The command rebuilds; it does not tidy.
- It can be paused and stopped like a scan, and picks up where it left off next time.

Listing `thumbs/` takes about 75 seconds on this NAS, so expect the count to take that long
before the rebuild itself starts.

### Restoring

Copy the files back into your index folder, overwriting; then reload the app,
reconnect the folder and press **Refresh plan**.

A backup made by the app contains four files: `records.jsonl`, `vectors.bin`, `vectors.json`
and `config.json`. The shell command above also takes `runs.jsonl`, which is history rather
than data. `state.json` is a resume checkpoint and is *not* worth restoring, since an old one
points at a queue that no longer applies. Delete it and press **Refresh plan** instead.

Photos you removed from the Library are restored along with the rest, because `hidden` is a
field in `records.jsonl`.

[↑ Back to Index](#index)

---

## How a scan works

For each photo:

1. **Read** the file (retried three times; network shares drop reads).
2. **Decode and resize** in a background thread: a 1024px JPEG for the model and a 384px
   thumbnail for the index. EXIF rotation is applied here.
3. **Read EXIF**: date, camera, GPS. The date's *source* and *confidence* are recorded,
   because EXIF is often an export time rather than when the photo was taken.
4. **Ask the model**, sending the image and a fixed JSON schema. The schema is what stops the
   model "thinking" out loud, which would cost 20 times the tokens.
5. **Validate** in JavaScript: length caps, allowed values, singular nouns.
6. **Correct `image_type`** using the filename, camera tags, pixel dimensions and the model's
   own caption. Left alone, it calls almost everything a "photo".
7. **Extra text pass** for screenshots and documents, which reads far more text than the
   main pass.
8. **Resolve GPS** to a place name offline, and work out season, weekday and occasion.
9. **Embed** a text summary for semantic search.

Results are written to disk every 25 photos, along with a checkpoint.

**Before the first photo**, pressing Scan takes a safety copy of the existing index. On a
29 MB `records.jsonl` over a slow share, that is a couple of minutes on its own. The progress
card appears immediately and names each step, so the wait is visible rather than looking like
a button that did nothing. Stop works during that phase too.

**Speed is about 21.5 seconds per photo.** The reference scan of 6,621 photos took 68 hours.
Concurrency does not help, because the model server processes one request at a time unless
configured otherwise.

[↑ Back to Index](#index)

---

## If a scan is interrupted

**You never start from zero.** The plan compares what is on disk with what is in
`records.jsonl`:

- no record → **new**
- file changed since it was scanned → **changed**
- recorded as an error → **failed**
- schema, prompt or model changed since → **stale**

**Scan new & changed** picks up exactly what is missing. The worst case after a crash is
re-scanning the last 25 photos.

Photos are identified by their *content* (name + size + modified time, confirmed by a hash of
the first 64 KB), not by their path, so moving folders around does not cause rescans.

[↑ Back to Index](#index)

---

## How search works

There is no database. Everything is loaded into memory from `records.jsonl` and
`vectors.bin`:

- **Keywords:** BM25 over caption, description, objects, activities and visible text.
- **Meaning:** cosine similarity over the embeddings.
- **Merged** by reciprocal rank fusion, with a relevance floor so a nonsense query returns
  nothing rather than confident junk.
- **`"Quoted phrases"`** must match exactly.
- **Hidden photos** (removed from the Library) are never returned.

Chat sends your question plus nine tool definitions to the model. The model chooses which tool
to call; **the tools run locally** and return only small summaries, so the model never sees
your index. The one exception is `look_at_photos`, which sends up to six thumbnails back for a
visual question.

[↑ Back to Index](#index)

---

## Known problem: slow network storage

Measured on a WD PR4100 NAS over SMB:

| operation | time |
|---|---:|
| write 5 bytes, drives awake | 0.05 – 0.92 s |
| write 5 bytes, drives asleep | 24 s |
| copy 29 MB | 67.5 s (about 430 KB/s) |
| **list `thumbs/` (6,568 files)** | **75.6 s** |
| list `.photoindex/` (sometimes) | **over 120 s: no response** |

The last row is the problem. It is not specific to the app: a plain `ls` from the command line
hangs the same way. Directory operations on this share intermittently stop responding, and
nothing in a browser can work around that.

**What the app does about it**

- **It measures your storage on connect** and says what it found, in Settings under the index
  location (for example "storage: 24000 ms per operation (very slow, likely a sleeping network
  share); deadlines 180s"). Every time limit is then sized from that measurement rather than a
  fixed number. This is why the backup used to give up after 30 seconds on a share that needs
  24 just to wake.
- **Nothing sits on a label any more.** If an operation stalls, it fails with both what it was
  attempting and how far it got: "opening the index did not finish within 180s [stuck at:
  Reading config.json…]". That names the step, which is the difference between a report and a
  shrug.
- **Opening the index never touches `thumbs/`**, the 75-second row above. That folder is opened
  only when a thumbnail is actually displayed.
- **Writes are checked, not assumed.** After appending records, the file is re-read and its
  length compared. A write that came back short is reported instead of being treated as saved.

**Still true**

- If the share genuinely stops responding, nothing in a browser can fix it. The shell command
  in [Backing up by hand](#backing-up-by-hand) is the fallback, and it always works.
- Scanning is mostly model time with occasional writes, which is why it ran for 68 hours
  without trouble while single operations were failing.

There is no "move the index elsewhere" command. If you want the index somewhere faster, set
**Where to save the index** to a local folder in Settings and rescan; the photos stay where
they are.

[↑ Back to Index](#index)

---

## Settings that matter

| setting | why |
|---|---|
| **Where to save the index** | Beside the photos, or a folder you choose. |
| **Embeddings model** | Without one, search is keyword-only. Adding it later means re-embedding everything. |
| **Scan order** | Newest first by default, so the index is useful on day one of a long scan. |
| **Scan scope** | Optional: work through a big library one folder at a time. |
| **Max tokens** | 2000. Lower values truncate photos containing a lot of text. |
| **Back up after every scan** | On by default; keeps the last 3. |
| **Rebuild thumbnails** (Scan tab) | Remakes missing thumbnails from the originals. No model time. |

### Library: removing and restoring photos

In the **Library** tab, *Select* (or the viewer's *Remove* button) hides photos from the
library, search, chat, the Timeline and People. It changes `records.jsonl` only; the files on
disk are never touched. *Undo* appears for about nine seconds, and *Removed (N)* lists
everything hidden so you can *Restore* it. A rescan does not bring removed photos back.

Because removal appends a record, it is a write to the index. If the index is on a share that
is asleep or read-only, you get an error message and nothing changes on screen.

### Faces

**People tab → Find faces.** With **Read from** set to *Thumbnails*, it covers the **whole
index** whichever folder is connected, because thumbnails are keyed by photo, not by folder.
*Originals* is more accurate but can only reach the folder you have open, and on this NAS means
re-reading 14.3 GB rather than 214 MB.

It is resumable: photos already looked at are skipped, so stopping and pressing it again
carries on. Progress, speed, time remaining and Pause/Stop are shown on the People tab while
it runs.

Names you assign are searchable immediately, in the search box and in chat, where
`list_people` tells the model which names exist.

### Picking a different photo folder

Choosing another folder to scan does **not** move or replace your index. The two settings are
independent:

- **Where to save the index** decides where the data goes.
- The **picked folder** decides which photos are scanned into it.

With the index location fixed, scanning a second folder adds to the *same* index. Photos are
matched by content, not by path, so you can scan a subfolder today and the whole library
tomorrow without duplicates and without anything being wrongly marked missing.

With the index set to live *beside the photos*, each folder you pick gets its own
`.photoindex/`, which is the reason the fixed-location setting exists.

Records from a folder you are not currently looking at are never reported missing. Only
records belonging to the folder actually walked are considered.

[↑ Back to Index](#index)

---

## Checklist after any interruption

1. Open `PhotoSearch.html` in Chrome.
2. Reconnect the folder when asked, because Chrome drops permission on reload.
3. **Refresh plan** to see what is outstanding.
4. **Retry failed** recovers anything that errored.
5. Back up with the shell command in [Backing up by hand](#backing-up-by-hand) if the share is
   slow.

[↑ Back to Index](#index)
