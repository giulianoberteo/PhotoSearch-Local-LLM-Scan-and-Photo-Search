# Setup

Everything needed to get from nothing to a scanned, searchable library: choosing a model
server, allowing the page to talk to it, the first run, and what to do when something fails.

## Index
<!-- index:start -->
- [Choosing a server](#choosing-a-server)
- [LM Studio](#lm-studio)
  - [Start the server with CORS](#start-the-server-with-cors)
  - [Running LM Studio on another machine](#running-lm-studio-on-another-machine)
  - [Memory](#memory)
- [Ollama](#ollama)
- [The browser](#the-browser)
  - [Serving it to other machines](#serving-it-to-other-machines)
- [First run](#first-run)
- [What gets written](#what-gets-written)
- [Troubleshooting](#troubleshooting)
<!-- index:end -->

## Choosing a server

Any server that speaks the OpenAI API will do. Only the URL and the model names differ.

| server | URL for Settings | allow this page to connect |
|---|---|---|
| **LM Studio** | `http://localhost:1234` | `lms server start --cors --port 1234`, or *Developer* → tick **Enable CORS** |
| **Ollama** | `http://localhost:11434` | `OLLAMA_ORIGINS='*' ollama serve`; for the macOS menu-bar app, `launchctl setenv OLLAMA_ORIGINS '*'` and restart Ollama |
| **llama.cpp server** | `http://localhost:8080` | build with CORS allowed, or put it behind a proxy that sets `Access-Control-Allow-Origin: *` |
| **vLLM** | `http://localhost:8000` | `--allowed-origins '["*"]'` |
| **LocalAI** | `http://localhost:8080` | `CORS=true CORS_ALLOW_ORIGINS='*'` |

A URL ending in `/v1` is accepted as well as one without, so pasting
`http://localhost:11434/v1` works.

**Why CORS is always the first problem.** The app is a local file, so the browser sends
`Origin: null`. Every one of these servers rejects that by default, and the failure looks
exactly like the server being down. **Test connection** names the fix for whichever server it
detected.

**What Test connection checks**, in order:

1. the server answers;
2. CORS allows this page;
3. which models exist, and whether their types could be detected;
4. whether the server can enforce a **JSON schema**.

The last one matters because constrained decoding is what stops a reasoning model spending
its whole budget thinking (13 output tokens instead of 799). If your server cannot do it, the
app falls back to "JSON only" and then to parsing prose, and tells you which.

[↑ Back to Index](#index)

---

## LM Studio

Install [LM Studio](https://lmstudio.ai) and download at least a **vision** model.
`Qwen3.5-9B` is the reference, and `gemma-4-12b` and other VLMs work too.

Optionally add an **embedding** model (`nomic-embed-text` is small and good). Without one,
search falls back to keyword matching. It still works, but "children in a forest" will only
match those literal words.

### Start the server with CORS

This step trips everyone up. PhotoSearch runs from `file://`, so the browser sends
`Origin: null` and LM Studio must be willing to answer it.

```bash
lms server start --cors --port 1234
```

Or in the app: **Developer** tab → Status **Running** → tick **Enable CORS**. You must redo
this after restarting LM Studio.

### Running LM Studio on another machine

Also enable **Serve on Local Network**, then set the URL in *Settings* to
`http://<that-machine>:1234`. Chrome may additionally ask for local-network access.

### Memory

Models load on demand. PhotoSearch never requires them all at once, and it is normal to use
the same model for scanning and chat so that only one large model stays resident.

[↑ Back to Index](#index)

---

## Ollama

Pull a vision model and an embedding model:

```bash
ollama pull qwen2.5vl        # or llava, minicpm-v, moondream, llama3.2-vision
ollama pull nomic-embed-text
```

Then allow the page to connect. Ollama rejects `Origin: null` unless told otherwise:

```bash
OLLAMA_ORIGINS='*' ollama serve
```

If Ollama runs as the macOS menu-bar app, set the variable for it and restart it:

```bash
launchctl setenv OLLAMA_ORIGINS '*'
```

Set the URL in *Settings* to `http://localhost:11434`. Ollama identifies vision models by
family, so they are recognised automatically.

To scan faster, Ollama needs `OLLAMA_NUM_PARALLEL` set; by default it handles one request at
a time, like most local servers.

[↑ Back to Index](#index)

---

## The browser

**Desktop Chrome or Edge.** PhotoSearch needs the File System Access API, which Firefox and
Safari do not implement. The app detects this on load and says so.

Open `PhotoSearch.html` by double-clicking it. No web server is needed.

### Serving it to other machines

Chrome and Edge offer the File System Access API only on a *secure context*: `https://`,
`http://localhost`, or a `file://` page. Open the page from another machine as
`http://192.168.x.x:8000/…` and the browser hides the folder picker, so the app reports
that it cannot run even though the browser is supported. The app now says so in that case.

- **Quick, one machine:** forward a port so the page is on `localhost`:
  `ssh -N -L 8000:localhost:8000 user@server`, then open `http://localhost:8000/PhotoSearch.html`.
- **Properly:** put HTTPS in front of the server with a certificate the browsers trust.
  Tailscale Serve (`tailscale serve --bg 8000`) gives a real certificate with no client setup.
  Caddy (`caddy reverse-proxy --from photos.home.arpa --to localhost:8000`) works on a LAN but
  each client must trust its root certificate once. Bind the file server to `127.0.0.1` and
  expose only the HTTPS front, and run it as a service so it survives a reboot.
- **LM Studio:** an HTTPS page cannot call a plain `http://` server on another host (mixed
  content). `http://localhost:1234` is allowed; for a remote one, put it behind the same HTTPS
  proxy and enable CORS.
- **Folders:** the picker browses the disk of the machine running the browser, so the photos
  and `.photoindex` must be mounted there (for example over SMB). Let only one machine write
  to the index at a time.

[↑ Back to Index](#index)

---

## First run

1. *Settings* → **Test connection**. The diagnostics panel names anything missing: server
   unreachable, CORS off, no vision model, no embedding model.
2. **Where to save the index.** The default is beside the photos. For a NAS library, choose a
   local folder instead: writes stay off the share, and search keeps working when the NAS is
   asleep.
3. **Choose folder** and pick your photos.
4. **Get place names.** This downloads a GeoNames extract once (about 17 MB) and caches it.
   Skip it and photos store raw coordinates instead.
5. *Scan* tab → **Refresh plan** → review the counts and ETA → **Scan new & changed**.
6. Open the *Library* tab to browse as photos arrive, and *People* to group faces once enough
   are indexed.

Set the embedding model **before** the first big scan. Adding one later means re-embedding
every record.

[↑ Back to Index](#index)

---

## What gets written

Only `.photoindex/`. Nothing else is ever touched, including when you remove photos from the
Library.

```
config.json      settings, the extraction schema, schema/prompt hashes
records.jsonl    one JSON object per photo, append-only
vectors.bin      float32 embeddings        vectors.json  id mapping
thumbs/<id>.jpg  384px thumbnails
faces/           face geometry, vectors and the names you gave people
runs.jsonl       one line per scan: timing, errors, models
state.json       resume checkpoint
geo/             cached place-name data
backups/         verified copies, pruned to a keep count
```

`.photoindex` is **hidden** on macOS because of the leading dot, and it sits inside your photo
folder (or the folder you chose under *Where to save the index*). To open it, press
**Cmd+Shift+.** in Finder to show hidden files, or run `open "/path/to/that/folder/.photoindex"`
in Terminal. How to find the right folder, and a description of each file, is in
[OPERATIONS.md](OPERATIONS.md#finding-your-index).

[↑ Back to Index](#index)

---

## Troubleshooting

**"Failed to fetch" on Test connection.** The server is off, or CORS is not enabled for this
page. Check the row for your server in [Choosing a server](#choosing-a-server).

**Every image fails with `model_not_found`.** No scan model is selected. The preflight check
catches this before a scan starts and names the fix.

**"File picker already active".** Chrome allows one dialog at a time, and on macOS the panel
process can outlive it:
```bash
pkill -9 -f openAndSavePanelService
```
If that finds nothing, quit Chrome entirely; a reload is not always enough.

**A button sits on "working…".** If the tab was hidden or occluded, this was a
`requestAnimationFrame` stall. It is fixed, but reload if you see it on an old build.

**A scan was interrupted.** Nothing is lost. The plan is the source of truth, so anything
without a record is found again. *Resume* appears when a checkpoint exists.

**The self-test says "SecurityError … certain files are unsafe".** Chrome does not give a page
opened from disk the private storage the self-test needs. It is not a problem with your photos.
See [Running the self-test in your own Chrome](TESTING.md#running-the-self-test-in-your-own-chrome).

**HEIC or TIFF fail.** Their decoders load from a CDN on first use. Offline, those files are
skipped and counted rather than failing the scan.

**The Library is empty.** It reads the index, so it needs a folder (or index location)
connected in Settings and at least one scanned photo. Photos you removed are in *Removed*,
not the main grid.

[↑ Back to Index](#index)
