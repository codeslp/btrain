#!/usr/bin/env python3
"""Deterministic prose-to-TLA+ pin check (spec 014 FR-5).

Every specs/tla/*.tla file carries a header block:

    \\* Pinned to: <spec.md path> § <heading title>
    \\* Pinned to: ...            (one line per pinned section, in order)
    \\* Pinned-hash: <sha256>

A pinned section is the prose from its heading line up to (not including)
the next heading of the same or higher level. The hash is sha256 over the
UTF-8 concatenation of every pinned section in listed order, each line
right-stripped, lines joined with newlines, one newline between sections.

Commands:
    tla_pin.py --check [file.tla ...]   exit 0 clean, 1 stale, 2 usage/error
    tla_pin.py --show-range file.tla    print pinned sections and content
    tla_pin.py --repin file.tla         rewrite the Pinned-hash line
    tla_pin.py --verify-verdict specs/tla/.tlc-results/NAME.json
                                        recompute every cache key of a cached
                                        verdict; STALE keys make it unusable

Stdlib only. No TLC required.
"""

import argparse
import hashlib
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
TLA_DIR = REPO_ROOT / "specs" / "tla"
PIN_LINE = re.compile(r"^\\\*\s*Pinned to:\s*(?P<path>\S+)\s+§\s+(?P<heading>.+?)\s*$")
HASH_LINE = re.compile(r"^(?P<prefix>\\\*\s*Pinned-hash:\s*)(?P<hash>[0-9a-f]{64}|UNPINNED)\s*$")
HEADING = re.compile(r"^(?P<hashes>#{1,6})\s+(?P<title>.+?)\s*$")


def parse_pins(tla_path: Path):
    """Return (pins, hash_line_index, recorded_hash, lines)."""
    lines = tla_path.read_text(encoding="utf-8").splitlines()
    pins = []
    hash_index = None
    recorded = None
    for i, line in enumerate(lines):
        pin = PIN_LINE.match(line)
        if pin:
            pins.append((pin.group("path"), pin.group("heading")))
            continue
        h = HASH_LINE.match(line)
        if h:
            hash_index = i
            recorded = h.group("hash")
    return pins, hash_index, recorded, lines


def extract_section(md_path: Path, heading_title: str) -> str:
    """Prose from the heading line to the next same-or-higher heading."""
    text = md_path.read_text(encoding="utf-8").splitlines()
    start = None
    level = None
    for i, line in enumerate(text):
        m = HEADING.match(line)
        if m and m.group("title") == heading_title:
            start = i
            level = len(m.group("hashes"))
            break
    if start is None:
        raise KeyError(f"heading not found: {md_path}:{heading_title!r}")
    end = len(text)
    for i in range(start + 1, len(text)):
        m = HEADING.match(text[i])
        if m and len(m.group("hashes")) <= level:
            end = i
            break
    return "\n".join(line.rstrip() for line in text[start:end]).rstrip() + "\n"


def compute_hash(pins) -> str:
    parts = []
    for rel_path, heading in pins:
        md_path = REPO_ROOT / rel_path
        parts.append(extract_section(md_path, heading))
    return hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()


def target_files(paths):
    if paths:
        return [Path(p).resolve() for p in paths]
    if not TLA_DIR.is_dir():
        return []
    return sorted(TLA_DIR.glob("*.tla"))


def cmd_check(paths) -> int:
    files = target_files(paths)
    if not files:
        print("no TLA artifacts — nothing to check")
        return 0
    stale = []
    for tla in files:
        pins, hash_index, recorded, _ = parse_pins(tla)
        if not pins or hash_index is None:
            stale.append((tla, "missing Pinned to / Pinned-hash header"))
            continue
        try:
            current = compute_hash(pins)
        except (KeyError, FileNotFoundError) as error:
            stale.append((tla, f"pinned prose unavailable: {error}"))
            continue
        if recorded != current:
            stale.append((tla, f"recorded {recorded[:12]}… != current {current[:12]}…"))
    for tla, reason in stale:
        print(f"STALE {tla.relative_to(REPO_ROOT)}: {reason}")
    if stale:
        print(f"{len(stale)} stale pin(s). Re-pin with: scripts/tla_pin.py --repin <file.tla>")
        return 1
    print(f"{len(files)} pin(s) clean")
    return 0


