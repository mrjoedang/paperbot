#!/usr/bin/env python3
"""Rename pocketbot to paperbot across the repo, by rules. Dry run unless --apply.

Every occurrence of pocketbot (any case, also pocket-bot / pocket_bot) in a tracked text file must match a rule in
rules.py: `rename` (pocketbot -> paperbot, case kept) or `keep` (with the reason it must not change yet). An occurrence
no rule matches is UNCLASSIFIED: it's listed, the exit code is 1, and --apply refuses. Rules are checked in order;
the first whose pattern covers the occurrence wins.

  python3 tools/rename/rename.py                 # summary: each rule, its count and files; unclassified listed
  python3 tools/rename/rename.py --rule ID       # every occurrence a rule took (file:line, the match in [brackets])
  python3 tools/rename/rename.py --file PATH     # every occurrence in files under PATH, with the rule that took it
  python3 tools/rename/rename.py --diff          # the unified diff --apply would write (add --rule / --file to narrow)
  python3 tools/rename/rename.py --json OUT      # the whole audit as JSON
  python3 tools/rename/rename.py --apply         # write the renames and git mv the renamed paths
  python3 tools/rename/rename.py --check         # each rule's examples classify to that rule (run after editing rules)
"""
import argparse, difflib, fnmatch, json, os, re, subprocess, sys, time
from dataclasses import dataclass

sys.path.insert(0, os.path.dirname(__file__))
from rules import RULES, PATH_RENAMES  # noqa: E402

WORD = re.compile(r"pocket[-_]?bot", re.I)
ROOT = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True, check=True).stdout.strip()
SELF = ("tools/rename/",)  # the tool and its rules talk about pocketbot on purpose


@dataclass
class Hit:
    path: str
    line: int
    col: int
    text: str  # the whole line
    match: str
    rule: str
    action: str


def new_word(old: str) -> str:
    """pocketbot -> paperbot keeping the case and the separator (Pocketbot, POCKETBOT, pocket-bot ...)."""
    m = re.fullmatch(r"(pocket)([-_]?)(bot)", old, re.I)
    head, sep, tail = m.groups()
    def case(src: str, dst: str) -> str:
        if src.isupper(): return dst.upper()
        if src[0].isupper(): return dst[0].upper() + dst[1:]
        return dst
    return case(head, "paper") + sep + case(tail, "bot")


def compiled():
    out = []
    for r in RULES:
        try:
            out.append({**r, "re": re.compile(r["pattern"]), "globs": r.get("paths", ["*"])})
        except re.error as e:
            sys.exit(f"rules.py: rule {r['id']}: bad pattern: {e}")
    return out


def classify(rules, path: str, line: str, start: int, end: int):
    for r in rules:
        if not any(fnmatch.fnmatch(path, g) for g in r["globs"]): continue
        for m in r["re"].finditer(line):
            if m.start() <= start and end <= m.end(): return r
    return None


def files():
    names = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, check=True).stdout.split(b"\0")
    for n in names:
        p = n.decode()
        if not p or p.startswith(SELF): continue
        full = os.path.join(ROOT, p)
        if not os.path.isfile(full) or os.path.islink(full): continue
        try:
            data = open(full, "rb").read()
        except OSError:
            continue
        if b"\0" in data[:8000]: continue  # binary
        try:
            yield p, data.decode("utf-8")
        except UnicodeDecodeError:
            continue


def audit(rules):
    hits = []
    for path, text in files():
        if not WORD.search(text): continue
        for i, line in enumerate(text.split("\n"), 1):
            for m in WORD.finditer(line):
                r = classify(rules, path, line, m.start(), m.end())
                hits.append(Hit(path, i, m.start(), line, m.group(0), r["id"] if r else "UNCLASSIFIED", r["action"] if r else "?"))
    return hits


def renamed_text(text: str, path: str, rules) -> str:
    out = []
    for line in text.split("\n"):
        def sub(m):
            r = classify(rules, path, line, m.start(), m.end())
            return new_word(m.group(0)) if r and r["action"] == "rename" else m.group(0)
        out.append(WORD.sub(sub, line))
    return "\n".join(out)


def path_moves():
    tracked = subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.split("\n")
    moves = []
    for old, new in PATH_RENAMES:
        if any(t == old or t.startswith(old.rstrip("/") + "/") for t in tracked): moves.append((old, new))
    return moves


