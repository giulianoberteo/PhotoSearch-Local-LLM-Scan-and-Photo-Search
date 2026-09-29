# PhotoSearch — how it works and where everything is

Operating notes: where everything lives, how to back up by hand, and what to do when
network storage misbehaves. Paths below use `/Volumes/Photos` as an example library.

---

## 1. Where the files are

### The app

| | |
|---|---|
| `~/PhotoSearch.html` | The app. One file, ~250 KB. Double-click to open in Chrome. |
| `~/PhotoSearch-dev/` | Source code + build script (a git clone of the GitHub repo). |
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

**Thumbnails are not worth backing up.** They are 226 MB of the 275 MB index and can be
rebuilt from your originals without any model calls. `records.jsonl` is the only file that
cost 68 hours.

### Restoring

Copy the five files back into `/Volumes/Photos/.photoindex/`, overwriting. Reload the app,
reconnect the folder, press **Refresh plan**.

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

Chat sends your question plus eight tool definitions to the model. The model chooses which
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

**Practical consequences:**

- The in-app backup may fail. Use the shell command in §2 instead.
- **Refresh plan** may be slow or stall. Retry when the NAS is responsive.
- Scanning worked fine for 68 hours, because it is mostly model time with occasional writes.

**If you ever change your mind**, *Settings → Move index to a fast disk…* copies the six
core files to a local folder and switches to it, leaving the photos on the NAS. Thumbnails
stay behind and rebuild on demand. That removes this entire class of problem.

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

---

## 8. Checklist after any interruption

1. Open `PhotoSearch.html` in Chrome.
2. Reconnect the folder when asked — Chrome drops permission on reload.
3. **Refresh plan** to see what is outstanding.
4. **Retry failed** recovers anything that errored.
5. Back up with the shell command in section 2 if the share is slow.