def cmd_show_range(path: str) -> int:
    tla = Path(path).resolve()
    pins, _, recorded, _ = parse_pins(tla)
    if not pins:
        print(f"{tla}: no Pinned to header")
        return 2
    print(f"recorded hash: {recorded}")
    for rel_path, heading in pins:
        print(f"--- {rel_path} § {heading} ---")
        print(extract_section(REPO_ROOT / rel_path, heading))
    return 0


def cmd_repin(path: str) -> int:
    tla = Path(path).resolve()
    pins, hash_index, recorded, lines = parse_pins(tla)
    if not pins or hash_index is None:
        print(f"{tla}: missing Pinned to / Pinned-hash header; add them first")
        return 2
    current = compute_hash(pins)
    if recorded == current:
        print(f"{tla.relative_to(REPO_ROOT)}: already pinned to {current[:12]}…")
        return 0
    prefix = HASH_LINE.match(lines[hash_index]).group("prefix")
    lines[hash_index] = f"{prefix}{current}"
    tla.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"{tla.relative_to(REPO_ROOT)}: re-pinned {str(recorded)[:12]}… -> {current[:12]}…")
    return 0


def _sha256_file(path: Path) -> str:
    import hashlib
    return hashlib.sha256(path.read_bytes()).hexdigest()


