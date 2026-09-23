# Testing

## The self-test

Open `PhotoSearch.html#selftest` and the suite runs automatically, or press **Run self-test**
in *Settings → Diagnostics*. It takes about 60 seconds and needs no model: it uses mock
responses and an [OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)
scratch folder, so your real photos and index are never touched.

~170 assertions covering:

- pure logic — Easter/occasion dates, singularisation, validation caps, enum checks
- `image_type` correction from filename, EXIF, dimensions and caption
- the decode worker — resizing, thumbnails, format policy
- the index — append, reload, compaction, vectors appended a row at a time
- **identity matching** — scan a subfolder then the library root; same filename in two
  folders stays two photos; a forged name/size/mtime collision is rejected by content
- **crash safety** — the plan finds exactly the missing work when a record is lost
- **backup and restore** — including genuinely corrupting `records.jsonl` on disk
- search — BM25, filters, phrases, the relevance floor
- chat — history trimming, and that model output can never inject HTML
- UI invariants — nothing marked `hidden` is actually visible

A real HEIC decode is skipped unless you supply a sample:

```
PhotoSearch.html#selftest&heic=file:///path/to/sample.heic
```

## Running it headlessly

`tools/selftest-runner.mjs` drives Chrome over the DevTools protocol and exits non-zero on
failure. Node 22+ (it uses the global `WebSocket`).

```bash
rm -rf /tmp/chrome-selftest
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --no-sandbox \
  --user-data-dir=/tmp/chrome-selftest --remote-debugging-port=9222 \
  --allow-file-access-from-files about:blank &

node tools/selftest-runner.mjs \
  "file://$PWD/PhotoSearch.html#selftest" "window.__selftest" 180000
```

`--allow-file-access-from-files` is required: without it OPFS is unavailable from `file://`
and the suite cannot create its scratch folder.

**`--dump-dom` does not work** for this. It fires at load, before any async work, and
`--virtual-time-budget` stalls indefinitely on IndexedDB and OPFS. Drive it over CDP.

## Things worth knowing when writing tests

- **Absence of `FAIL` is not a pass.** Grep for `EXCEPTION` and `TIMEOUT` too — a suite that
  died on a syntax error prints no failures at all.
- **Headless has no file dialogs**, so picker behaviour cannot be tested that way.
- **OPFS does not preserve `lastModified`**, which usefully reproduces a NAS copy that loses
  its timestamp — the case the name+size matching tier exists for.
- Tests share one scratch folder and run in order; clean up what you create.

## Verifying a build

```bash
python3 build.py --check    # fails if PhotoSearch.html is out of date
```

Run the self-test before proposing a change. If you touched scanning, search or chat, run it
twice — a single green run can hide a race.
