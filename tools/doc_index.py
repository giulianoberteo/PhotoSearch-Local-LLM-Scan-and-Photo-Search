#!/usr/bin/env python3
"""Keep the Index and the "Back to Index" links in the docs in sync with their headings.

Every Markdown file listed below gets:

  * an "## Index" section (between <!-- index:start --> and <!-- index:end -->) listing
    every "##" and "###" heading as a link, and
  * a "[↑ Back to Index](#index)" link at the end of every "##" section.

Edit headings freely, then run:

  python3 tools/doc_index.py            # rewrite the files
  python3 tools/doc_index.py --check    # exit 1 if any file is out of date
"""
import pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
FILES = [ROOT / "README.md", ROOT / "CONTRIBUTING.md", ROOT / "ChangeLog.md"] + sorted((ROOT / "docs").glob("*.md"))
LINK = "[↑ Back to Index](#index)"
START, END = "<!-- index:start -->", "<!-- index:end -->"


def slug(title, seen):
    """GitHub's anchor rule: lowercase, drop punctuation, spaces become hyphens."""
    s = re.sub(r"[^\w\- ]", "", title.lower().replace("`", "")).replace(" ", "-")
    n = seen.get(s, 0)
    seen[s] = n + 1
    return s if n == 0 else "%s-%d" % (s, n)


def headings(lines):
    """(line number, level, title) for ## and ### headings outside code fences."""
    out, fence = [], False
    for i, ln in enumerate(lines):
        if ln.lstrip().startswith("```"):
            fence = not fence
        m = None if fence else re.match(r"^(#{2,3}) (.+?)\s*$", ln)
        if m:
            out.append((i, len(m.group(1)), m.group(2)))
    return out


def render(text):
    lines = [l for l in text.split("\n") if l.strip() != LINK]

    # Drop any previous index body, keeping the heading and markers if present.
    if START in lines and END in lines:
        a, b = lines.index(START), lines.index(END)
        lines[a + 1:b] = []
    else:
        # An "## Index" heading already written by hand must be ADOPTED, not
        # duplicated. Searching for the first heading that is not named Index
        # lands the insertion point just after it, which is how four files in
        # the upstream fork came to carry two consecutive "## Index" headings.
        # --check cannot notice, because it is a fixed-point test: once the
        # duplicate exists, rendering is stable forever.
        existing = next((h for h in headings(lines) if h[2] == "Index" and h[1] == 2), None)
        if existing:
            lines[existing[0] + 1:existing[0] + 1] = [START, END, ""]
        else:
            first = next((h for h in headings(lines) if h[2] != "Index"), None)
            at = first[0] if first else len(lines)
            lines[at:at] = ["## Index", START, END, ""]

    hs = [h for h in headings(lines) if h[2] != "Index"]
    seen = {"index": 1}
    body = []
    for _, level, title in hs:
        body.append("%s- [%s](#%s)" % ("  " * (level - 2), title.replace("`", ""), slug(title, seen)))
    a = lines.index(START)
    lines[a + 1:a + 1] = body

    # A back link at the end of every "##" section, above a trailing "---" rule if any.
    fence, starts = False, []
    for i, l in enumerate(lines):
        if l.lstrip().startswith("```"):
            fence = not fence
        if not fence and l.startswith("## "):
            starts.append(i)
    out = lines[:starts[0]] if starts else lines
    for n, s in enumerate(starts):
        e = starts[n + 1] if n + 1 < len(starts) else len(lines)
        sec = lines[s:e]
        if sec[0] != "## Index":
            while sec and not sec[-1].strip():
                sec.pop()
            rule = bool(sec) and sec[-1].strip() == "---"
            if rule:
                sec.pop()
                while sec and not sec[-1].strip():
                    sec.pop()
            sec += ["", LINK, ""] + (["---", ""] if rule else [""])
        else:
            while sec and not sec[-1].strip():
                sec.pop()
            sec.append("")
        out += sec
    while out and not out[-1].strip():
        out.pop()
    return "\n".join(out) + "\n"


def main():
    check = "--check" in sys.argv
    stale = []
    for f in FILES:
        if not f.exists():
            # Governed-but-absent is a normal state (a repo may not have a
            # ChangeLog yet). Say so and carry on rather than dying.
            print("skipped (missing): %s" % f.relative_to(ROOT))
            continue
        old = f.read_text()
        new = render(old)
        if new != old:
            stale.append(f.relative_to(ROOT))
            if not check:
                f.write_text(new)
    if check and stale:
        print("out of date:", *stale)
        sys.exit(1)
    print("docs index " + ("is current" if check else "updated: %d file(s) changed" % len(stale)))


if __name__ == "__main__":
    main()