def cmd_verify_verdict(path: str, tool_jar: str | None = None) -> int:
    """Recompute every semantic-input key of a cached TLC verdict (spec 014:
    cached results are reusable only when keyed by all semantic inputs) and
    report FRESH/STALE per key. Any STALE key, a missing validation block, or a
    top-level status other than pass makes the cache unusable as a pass."""
    import hashlib
    import json
    import os
    import subprocess
    verdict_path = Path(path).resolve()
    data = json.loads(verdict_path.read_text(encoding="utf-8"))
    keys = data.get("keys") or {}
    name = verdict_path.stem
    tla = TLA_DIR / f"{name}.tla"
    cfg = TLA_DIR / (data.get("tlc", {}).get("config") or f"{name}.cfg")
    stale = []
    def check(label, recorded, current):
        ok = recorded == current
        print(f"{'FRESH' if ok else 'STALE'} {label}: recorded {str(recorded)[:12]}… current {str(current)[:12]}…")
        if not ok:
            stale.append(label)
    check("tla_content_sha256", keys.get("tla_content_sha256"), _sha256_file(tla))
    check("cfg_sha256", keys.get("cfg_sha256"), _sha256_file(cfg))
    pins, _, recorded_pin, _ = parse_pins(tla)
    check("pinned_prose_sha256 (header)", keys.get("pinned_prose_sha256"), recorded_pin)
    check("pinned_prose_sha256 (prose)", keys.get("pinned_prose_sha256"), compute_hash(pins) if pins else None)
    h = hashlib.sha256()
    for rel in keys.get("harness_files") or []:
        h.update((REPO_ROOT / rel).read_bytes())
    check("harness_sha256", keys.get("harness_sha256"), h.hexdigest())
    jar = tool_jar or os.environ.get("TLC_JAR")
    if jar and Path(jar).is_file():
        check("tla2tools_sha256", keys.get("tla2tools_sha256"), _sha256_file(Path(jar)))
    else:
        # An unverifiable tool hash is a declared semantic key we cannot check;
        # the verdict is not reusable until it is (spec 014: tool_unavailable
        # is never reported as a pass).
        print("STALE tla2tools_sha256: tool hash unverified (set TLC_JAR or pass --tool-jar)")
        stale.append("tla2tools_sha256")
    # Exact-head rule (spec 014 FR-8): the recorded source commit must be an
    # ancestor of HEAD and none of the semantic inputs may differ between it
    # and HEAD. Content hashes above cover the working tree; this covers the
    # commit identity the verdict claims to describe.
    src = keys.get("source_commit")
    inputs = [tla, cfg] + [REPO_ROOT / rel for rel, _ in pins] + [REPO_ROOT / rel for rel in (keys.get("harness_files") or [])]
    if not src:
        print("STALE source_commit: none recorded")
        stale.append("source_commit")
    else:
        def git(*args):
            return subprocess.run(["git", "-C", str(REPO_ROOT), *args], capture_output=True, text=True).returncode
        exists = git("cat-file", "-e", f"{src}^{{commit}}") == 0
        ancestor = exists and git("merge-base", "--is-ancestor", src, "HEAD") == 0
        rel_inputs = [str(p.relative_to(REPO_ROOT)) for p in inputs]
        unchanged = ancestor and git("diff", "--quiet", src, "HEAD", "--", *rel_inputs) == 0
        if unchanged:
            print(f"FRESH source_commit: {src[:12]} is an ancestor of HEAD with identical semantic inputs")
        else:
            reason = "unknown commit" if not exists else ("not an ancestor of HEAD" if not ancestor else "semantic inputs changed since")
            print(f"STALE source_commit: {str(src)[:12]} ({reason})")
            stale.append("source_commit")
    validation = data.get("validation") or {}
    if not validation.get("seed") or not validation.get("runs"):
        print("STALE validation: no seed/runs recorded; the verdict is not keyed by a trace set")
        stale.append("validation")
    status = data.get("status")
    tlc_status = (data.get("tlc") or {}).get("status")
    # A chain `pass` (spec 014) needs TLC to pass AND every recorded validation
    # outcome to pass: contract mode, the candidate gate, implementation mode,
    # and trace validation. Seed/run metadata alone proves nothing.
    validation_outcomes = {
        "contract_mode": str(validation.get("contract_mode", "")),
        "candidate_gate": str(validation.get("candidate_gate", "")),
        "implementation_mode": str(validation.get("implementation_mode", "")),
        "trace_validation": str(validation.get("trace_validation", "")),
    }
    failed_outcomes = [k for k, v in validation_outcomes.items() if not v.lower().startswith("pass")]
    print(f"status: {status} (tlc: {tlc_status}; validation outcomes not passing: {failed_outcomes or 'none'})")
    if status == "pass" and (tlc_status != "pass" or failed_outcomes):
        print("INVALID: status is `pass` but TLC or a recorded validation outcome is not a pass; the artifact overclaims")
        stale.append("status")
    if stale:
        print(f"{len(stale)} stale or invalid key(s); do not reuse this verdict. Re-run TLC and the harness.")
        return 1
    if status != "pass":
        print("keys are fresh but the recorded verdict is not `pass`; nothing to reuse as a pass.")
        return 3
    print("verdict is fresh, every validation outcome passed, and it is reusable")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--check", action="store_true")
    group.add_argument("--show-range", metavar="FILE")
    group.add_argument("--repin", metavar="FILE")
    group.add_argument("--verify-verdict", metavar="JSON")
    parser.add_argument("--tool-jar", metavar="PATH", help="tla2tools.jar to hash for --verify-verdict (default: $TLC_JAR)")
    parser.add_argument("files", nargs="*", help="explicit .tla targets for --check")
    args = parser.parse_args()
    if args.check:
        return cmd_check(args.files)
    if args.show_range:
        return cmd_show_range(args.show_range)
    if args.verify_verdict:
        return cmd_verify_verdict(args.verify_verdict, args.tool_jar)
    return cmd_repin(args.repin)


if __name__ == "__main__":
    sys.exit(main())
