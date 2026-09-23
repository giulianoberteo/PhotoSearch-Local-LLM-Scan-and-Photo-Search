# Setup

## 1. LM Studio

Install [LM Studio](https://lmstudio.ai) and download at least a **vision** model.
`Qwen3.5-9B` is the reference; `gemma-4-12b` and other VLMs work too.

Optionally add an **embedding** model (`nomic-embed-text` is small and good). Without one,
search falls back to keyword matching — it works, but "children in a forest" will only match
those literal words.

### Start the server with CORS

This is the step that trips everyone up. PhotoSearch runs from `file://`, so the browser
sends `Origin: null` and LM Studio must be willing to answer it.

```bash
lms server start --cors --port 1234
```

Or in the GUI: **Developer** tab → Status **Running** → tick **Enable CORS**.

You must redo this after restarting LM Studio.

### Running LM Studio on another machine

Also enable **Serve on Local Network**, then set the URL in *Settings* to
`http://<that-machine>:1234`. Chrome may additionally prompt for local-network access.

### Memory

Models load on demand (JIT). PhotoSearch never requires them all at once — it is normal to
use the same model for scanning and chat so only one large model stays resident.

## 2. The browser

**Desktop Chrome or Edge.** PhotoSearch needs the File System Access API, which Firefox and
Safari do not implement. The app detects this on load and says so.

Open `PhotoSearch.html` by double-clicking it. No server needed.

## 3. First run

1. *Settings* → **Test connection**. The diagnostics panel names anything missing:
   server unreachable, CORS off, no vision model, no embedding model.
2. **Where to save the index** — beside the photos (default) or a folder you choose.
   For a NAS library, choose a local folder: writes stay off the share and search keeps
   working when the NAS is asleep.
3. **Choose folder** — your photos.
4. **Get place names** — downloads a GeoNames extract once (~17 MB) and caches it. Skip and
   photos store raw coordinates instead.
5. *Scan* tab → **Refresh plan** → review counts and ETA → **Scan new & changed**.

Set the embedding model **before** the first big scan: adding it later means re-embedding
every record.

## 4. What gets written

Only `.photoindex/`, and nothing else is ever touched:

```
config.json      settings, the extraction schema, schema/prompt hashes
records.jsonl    one JSON object per photo, append-only
vectors.bin      float32 embeddings        vectors.json  id mapping
thumbs/<id>.jpg  384px thumbnails
runs.jsonl       one line per scan: timing, errors, models
state.json       resume checkpoint
geo/             cached place-name data
backups/         verified copies, pruned to a keep count
```

`.photoindex` is **hidden** on macOS (leading dot). To open it:
`open /path/to/photos/.photoindex`, or Finder → Cmd+Shift+G.

## Troubleshooting

**"Failed to fetch" on Test connection** — the server is off, or CORS is not enabled.
Run `lms server start --cors --port 1234`.

**Every image fails with `model_not_found`** — no scan model selected. The preflight check
catches this before a scan starts and names the fix.

**"File picker already active"** — Chrome allows one dialog at a time, and on macOS the
panel process can outlive it:
```bash
pkill -9 -f openAndSavePanelService
```
If that finds nothing, quit Chrome entirely (a reload is not always enough).

**A button sits on "working…"** — if the tab was hidden or occluded, this was a
`requestAnimationFrame` stall; it is fixed, but reload if you see it on an old build.

**Scan interrupted** — nothing is lost. The plan is the source of truth: anything without a
record is found again. *Resume* appears when a checkpoint exists.

**HEIC or TIFF fail** — their decoders load from a CDN on first use. Offline, those files
are skipped and counted rather than failing the scan.
