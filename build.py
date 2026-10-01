#!/usr/bin/env python3
"""Assemble src/ into the single-file PhotoSearch.html.

The whole point of the project is that the result is ONE file you can copy
anywhere and open. That is a terrible way to edit code, so the source lives in
src/js/*.js and this script concatenates it into src/shell.html.

  python3 build.py            # writes PhotoSearch.html
  python3 build.py --check    # verifies the committed file is up to date
"""
import json, re, subprocess, sys, pathlib

ROOT = pathlib.Path(__file__).parent
SRC = ROOT / "src"
OUT = ROOT / "PhotoSearch.html"

# Order matters: later files depend on names defined earlier.
ORDER = [
    "00-core.js",     # helpers, state, settings, LM Studio client, pickers
    "20-tpl.js",      # GENERATED from src/template.py by gen_template()
    "25-datetime.js", # occasions, seasons, Easter
    "26-geo.js",      # offline place names
    "30-worker.js",   # decode/resize worker, format policy
    "35-exif.js",     # dating, confidence, overrides
    "40-store.js",    # .photoindex: records, vectors, thumbs, checkpoint
    "42-backup.js",   # backup + restore
    "45-plan.js",     # walk, identity matching, the plan
    "50-validate.js", # normalisation, image_type correction
    "55-extract.js",  # vision extraction, OCR pass, embeddings
    "60-derived.js",  # entities, events, inverted index
    "65-search.js",   # BM25 + cosine + RRF
    "70-runner.js",   # the scan runner
    "80-ui.js",       # settings and scan UI
    "85-chat.js",     # tool-calling agent
    "82-timeline.js", # browse by day
    "83-library.js",  # flat gallery of every photo + full-window viewer
    "84-faces.js",    # face detection, grouping, naming
    "86-peopleui.js", # the People tab
    "87-chatui.js",   # chat rendering, lightbox
    "88-search.js",   # the header search field: suggestions, chips, results in the Library
    "90-selftest.js", # in-browser test suite
    "95-faultfs.js",  # test-only: slow/hanging/failing filesystem proxy
    "99-boot.js",     # error surfacing, boot
]


def gen_template() -> str:
    """src/template.py is the single source of truth for the extraction schema.

    The same schema and prompt must be used by the app and by any offline
    harness, so the JS constant is generated rather than duplicated by hand.
    """
    sys.path.insert(0, str(SRC))
    import template  # noqa: E402
    js = "const TPL = {\n"
    js += "  version: %s,\n" % json.dumps(template.TEMPLATE_VERSION)
    js += "  enums: %s,\n" % json.dumps(template.ENUMS, ensure_ascii=False)
    js += "  schema: %s,\n" % json.dumps(template.SCHEMA, ensure_ascii=False)
    js += "  system: %s,\n" % json.dumps(template.SYSTEM, ensure_ascii=False)
    js += "  user: %s\n};\n" % json.dumps(template.USER, ensure_ascii=False)
    return js + (SRC / "js" / "_hashes.js").read_text()


def build() -> str:
    parts = []
    for name in ORDER:
        body = gen_template() if name == "20-tpl.js" else (SRC / "js" / name).read_text()
        parts.append(f"\n/* ==================== {name} ==================== */\n")
        parts.append(body)
    shell = (SRC / "shell.html").read_text()
    if "__JS__" not in shell:
        sys.exit("src/shell.html is missing the __JS__ placeholder")
    return shell.replace("__JS__", "".join(parts))


def check_syntax(html: str) -> None:
    m = re.search(r"<script>(.*)</script>", html, re.S)
    if not m:
        sys.exit("no <script> block found")
    tmp = ROOT / ".build-check.mjs"
    tmp.write_text(m.group(1))
    try:
        r = subprocess.run(["node", "--check", str(tmp)], capture_output=True, text=True)
        if r.returncode:
            sys.exit("JS syntax error:\n" + r.stderr)
    except FileNotFoundError:
        print("node not found — skipping the syntax check", file=sys.stderr)
    finally:
        tmp.unlink(missing_ok=True)


if __name__ == "__main__":
    html = build()
    check_syntax(html)
    if "--check" in sys.argv:
        current = OUT.read_text() if OUT.exists() else ""
        if current != html:
            sys.exit("PhotoSearch.html is out of date — run: python3 build.py")
        print("PhotoSearch.html is up to date")
    else:
        OUT.write_text(html)
        print(f"wrote {OUT.name}  ({len(html):,} bytes)")
