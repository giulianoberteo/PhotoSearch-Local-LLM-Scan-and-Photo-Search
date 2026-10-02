#!/usr/bin/env python3
"""Assemble src/ into the single-file PhotoSearch.html.

The shipped file excludes the self-test suite; a second build, PhotoSearch.test.html,
includes it (open it with #selftest). Rarely used maintenance code is embedded as inert
text and run on first use (see LAZY below).

The whole point of the project is that the result is ONE file you can copy
anywhere and open. That is a terrible way to edit code, so the source lives in
src/js/*.js and this script concatenates it into src/shell.html.

  python3 build.py            # writes PhotoSearch.html
  python3 build.py --check    # verifies the committed file is up to date
  python3 build.py --min      # also-optional PhotoSearch.min.html (needs rjsmin, rcssmin)
"""
import json, re, subprocess, sys, pathlib

ROOT = pathlib.Path(__file__).parent
SRC = ROOT / "src"
OUT = ROOT / "PhotoSearch.html"
TEST_OUT = ROOT / "PhotoSearch.test.html"

# Order matters: later files depend on names defined earlier.
ORDER = [
    "00-core.js",     # helpers, state, settings persistence
    "00-core-ui.js",  # tabs, browser gate, check rows, storage speed, index operations
    "00-core-io.js",  # directory picker, model server client, model detection
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
    "70-runner-thumbs.js",  # LAZY: rebuilding thumbnails
    "70-runner-faces.js",   # LAZY: backfilling and refining faces
    "80-ui-connect.js",   # connection test, thinking probe, folder
    "80-ui-exclude.js",   # folders to leave out
    "80-ui-plan.js",      # plan UI
    "80-ui-scan.js",      # progress, scan buttons, moving the index
    "80-ui-settings.js",  # backups, geonames, settings wiring
    "85-chat.js",     # tool-calling agent
    "82-timeline.js", # browse by day
    "83-library.js",  # flat gallery of every photo + full-window viewer
    "84-faces-engine.js",  # engine adapter, alignment, ArcFace, vector maths
    "84-faces-store.js",   # face storage
    "84-faces-group.js",   # clustering, naming, merging, splitting
    "84-faces-detect.js",  # detecting, re-measuring, re-embedding
    "86-peopleui.js", # the People tab
    "87-chatui.js",   # chat rendering, lightbox
    "88-search.js",   # the header search field: suggestions, chips, results in the Library
    "88-searchui.js", # direct search, people/date/place filters and pagination
    "89-restore.js",  # keeps the chat and Library view across a page refresh
    "90-selftest.js", # TEST ONLY: in-browser test suite
    "91-consumer-selftest.js", # TEST ONLY: people corrections, direct retrieval, face recovery
    "95-faultfs.js",  # TEST ONLY: slow/hanging/failing filesystem proxy
    "99-boot.js",     # error surfacing, boot
]

# Present only in the test build (PhotoSearch.test.html), never in the shipped file.
TEST_ONLY = {"90-selftest.js", "91-consumer-selftest.js", "95-faultfs.js"}

# Loaded on first use in the shipped build: embedded in the page as inert text and run by
# loadModule(name) in 00-core.js. They must have no top-level statements that other code
# depends on at start-up; callers do `await loadModule(name)` before using them. The test
# build includes them eagerly, so the test suite can call them directly.
LAZY = {"maintenance": ["70-runner-thumbs.js", "70-runner-faces.js"]}
LAZY_FILES = {f for fs in LAZY.values() for f in fs}

# Stylesheets, in cascade order.
CSS_ORDER = ["10-base.css", "20-content.css", "30-viewer.css", "40-search.css",
             "45-selftest.css", "50-library.css"]
CSS_TEST_ONLY = {"45-selftest.css"}


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


def strip_markers(text: str, test: bool) -> str:
    """Keep or drop TEST-ONLY regions: <!--TEST-ONLY-->...<!--/TEST-ONLY--> and /*TEST-ONLY*/.../*/TEST-ONLY*/."""
    for start, end in (("<!--TEST-ONLY-->", "<!--/TEST-ONLY-->"), ("/*TEST-ONLY*/", "/*/TEST-ONLY*/")):
        if test:
            text = text.replace(start, "").replace(end, "")
        else:
            text = re.sub(re.escape(start) + r".*?" + re.escape(end), "", text, flags=re.S)
    return text


