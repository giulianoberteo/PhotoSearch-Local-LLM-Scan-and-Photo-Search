# PhotoSearch

**Search your own photo library in plain English, entirely on your own machine.**
One HTML file. No install, no server, no build step, no cloud.

PhotoSearch scans a folder of photos with a local vision model, builds a searchable index
next to the photos, and lets you browse it or talk to it: *"photos of children in a
forest"*, *"anything from summer 2021"*, *"where was the one with the boat taken?"*

It works with **any local server that speaks the OpenAI API**:
[LM Studio](https://lmstudio.ai), [Ollama](https://ollama.com), llama.cpp's server, vLLM
and LocalAI. You point it at a URL and pick your models; nothing is specific to one product.

Nothing leaves your computer. No API keys, no accounts, no telemetry.

```
┌── you ──────────┐      ┌── PhotoSearch.html ──────┐      ┌── your model server ─┐
│  pick a folder  │─────▶│  walk · decode · index   │─────▶│  vision model        │
│  ask a question │◀─────│  BM25 + vectors + tools  │◀─────│  chat · embeddings   │
└─────────────────┘      └──────────┬───────────────┘      └──────────────────────┘
                                    ▼                       LM Studio · Ollama ·
                         .photoindex/                       llama.cpp · vLLM · …
                         (plain JSONL + a float32 blob)
```

---

## Index
<!-- index:start -->
- [Quick start](#quick-start)
  - [With LM Studio](#with-lm-studio)
  - [With Ollama](#with-ollama)
  - [Then, whichever you chose](#then-whichever-you-chose)
- [Why structured output matters](#why-structured-output-matters)
- [Choosing models](#choosing-models)
- [What it does](#what-it-does)
- [Using the app](#using-the-app)
- [Design decisions worth knowing](#design-decisions-worth-knowing)
- [What it costs](#what-it-costs)
- [Requirements](#requirements)
- [Status](#status)
- [Documentation](#documentation)
- [License](#license)
<!-- index:end -->

## Quick start

You need a **vision model** (to describe photos) and ideally an **embedding model** (for
meaning-based search). Use whichever server you already have.

### With LM Studio

1. Download a vision model. `Qwen3.5-VL` is the reference, but any VLM works. Add an
   embedding model such as `nomic-embed-text` for semantic search.
2. **Start the server with CORS enabled.** This is the step people miss:
   ```bash
   lms server start --cors --port 1234
   ```
   Or in the app: *Developer* tab → Status **Running** → tick **Enable CORS**.
3. The URL to use in Settings is `http://localhost:1234`.

### With Ollama

1. Pull a vision model and an embedding model:
   ```bash
   ollama pull qwen2.5vl        # or llava, minicpm-v, moondream, llama3.2-vision
   ollama pull nomic-embed-text
   ```
2. **Allow this page to talk to it.** A page opened from a file sends `Origin: null`, which
   Ollama rejects by default:
   ```bash
   OLLAMA_ORIGINS='*' ollama serve
   ```
   If Ollama runs as the macOS menu-bar app instead:
   ```bash
   launchctl setenv OLLAMA_ORIGINS '*'      # then quit and reopen Ollama
   ```
3. The URL to use in Settings is `http://localhost:11434`.

### Then, whichever you chose

4. **Open `PhotoSearch.html`** in desktop Chrome or Edge. Double-click it; `file://` is fine.
5. Go to *Settings* → **Test connection** → **Choose folder**, then *Scan* → **Refresh plan**
   → **Scan**. Browse the results in *Library* while it runs.

**Test connection** reports what it found: which server, which models, whether model types
could be detected and, importantly, whether your server can enforce a **JSON schema**. See
[Why structured output matters](#why-structured-output-matters).

Full detail, including running the server on another machine, is in
**[docs/SETUP.md](docs/SETUP.md)**.

[↑ Back to Index](#index)

---

## Why structured output matters

This is the one place where servers genuinely differ, so **Test connection** probes it and
tells you which of three contracts you have:

| what your server supports | what happens |
|---|---|
| **JSON schema** (LM Studio, recent Ollama, vLLM) | Best. Constrained decoding also stops a reasoning model from thinking out loud: **13 output tokens instead of 799** on the same prompt. |
| **JSON only**, no schema | Works, with more tokens, more repair and occasional retries. |
| **Neither** | Answers are parsed out of prose, and some photos will fail. |

There is nothing to configure: the app detects the contract and adapts. It is worth knowing
only because a server with schema support scans faster and cheaper.

[↑ Back to Index](#index)

---

## Choosing models

If your server reports model types (LM Studio) or families (Ollama), the right models are
detected automatically. Otherwise types are guessed from the name, and you can correct them
under *Settings → Model roles*. The dropdowns list every model, so a vision model that was
not recognised can always be chosen by hand.

| role | what it is for | examples |
|---|---|---|
| **Scan (vision)** | describing every photo | Qwen3.5-VL, Gemma 3, llava, minicpm-v, moondream, Pixtral |
| **Embeddings** | meaning-based search | nomic-embed-text, bge-m3, mxbai-embed-large |
| **Chat agent** | answering questions over the index | any decent instruct model |

Face grouping needs **no server at all**: it runs in the browser (see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#faces)).

[↑ Back to Index](#index)

---

## What it does

**Scanning.** Walks a folder, decodes each image in a Web Worker, and asks the vision model
to fill a fixed JSON schema: observations first, caption last, "unknown" preferred over a
guess. Reads EXIF for dates, camera and GPS, and resolves GPS to place names from an offline
GeoNames extract. Everything is written to `.photoindex/` beside your photos.

**Browsing.** The *Library* tab shows every photo in one zoomable grid. Click one and it
opens full-window, growing out of its tile, with arrow-key stepping and a details panel. The
*Timeline* tab groups photos by day, with places and occasions in the headings.

**Searching.** BM25 over an inverted index and cosine similarity over embeddings, merged with
reciprocal rank fusion. Exact phrases go in `"quotes"`. It all happens in the browser; there
is no vector database.

**Chatting.** A tool-calling agent with nine tools over the index (`search_photos`,
`find_similar`, `list_people`, `list_events`, `look_at_photos` and others). Answers stream in
with a grid of matching thumbnails; click one for the full image and its metadata. Models
without tool support fall back to retrieve-then-answer automatically.

**People.** Faces are detected and grouped *by resemblance*, in the browser. Groups stay
anonymous until you name them, and names then work in search and chat.

**Tidying.** Photos can be removed from the library, one at a time from the viewer or many in
Select mode, with an Undo and a *Removed* list to restore from. This only hides them in the
index: **your files are never touched.**

**Surviving reality.** Resumable scans with a checkpoint, retries for flaky network shares,
move detection so reorganising folders costs nothing, per-run backups with verified restore,
and a self-test of about 500 assertions you can run in your own browser.

[↑ Back to Index](#index)

---

## Using the app

| tab | what it is for |
|---|---|
| **Library** | Every photo in one grid. Drag the **Size** slider to change density. Click a photo to open it; `←` `→` step through, `I` shows details, `Esc` closes. **Select** enables multi-select (click, shift-click for a range, `⌘/Ctrl+A`), then **Remove**. **Removed (N)** lists what you hid so you can **Restore** it. |
| **Chat** | Ask about your photos in plain language. Shows which tools the model used and the photos it found. |
| **Timeline** | Browse by day, newest first, with a year bar and a date picker. |
| **People** | Find faces, group them, name them, merge and split groups. |
| **Scan** | The plan (what is new, changed, failed or missing), progress, retry, backups, thumbnail rebuild. |
| **Settings** | Server URL and connection test, model roles, folder and index location, scan and date settings, backups, the self-test. |

[↑ Back to Index](#index)

---

## Design decisions worth knowing

**One file.** `PhotoSearch.html` is about 530 KB with everything inline. Copy it to any
machine and it works. The source lives in `src/` and is assembled by `build.py`; see
[CONTRIBUTING.md](CONTRIBUTING.md).

**The index is plain text.** `records.jsonl` is one JSON object per line. You can `grep` it,
diff it or process it with anything. There is no proprietary format and no lock-in.

**Structured output suppresses "thinking".** Reasoning models burn hundreds of tokens
planning before they answer. Sending a JSON schema in `response_format` constrains
generation from the first token, so no reasoning pass happens: **799 tokens → 13** on the
reference model. This one trick is what makes scanning viable. The catch, and the OCR
workaround it required, are in [docs/FINDINGS.md](docs/FINDINGS.md).

**EXIF dates are not trusted blindly.** Exported and AI-generated files routinely carry the
*processing* time in every date field. Records store `date_source` and `date_confidence`, and
flag `date_suspect` when a date has no camera tags behind it.

**Photos are identified by content, not by path.** Scan a subfolder today and the whole
library tomorrow: one index either way, no duplicates, nothing wrongly marked missing.

**People are grouped, never identified.** The extraction prompt forbids naming people or
guessing ethnicity, religion or health, and describes them only by age group, clothing and
action. Face grouping works the same way: it clusters faces that *look alike*, and every name
comes from you. Age, gender and emotion estimates are discarded at the boundary and a test
asserts they never reach storage. This is a deliberate divergence from commercial photo
managers.

**Removing is hiding.** The app never modifies anything outside `.photoindex/`, so
"remove" means "hide from the index", and it is always reversible.

[↑ Back to Index](#index)

---

## What it costs

Measured on an M-series Mac with `Qwen3.5-9B` (MLX 4-bit) and 1024px input:

| | |
|---|---|
| **~21.5 s** | per photo, end to end |
| ~400 tokens | generated per photo |
| ~4,000 photos | per day, unattended |
| ~5 KB | index per photo (plus a 384px thumbnail) |

Concurrency does not help. Most local servers process one request at a time unless told
otherwise (LM Studio needs `--parallel`; Ollama needs `OLLAMA_NUM_PARALLEL`). Lowering the
input resolution barely helps either, because generation dominates. A 100,000-photo library
is a multi-week scan, so plan accordingly and scan newest-first, which makes the index
useful on day one.

[↑ Back to Index](#index)

---

## Requirements

- **Desktop Chrome or Edge.** The File System Access API has no equivalent in Firefox or
  Safari. The app detects this and says so rather than half-working.
- **A local server that speaks the OpenAI API**, with a vision model loaded and CORS allowed
  for this page. LM Studio, Ollama, llama.cpp's server, vLLM and LocalAI all work; only the
  URL and the model names differ.
- **An embedding model** is optional but recommended. Without one, search is keyword-only.
- **Nothing** for face grouping: the detector and recognition model run in the browser.

Formats: JPEG, PNG, WebP, GIF, BMP and AVIF natively; HEIC/HEIF via libheif; TIFF via UTIF.
RAW, video and vector files are counted and skipped.

[↑ Back to Index](#index)

---

## Status

Working software, used daily against a multi-terabyte NAS library. Rough edges remain; see
[issues](../../issues). Contributions are welcome: **[CONTRIBUTING.md](CONTRIBUTING.md)**.

[↑ Back to Index](#index)

---

## Documentation

| | |
|---|---|
| [SETUP.md](docs/SETUP.md) | Installing, CORS, Ollama, remote servers, troubleshooting |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the index, search, Library and agent actually work |
| [FINDINGS.md](docs/FINDINGS.md) | Measured results, and server behaviour that cost time to find |
| [TESTING.md](docs/TESTING.md) | The self-test, and driving it headlessly |
| [OPERATIONS.md](docs/OPERATIONS.md) | Where every file lives, manual backup, slow-NAS notes |
| [ROADMAP.md](docs/ROADMAP.md) | What is built, what is missing next, and what each costs |
| [ChangeLog.md](ChangeLog.md) | What changed in each version |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Build, code style, how to propose changes |

[↑ Back to Index](#index)

---

## License

MIT, see [LICENSE](LICENSE).

[↑ Back to Index](#index)
