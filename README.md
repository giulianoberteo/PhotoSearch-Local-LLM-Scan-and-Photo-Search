# PhotoSearch

**Search your own photo library in plain English, entirely on your own machine.**
One HTML file. No install, no server, no build step, no cloud.

PhotoSearch scans a folder of photos with a local vision model running in
[LM Studio](https://lmstudio.ai), builds a searchable index next to the photos, and lets
you talk to it: *"photos of children in a forest"*, *"anything from summer 2021"*,
*"where was the one with the boat taken?"*

Nothing leaves your computer. No API keys, no accounts, no telemetry.

```
┌── you ──────────┐      ┌── PhotoSearch.html ──────┐      ┌── LM Studio ────┐
│  pick a folder  │─────▶│  walk · decode · index   │─────▶│  vision model   │
│  ask a question │◀─────│  BM25 + vectors + tools  │◀─────│  chat model     │
└─────────────────┘      └──────────┬───────────────┘      └─────────────────┘
                                    ▼
                         .photoindex/  (plain JSONL + a float32 blob)
```

---

## Quick start

1. **Install [LM Studio](https://lmstudio.ai)** and download a vision model.
   `Qwen3.5-9B` is the reference model; any VLM works.
2. **Start its server with CORS enabled** — this is the step people miss:
   ```bash
   lms server start --cors --port 1234
   ```
   Or in the GUI: *Developer* tab → Status **Running** → tick **Enable CORS**.
3. **Open `PhotoSearch.html`** in desktop Chrome or Edge. Double-click it; `file://` is fine.
4. *Settings* → **Test connection** → **Choose folder** → *Scan* tab → **Refresh plan** → **Scan**.

Full detail, including running LM Studio on another machine: **[docs/SETUP.md](docs/SETUP.md)**.

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

Concurrency does not help: LM Studio serialises requests unless the model is loaded with
`--parallel`. Lowering the input resolution barely helps either — generation dominates.
A 100,000-photo library is a multi-week scan. Plan accordingly, and scan newest-first so the
index is useful on day one.

---

## Requirements

- **Desktop Chrome or Edge.** The File System Access API has no equivalent in Firefox or
  Safari; the app detects this and says so rather than half-working.
- **LM Studio** with a vision model, CORS enabled.
- **An embedding model** is optional but recommended — without one, search is keyword-only.

Formats: JPEG, PNG, WebP, GIF, BMP, AVIF natively; HEIC/HEIF via libheif; TIFF via UTIF.
RAW, video and vector files are counted and skipped.

---

## Status

Working software, used daily against a multi-terabyte NAS library. Rough edges remain — see
[issues](../../issues). Contributions welcome: **[CONTRIBUTING.md](CONTRIBUTING.md)**.

## Documentation

| | |
|---|---|
| [SETUP.md](docs/SETUP.md) | Installing, CORS, remote LM Studio, troubleshooting |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the index, search and agent actually work |
| [FINDINGS.md](docs/FINDINGS.md) | Measured results and hard-won LM Studio behaviour |
| [TESTING.md](docs/TESTING.md) | The self-test, and driving it headlessly |
| [OPERATIONS.md](docs/OPERATIONS.md) | Where every file lives, manual backup, slow-NAS notes |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Build, code style, how to propose changes |

## License

MIT — see [LICENSE](LICENSE).
