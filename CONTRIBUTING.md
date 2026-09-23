# Contributing

Contributions are welcome — bug reports especially. This is working software with rough
edges, and the edges are best found by people using it on libraries that are not mine.

## Build

`PhotoSearch.html` is **generated**. Edit `src/`, never the built file.

```bash
python3 build.py            # writes PhotoSearch.html
python3 build.py --check    # verifies the committed file is current
```

`build.py` concatenates `src/js/*.js` into `src/shell.html` in a fixed order (later files
depend on earlier ones) and checks the result with `node --check`.

`src/template.py` is the **single source of truth** for the extraction schema and prompt;
the JS constant is generated from it so the app and any offline harness cannot drift.

Commit both your `src/` changes **and** the rebuilt `PhotoSearch.html` — people download
that file directly.

## Test

```bash
python3 build.py && open PhotoSearch.html#selftest
```

Or headlessly — see [docs/TESTING.md](docs/TESTING.md). Run it twice if you touched
scanning, search or chat; one green run can hide a race.

Add a test for anything you fix. The suite uses mock model responses and an OPFS scratch
folder, so it needs no model and touches nothing real.

## Style

The code is plain ES2020 with no build tooling beyond concatenation. Match what is there:

- 2-space indent, semicolons, double quotes
- **comments explain *why*, not *what*.** `// increment i` is noise; "32 bits collide around
  77k items, which is well inside a real photo library" is worth its line
- no framework, no bundler, no new runtime dependency without a strong reason
- external libraries load lazily from a **pinned** CDN version and degrade gracefully when
  offline — `libheif` and `UTIF` are the pattern to copy

## What makes a good change

- **Measure it.** [docs/FINDINGS.md](docs/FINDINGS.md) is measurements, not opinions. If you
  claim something is faster or more accurate, say how you know.
- **Keep the one-file promise.** Anything requiring a server or a build step to *run* is out
  of scope.
- **Do not add identity recognition.** Faces, names, ethnicity and health are deliberately
  out of scope, and the extraction prompt forbids them. This is not an oversight.
- **Assume the storage is hostile.** Network shares drop reads, timestamps get lost, scans
  are interrupted after two days. Anything that cannot resume is not finished.

## Reporting a bug

Include: what you did, what happened, Chrome and LM Studio versions, the model, and whether
the self-test passes. If a scan failed, `runs.jsonl` records the error and
`Settings → What's in it?` shows the index state.

Please do not paste personal photo paths or captions into issues.
