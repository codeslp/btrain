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
    return hashlib.sha256(path.read_bytes()).hexdigest()


# Every input whose content can change the meaning of a cached verdict: the
# model and its configuration, the pinned prose, the FR-6 harness, and the
# implementation the harness drives. Hashing their contents (not a commit id)
# survives squash merges and rebases: the verdict applies to any head whose
# semantic inputs are byte-identical.
IMPLEMENTATION_INPUT_DIRS = ("src/brain_train",)
# Files outside the directories above whose content also decides what a
# validation run meant: the ledger that classifies candidate findings and the
# dependency manifest that pins the harness engine version.
EXTRA_SEMANTIC_INPUTS = ("test/formal/README.md", "package.json", "package-lock.json")


def _tracked_files(rel_dir: str) -> list[Path]:
    """Tracked files under rel_dir via git; falls back to rglob without
    dotfiles when git is unavailable so stray editor files never flip a key."""
    import subprocess
    try:
        out = subprocess.run(["git", "-C", str(REPO_ROOT), "ls-files", "--", rel_dir],
                             capture_output=True, text=True, check=True).stdout
        return sorted(REPO_ROOT / line for line in out.splitlines() if line)
    except (subprocess.CalledProcessError, FileNotFoundError):
        base = REPO_ROOT / rel_dir
        if not base.is_dir():
            return []
        return sorted(p for p in base.rglob("*") if p.is_file() and not any(part.startswith(".") for part in p.relative_to(base).parts))


def semantic_inputs(tla: Path, cfg: Path, pins, harness_files) -> list[Path]:
    paths = [tla, cfg]
    paths += [REPO_ROOT / rel for rel, _ in pins]
    paths += [REPO_ROOT / rel for rel in harness_files]
    for rel_dir in IMPLEMENTATION_INPUT_DIRS:
        paths += _tracked_files(rel_dir)
    paths += [REPO_ROOT / rel for rel in EXTRA_SEMANTIC_INPUTS if (REPO_ROOT / rel).is_file()]
    seen, ordered = set(), []
    for p in paths:
        rp = p.resolve()
        if rp not in seen:
            seen.add(rp)
            ordered.append(p)
    return ordered


def inputs_sha256(paths) -> str:
    h = hashlib.sha256()
    for p in sorted(paths, key=lambda q: str(q.relative_to(REPO_ROOT))):
        h.update(str(p.relative_to(REPO_ROOT)).encode("utf-8") + b"\0")
        h.update(_sha256_file(p).encode("ascii") + b"\n")
    return h.hexdigest()


def cmd_verify_verdict(path: str, tool_jar: str | None = None) -> int:
    """Recompute every semantic-input key of a cached TLC verdict (spec 014:
    cached results are reusable only when keyed by all semantic inputs) and
    report FRESH/STALE per key. Any STALE key, a missing validation block, or a
    top-level status other than pass makes the cache unusable as a pass."""
    import json
    import os
    import subprocess
    verdict_path = Path(path).resolve()
    try:
        data = json.loads(verdict_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        print(f"STALE verdict: cannot read {verdict_path}: {error}")
        return 1
    keys = data.get("keys") or {}
    tlc_block = data.get("tlc") if isinstance(data.get("tlc"), dict) else {}
    name = verdict_path.stem
    tla = TLA_DIR / f"{name}.tla"
    cfg = TLA_DIR / (tlc_block.get("config") or f"{name}.cfg")
    stale = []
    def check(label, recorded, current):
        ok = recorded is not None and recorded == current
        print(f"{'FRESH' if ok else 'STALE'} {label}: recorded {str(recorded)[:12]}… current {str(current)[:12]}…")
        if not ok:
            stale.append(label)
    def safe(label, fn):
        # A missing input is a STALE key with a reason, never a traceback
        # (spec 014 FR-10: failure classes stay distinguishable).
        try:
            return fn()
        except (OSError, KeyError, ValueError) as error:
            print(f"STALE {label}: cannot compute ({error})")
            stale.append(label)
            return None
    current_tla = safe("tla_content_sha256", lambda: _sha256_file(tla))
    if current_tla is not None:
        check("tla_content_sha256", keys.get("tla_content_sha256"), current_tla)
    current_cfg = safe("cfg_sha256", lambda: _sha256_file(cfg))
    if current_cfg is not None:
        check("cfg_sha256", keys.get("cfg_sha256"), current_cfg)
    pins, _, recorded_pin, _ = parse_pins(tla) if tla.is_file() else ([], None, None, [])
    check("pinned_prose_sha256 (header)", keys.get("pinned_prose_sha256"), recorded_pin)
    current_prose = safe("pinned_prose_sha256 (prose)", lambda: compute_hash(pins) if pins else None)
    if current_prose is not None:
        check("pinned_prose_sha256 (prose)", keys.get("pinned_prose_sha256"), current_prose)
    harness_paths = [REPO_ROOT / rel for rel in (keys.get("harness_files") or [])]
    current_harness = safe("harness_sha256", lambda: inputs_sha256(harness_paths))
    if current_harness is not None:
        check("harness_sha256 (path, sha pairs)", keys.get("harness_sha256"), current_harness)
    jar = tool_jar or os.environ.get("TLC_JAR")
    if jar and Path(jar).is_file():
        check("tla2tools_sha256", keys.get("tla2tools_sha256"), _sha256_file(Path(jar)))
    else:
        # An unverifiable tool hash is a declared semantic key we cannot check;
        # the verdict is not reusable until it is (spec 014: tool_unavailable
        # is never reported as a pass).
        print("STALE tla2tools_sha256: tool hash unverified (set TLC_JAR or pass --tool-jar)")
        stale.append("tla2tools_sha256")
    # Exact-head rule (spec 014 FR-8), keyed by content rather than commit id so
    # a squash merge or rebase does not orphan valid evidence: the verdict is
    # reusable on this head only if every semantic input, including the
    # implementation files the harness drives, is byte-identical to the run.
    inputs = semantic_inputs(tla, cfg, pins, keys.get("harness_files") or [])
    current_inputs = safe("inputs_sha256", lambda: inputs_sha256(inputs))
    if current_inputs is not None:
        check("inputs_sha256 (tla, cfg, pinned prose, harness, tracked src/brain_train, ledger, package manifests)", keys.get("inputs_sha256"), current_inputs)
    src = keys.get("source_commit")
    if src:
        anc = subprocess.run(["git", "-C", str(REPO_ROOT), "merge-base", "--is-ancestor", src, "HEAD"], capture_output=True).returncode == 0
        print(f"info  source_commit: {str(src)[:12]} ({'ancestor of HEAD' if anc else 'not an ancestor of HEAD, e.g. after a squash merge'}; provenance only, the content keys above decide reuse)")
    else:
        print("info  source_commit: none recorded (provenance only)")
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
