# PhotoSearch

**Search your own photo library in plain English, entirely on your own machine.**
One HTML file. No install, no server, no build step, no cloud.

PhotoSearch scans a folder of photos with a local vision model, builds a searchable index
next to the photos, and lets you talk to it: *"photos of children in a forest"*, *"anything
from summer 2021"*, *"where was the one with the boat taken?"*

It works with **any local server that speaks the OpenAI API** —
[LM Studio](https://lmstudio.ai), [Ollama](https://ollama.com), llama.cpp's server,
vLLM, LocalAI. You point it at a URL and pick your models; nothing is specific to one
product.

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

## Quick start

You need a **vision model** (to describe photos) and ideally an **embedding model** (for
meaning-based search). Pick whichever server you already use.

### With LM Studio

1. Download a vision model — `Qwen3.5-VL` is the reference; any VLM works. Add an
   embedding model such as `nomic-embed-text` for semantic search.
2. **Start the server with CORS enabled** — the step people miss:
   ```bash
   lms server start --cors --port 1234
   ```
   Or: *Developer* tab → Status **Running** → tick **Enable CORS**.
3. URL in Settings: `http://localhost:1234`

### With Ollama

1. Pull a vision model and an embedding model:
   ```bash
   ollama pull qwen2.5vl        # or llava, minicpm-v, moondream, llama3.2-vision
   ollama pull nomic-embed-text
   ```
2. **Allow this page to talk to it.** A page opened from a file sends `Origin: null`,
   which Ollama rejects by default:
   ```bash
   OLLAMA_ORIGINS='*' ollama serve
   ```
   On macOS, if Ollama runs as the menu-bar app:
   ```bash
   launchctl setenv OLLAMA_ORIGINS '*'      # then quit and reopen Ollama
   ```
3. URL in Settings: `http://localhost:11434`

### Then, whichever you chose

4. **Open `PhotoSearch.html`** in desktop Chrome or Edge. Double-click it; `file://` is fine.
5. *Settings* → **Test connection** → **Choose folder** → *Scan* tab → **Refresh plan** → **Scan**.

**Test connection** tells you what it found: which server, which models, whether types could
be detected, and — importantly — whether your server can enforce a **JSON schema**. See
[Why structured output matters](#why-structured-output-matters) below.

Full detail, including running the server on another machine: **[docs/SETUP.md](docs/SETUP.md)**.

---

## Why structured output matters

This is the one place where servers genuinely differ, so **Test connection** probes it and
tells you which of three contracts you have:

| what your server supports | what happens |
|---|---|
| **JSON schema** (LM Studio, recent Ollama, vLLM) | Best. Constrained decoding also stops a reasoning model thinking out loud: **13 output tokens instead of 799** on the same prompt. |
| **JSON only**, no schema | Works. More tokens, more repair, occasional retries. |
| **neither** | Answers are parsed out of prose; some photos will fail. |

Nothing to configure — it is detected and adapted to. It is simply worth knowing that a
server with schema support scans faster and cheaper, which is why `response_format` is the
first thing checked.

---

## Choosing models

If your server reports model types (LM Studio) or families (Ollama), the right models are
detected. Otherwise types are guessed from the name and you can correct them under
*Settings → Model roles* — the dropdowns list every model, so a vision model that was not
recognised can always be chosen by hand.

| role | what it is for | examples |
|---|---|---|
| **Scan (vision)** | describing every photo | Qwen3.5-VL, Gemma 3, llava, minicpm-v, moondream, Pixtral |
| **Embeddings** | meaning-based search | nomic-embed-text, bge-m3, mxbai-embed-large |
| **Chat agent** | answering questions over the index | any decent instruct model |

Face grouping needs **no server at all** — it runs in the browser (see
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)).

---

## What it does

**Scanning.** Walks a folder, decodes each image in a Web Worker, and asks the vision model
to fill a fixed JSON schema — observations first, caption last, "unknown" preferred over a
guess. Reads EXIF for dates, camera and GPS. Resolves GPS to place names from an offline
GeoNames extract. Writes everything to `.photoindex/` beside your photos.

**Searching.** BM25 over an inverted index, cosine similarity over embeddings, merged with
reciprocal rank fusion. Exact phrases in `"quotes"`. All of it in the browser — there is no
vector database.

**Chatting.** A tool-calling agent with eight tools over the index (`search_photos`,
`find_similar`, `list_events`, `look_at_photos`, …). Answers stream in with a grid of
matching thumbnails; click one for the full image and its metadata. Models without tool
support fall back to retrieve-then-answer automatically.

**Surviving reality.** Resumable scans with a checkpoint, retries for flaky network shares,
move detection so reorganising folders costs nothing, per-run backups with verified restore,
and a 170-assertion self-test you can run in your own browser.

---

## Design decisions worth knowing

**One file.** `PhotoSearch.html` is ~240 KB with everything inline. Copy it to any machine
and it works. Source lives in `src/` and is assembled by `build.py` — see
[CONTRIBUTING.md](CONTRIBUTING.md).

**The index is plain text.** `records.jsonl` is one JSON object per line. `grep` it, diff it,
process it with anything. No proprietary format, no lock-in.

**Structured output suppresses "thinking".** Reasoning models burn hundreds of tokens
planning before answering. Sending a JSON schema in `response_format` constrains generation
from the first token, so no reasoning pass happens: **799 tokens → 13** on the reference
model. This single trick is what makes scanning viable. The catch, and the OCR workaround
it required, are in [docs/FINDINGS.md](docs/FINDINGS.md).

**EXIF dates are not trusted blindly.** Exported and AI-generated files routinely carry the
*processing* time in every date field. Records store `date_source` and `date_confidence`,
and flag `date_suspect` when a date has no camera tags behind it.

**Photos are identified by content, not by path.** Scan a subfolder today and the whole
library tomorrow — one index either way, no duplicates, nothing wrongly marked missing.

**No faces, no identities.** The extraction prompt forbids naming or identifying people, and
guessing ethnicity, religion or health. People are described only by age group, clothing and
action. This is a deliberate divergence from commercial photo managers.

---

## What it costs

Measured on an M-series Mac, `Qwen3.5-9B` (MLX 4-bit), 1024px input:

| | |
|---|---|
| **~21.5 s** | per photo, end to end |
| ~400 tokens | generated per photo |
| ~4,000 photos | per day, unattended |
| ~5 KB | index per photo (plus a 384px thumbnail) |

Concurrency does not help: most local servers process one request at a time unless
explicitly configured otherwise (LM Studio needs `--parallel`; Ollama needs
`OLLAMA_NUM_PARALLEL`). Lowering the input resolution barely helps either — generation
dominates.
A 100,000-photo library is a multi-week scan. Plan accordingly, and scan newest-first so the
index is useful on day one.

---

## Requirements

- **Desktop Chrome or Edge.** The File System Access API has no equivalent in Firefox or
  Safari; the app detects this and says so rather than half-working.
- **Any local server that speaks the OpenAI API**, with a vision model loaded and CORS
  allowed for this page. LM Studio, Ollama, llama.cpp's server, vLLM and LocalAI all work;
  the URL and the model names are the only things that differ.
- **An embedding model** is optional but recommended — without one, search is keyword-only.
- **Nothing** for face grouping: the detector and the recognition model run in the browser.

Formats: JPEG, PNG, WebP, GIF, BMP, AVIF natively; HEIC/HEIF via libheif; TIFF via UTIF.
RAW, video and vector files are counted and skipped.

---

## Status

Working software, used daily against a multi-terabyte NAS library. Rough edges remain — see
[issues](../../issues). Contributions welcome: **[CONTRIBUTING.md](CONTRIBUTING.md)**.

## Documentation

| | |
|---|---|
| [SETUP.md](docs/SETUP.md) | Installing, CORS, Ollama, remote servers, troubleshooting |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the index, search and agent actually work |
| [FINDINGS.md](docs/FINDINGS.md) | Measured results, and model-server behaviour that cost time to find |
| [TESTING.md](docs/TESTING.md) | The self-test, and driving it headlessly |
| [OPERATIONS.md](docs/OPERATIONS.md) | Where every file lives, manual backup, slow-NAS notes |
| [ROADMAP.md](docs/ROADMAP.md) | What is missing next — people, video, timeline — and what each costs |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Build, code style, how to propose changes |

## License

MIT — see [LICENSE](LICENSE).
