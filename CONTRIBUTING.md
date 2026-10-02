# Contributing

Contributions are welcome, bug reports especially. This is working software with rough
edges, and the edges are best found by people using it on libraries that are not mine.

## Index
<!-- index:start -->
- [Build](#build)
- [Test](#test)
- [Documentation](#documentation)
- [Style](#style)
- [What makes a good change](#what-makes-a-good-change)
- [Reporting a bug](#reporting-a-bug)
<!-- index:end -->

## Build

`PhotoSearch.html` is **generated**. Edit `src/`, never the built file.

```bash
python3 build.py            # writes PhotoSearch.html (shipped) and PhotoSearch.test.html (with the self-test suite)
python3 build.py --check    # verifies the committed file is current
python3 build.py --split    # multi-file PhotoSearch-split/ (index.html + js/ + css/), nothing inlined
python3 build.py --min      # optional PhotoSearch.min.html (pip install rjsmin rcssmin in a venv)
```

`build.py` concatenates `src/js/*.js` into `src/shell.html` in a fixed order (later files
depend on earlier ones, so a new file must be added to the list in `build.py`), then checks
the result with `node --check` if Node is installed. Without Node the check is skipped and the
build says so; `brew install node` fixes that, and is worth doing, because a syntax error in the
built page shows no message at all.

`src/template.py` is the **single source of truth** for the extraction schema and prompt.
The JavaScript constant is generated from it, so the app and any offline harness cannot drift.

Commit both your `src/` changes **and** the rebuilt `PhotoSearch.html`, because people
download that file directly. For a map of which source file does what, see
[Source layout](docs/ARCHITECTURE.md#source-layout).

[↑ Back to Index](#index)


## Test

```bash
python3 build.py && open PhotoSearch.test.html#selftest
```

Or run it headlessly; see [docs/TESTING.md](docs/TESTING.md). Run it twice if you touched
scanning, search or chat, because one green run can hide a race.

Add a test for anything you fix. The suite uses mock model responses and an OPFS scratch
folder, so it needs no model and touches nothing real.

[↑ Back to Index](#index)


## Documentation

The Markdown files each have an **Index** at the top and a "Back to Index" link at the end of
every section. These are generated from the headings, so after adding or renaming a heading
run:

```bash
python3 tools/doc_index.py            # rewrite the Index and links
python3 tools/doc_index.py --check    # fail if any file is out of date
```

When you change behaviour, update the doc that describes it in the same commit, and add an
entry to [ChangeLog.md](ChangeLog.md) (bumping `APP_VERSION` in `src/js/00-core.js` to match).

[↑ Back to Index](#index)


## Style

The code is plain ES2020 with no build tooling beyond concatenation. Match what is there:

- 2-space indent, semicolons, double quotes.
- **Comments explain *why*, not *what*.** `// increment i` is noise; "32 bits collide around
  77k items, which is well inside a real photo library" is worth its line.
- No framework, no bundler, and no new runtime dependency without a strong reason.
- External libraries load lazily from a **pinned** CDN version and degrade gracefully when
  offline. `libheif` and `UTIF` are the pattern to copy.

[↑ Back to Index](#index)


## What makes a good change

- **Measure it.** [docs/FINDINGS.md](docs/FINDINGS.md) is measurements, not opinions. If you
  claim something is faster or more accurate, say how you know.
- **Keep the one-file promise.** Anything that needs a server or a build step to *run* is out
  of scope.
- **Never modify anything outside `.photoindex/`.** Features that remove, hide or reorganise
  photos act on the index only.
- **Group, never identify.** Grouping faces by resemblance, with names that only the user
  supplies, is in scope. Recognising or naming a person, or inferring age, gender, emotion,
  ethnicity, religion or health, is not. The extraction prompt forbids it and a test asserts
  those fields never reach storage. This is not an oversight.
- **Assume the storage is hostile.** Network shares drop reads, timestamps get lost, and scans
  are interrupted after two days. Anything that cannot resume is not finished.

[↑ Back to Index](#index)


## Reporting a bug

Include what you did, what happened, your Chrome version, which model server and version you
use, the model, and whether the self-test passes. If a scan failed, `runs.jsonl` records the
error and `Settings → What's in it?` shows the index state.

Please do not paste personal photo paths or captions into issues.

[↑ Back to Index](#index)