def show(h: Hit) -> str:
    l = h.text
    return f"{h.path}:{h.line}: {l[:h.col]}[{h.match}]{l[h.col + len(h.match):]}".strip()[:220]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--rule"); ap.add_argument("--file"); ap.add_argument("--diff", action="store_true")
    ap.add_argument("--json"); ap.add_argument("--apply", action="store_true"); ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    t0 = time.time()
    rules = compiled()

    if a.check:
        bad = 0
        for r in rules:
            for ex in r.get("examples", []):
                path, line = ex if isinstance(ex, (list, tuple)) else ("x", ex)
                m = WORD.search(line)
                got = classify(rules, path, line, m.start(), m.end()) if m else None
                if not got or got["id"] != r["id"]:
                    bad += 1; print(f"✗ {r['id']}: {path}: {line!r} -> {got['id'] if got else 'UNCLASSIFIED'}")
        print("✓ every example classifies to its rule" if not bad else f"{bad} examples misclassified"); return 1 if bad else 0

    hits = audit(rules)
    sel = [h for h in hits if (not a.rule or h.rule == a.rule) and (not a.file or h.path.startswith(a.file))]

    if a.json:
        json.dump([h.__dict__ for h in hits], open(a.json, "w"), indent=1); print(f"wrote {len(hits)} occurrences to {a.json}")

    if a.rule or a.file:
        for h in sel: print(f"{h.action:6} {h.rule:22} {show(h)}")

    if a.diff:
        for path in sorted({h.path for h in sel if h.action == "rename"}):
            old = open(os.path.join(ROOT, path), encoding="utf-8").read()
            new = renamed_text(old, path, rules)
            if a.rule:  # only that rule's lines
                new = "\n".join(nl if any(h.path == path and h.line == i and h.rule == a.rule for h in sel) else ol
                                for i, (ol, nl) in enumerate(zip(old.split("\n"), new.split("\n")), 1))
            sys.stdout.writelines(difflib.unified_diff(old.splitlines(True), new.splitlines(True), f"a/{path}", f"b/{path}"))

    by = {}
    for h in hits: by.setdefault(h.rule, []).append(h)
    unclassified = by.get("UNCLASSIFIED", [])
    if not (a.rule or a.file or a.diff):
        order = [r["id"] for r in rules] + ["UNCLASSIFIED"]
        print(f"{'rule':24} {'action':7} {'hits':>5} {'files':>5}  why / where")
        for rid in order:
            hs = by.get(rid, [])
            if not hs: continue
            r = next((x for x in rules if x["id"] == rid), {"action": "?", "why": "no rule matches: add one to rules.py"})
            files_ = sorted({h.path for h in hs})
            print(f"{rid:24} {r['action']:7} {len(hs):5} {len(files_):5}  {r['why'][:70]}")
        ren = sum(1 for h in hits if h.action == "rename"); keep = sum(1 for h in hits if h.action == "keep")
        print(f"\n{len(hits)} occurrences in {len({h.path for h in hits})} files: {ren} rename, {keep} keep, {len(unclassified)} unclassified")
        moves = path_moves()
        if moves: print("paths to move:\n" + "\n".join(f"  git mv {o} {n}" for o, n in moves))
        if unclassified:
            print("\nUNCLASSIFIED (first 40):")
            for h in unclassified[:40]: print("  " + show(h))
        unused = [r["id"] for r in rules if r["id"] not in by]
        if unused: print(f"\nrules that matched nothing: {', '.join(unused)}")
        if not a.apply: print(f"\n({time.time() - t0:.2f}s, dry run: nothing written. --rule ID / --file PATH / --diff to look closer, --apply to write)")

    if a.apply:
        if unclassified:
            print(f"refusing to apply: {len(unclassified)} occurrences match no rule (see above)"); return 1
        changed = 0
        for path in sorted({h.path for h in hits if h.action == "rename"}):
            full = os.path.join(ROOT, path)
            old = open(full, encoding="utf-8").read(); new = renamed_text(old, path, rules)
            if new != old: open(full, "w", encoding="utf-8").write(new); changed += 1
        moves = path_moves()
        for o, n in moves:
            os.makedirs(os.path.dirname(os.path.join(ROOT, n)) or ROOT, exist_ok=True)
            subprocess.run(["git", "mv", o, n], cwd=ROOT, check=True)
        print(f"applied: {changed} files rewritten, {len(moves)} paths moved ({time.time() - t0:.2f}s). Review: git diff --stat")
    return 1 if unclassified else 0


if __name__ == "__main__":
    sys.exit(main())