def module_text(name: str) -> str:
    body = gen_template() if name == "20-tpl.js" else (SRC / "js" / name).read_text()
    return f"\n/* ==================== {name} ==================== */\n" + body


def minify(html: str) -> str:
    """Optional --min: shrink the CSS and every script block with rjsmin/rcssmin.

    Needs `pip install rjsmin rcssmin` (use a virtualenv). Comments, blank lines and
    indentation go; the code is otherwise unchanged, so stack traces get harder to read.
    The readable build stays the default and is the one that is committed.
    """
    try:
        import rjsmin, rcssmin
    except ImportError:
        sys.exit("--min needs: pip install rjsmin rcssmin  (in a virtualenv)")
    html = re.sub(r"(<style>)(.*?)(</style>)",
                  lambda m: m.group(1) + rcssmin.cssmin(m.group(2)) + m.group(3), html, flags=re.S)
    return re.sub(r"(<script(?: [^>]*)?>)(.*?)(</script>)",
                  lambda m: m.group(1) + rjsmin.jsmin(m.group(2)) + m.group(3), html, flags=re.S)


def build(test: bool = False) -> str:
    parts = [module_text(n) for n in ORDER
             if (test or n not in TEST_ONLY) and (test or n not in LAZY_FILES)]
    lazy = ""
    if not test:
        for group, names in LAZY.items():
            text = "".join(module_text(n) for n in names)
            if "</script" in text.lower() or "<!--" in text:
                sys.exit(f"lazy group {group!r} contains </script or <!-- and cannot be embedded")
            lazy += f'<script type="text/plain" data-lazy="{group}">{text}</script>\n'
    css = "".join((SRC / "css" / n).read_text() for n in CSS_ORDER if test or n not in CSS_TEST_ONLY)
    shell = (SRC / "shell.html").read_text()
    for ph in ("__JS__", "__CSS__", "__LAZY__"):
        if ph not in shell:
            sys.exit(f"src/shell.html is missing the {ph} placeholder")
    shell = strip_markers(shell, test)
    js = strip_markers("".join(parts), test)
    return shell.replace("__CSS__", css.rstrip("\n")).replace("__LAZY__", lazy.rstrip("\n")).replace("__JS__", js)


def check_syntax(html: str) -> None:
    blocks = re.findall(r"<script(?: [^>]*)?>(.*?)</script>", html, re.S)
    if not blocks:
        sys.exit("no <script> block found")
    tmp = ROOT / ".build-check.mjs"
    try:
        for i, code in enumerate(blocks):
            tmp.write_text(code)
            r = subprocess.run(["node", "--check", str(tmp)], capture_output=True, text=True)
            if r.returncode:
                sys.exit(f"JS syntax error in script block {i}:\n" + r.stderr)
    except FileNotFoundError:
        print("node not found — the syntax check was skipped. Install it with: brew install node",
              file=sys.stderr)
    finally:
        tmp.unlink(missing_ok=True)


if __name__ == "__main__":
    if "--min" in sys.argv:
        out = ROOT / "PhotoSearch.min.html"
        min_html = minify(build())
        check_syntax(min_html)
        out.write_text(min_html)
        print(f"wrote {out.name}  ({len(min_html):,} bytes; optional, not committed)")
        sys.exit(0)
    html = build()
    test_html = build(test=True)
    check_syntax(html)
    check_syntax(test_html)
    if "--check" in sys.argv:
        current = OUT.read_text() if OUT.exists() else ""
        if current != html:
            sys.exit("PhotoSearch.html is out of date — run: python3 build.py")
        print("PhotoSearch.html is up to date")
    else:
        OUT.write_text(html)
        TEST_OUT.write_text(test_html)
        print(f"wrote {OUT.name}  ({len(html):,} bytes)")
        print(f"wrote {TEST_OUT.name}  ({len(test_html):,} bytes, includes the self-test suite; not committed)")
