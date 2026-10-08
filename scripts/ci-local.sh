#!/usr/bin/env bash
# Run btrain's CI checks on this machine, mirroring .github/workflows/test.yml
# and formal-advisory.yml (the formal check is looser: it uses any local
# tla2tools.jar and ignores the PR-body impact declaration). Use it as the merge gate when hosted CI is
# unavailable, or before pushing.
#
# Usage: scripts/ci-local.sh [--base <ref>] [--compat] [--no-python] [--no-formal] [--install]
#   --base <ref>  base for the formal advisory selection (default origin/main)
#   --compat      also run the suite on Node 18 and 20 through `npx node@<v>`
#   --no-python   skip the agentchattr and review-script Python tests
#   --no-formal   skip the formal advisory check
#   --install     run `npm ci` even when node_modules exists
#
# Required steps: npm test, experiment tests, Python tests, compat runs.
# Advisory steps (spec 014, never fail the run): formal witnesses and the
# formal advisory check. Exit status is 1 when any required step failed.
set -u

BASE="origin/main"
COMPAT=0
PYTHON=1
FORMAL=1
INSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --base) [ $# -ge 2 ] || { echo "ci-local: --base needs a ref" >&2; exit 2; }; BASE="$2"; shift 2 ;;
    --compat) COMPAT=1; shift ;;
    --no-python) PYTHON=0; shift ;;
    --no-formal) FORMAL=0; shift ;;
    --install) INSTALL=1; shift ;;
    -h|--help) awk 'NR > 1 && /^#/ { print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    *) echo "ci-local: unknown option $1" >&2; exit 2 ;;
  esac
done

ROOT="$(git rev-parse --show-toplevel)" || exit 2
cd "$ROOT" || exit 2
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/btrain-ci"
LOGS="$(mktemp -d "${TMPDIR:-/tmp}/btrain-ci-local.XXXXXX")"
mkdir -p "$CACHE"

# Match the hosted runner: CI=true keeps the dashboard from auto-starting,
# BTRAIN_NO_REVIEW_DISPATCH=1 keeps needs-review from spawning reviewer CLIs,
# and no agent or lane identity leaks in from the calling session.
export CI=true BTRAIN_NO_REVIEW_DISPATCH=1
unset GITHUB_HEAD_REF GITHUB_ACTOR GITHUB_TRIGGERING_ACTOR
unset BTRAIN_AGENT BRAIN_TRAIN_AGENT BTRAIN_LANE BTRAIN_LANE_LOCKED BTRAIN_REPO BTRAIN_LOOP_ACTIVE

RESULTS=()
FAILED=0
step() { # step <required|advisory> <name> <command...>
  local kind="$1" name="$2"; shift 2
  local log="$LOGS/$(echo "$name" | tr -c 'A-Za-z0-9' '-').log"
  local start=$SECONDS
  printf '==> %s\n' "$name"
  if "$@" >"$log" 2>&1; then
    RESULTS+=("pass      $name ($((SECONDS - start))s)")
  else
    if [ "$kind" = required ]; then
      FAILED=1; RESULTS+=("FAIL      $name ($((SECONDS - start))s)  log: $log")
    else
      RESULTS+=("advisory  $name failed ($((SECONDS - start))s)  log: $log")
    fi
    tail -n 25 "$log" | sed 's/^/    /'
    return 1
  fi
}

if [ "$INSTALL" = 1 ] || [ ! -d node_modules ]; then
  step required "npm ci" npm ci || true
fi
command -v ast-grep >/dev/null || echo "ci-local: ast-grep not on PATH; test/decomposition_inventory.test.mjs needs it (brew install ast-grep)" >&2

case "$(node --version)" in
  v22.*|v24.*) ;;
  *) echo "ci-local: warning: local Node is $(node --version); hosted CI's required matrix is Node 22 and 24" >&2 ;;
esac
step required "Node $(node --version) test suite" npm test || true
step required "Experiment tests" npm run test:experiments || true
step advisory "Formal regression witnesses" npm run test:formal:witnesses || true

if [ "$COMPAT" = 1 ]; then
  # Node 18 and 20 can't take npm test's quoted glob, so list the files here
  # (find, not globstar: macOS ships bash 3.2).
  TEST_FILES=()
  while IFS= read -r f; do TEST_FILES+=("$f"); done < <(find test -name '*.test.mjs' | sort)
  PRELOAD=()
  [ -f test/helpers/git-test-env.mjs ] && PRELOAD=(--import ./test/helpers/git-test-env.mjs)
  for v in 18 20; do
    step required "Node $v (runtime compatibility)" npx --yes "node@$v" ${PRELOAD[@]+"${PRELOAD[@]}"} --test "${TEST_FILES[@]}" || true
  done
fi

if [ "$PYTHON" = 1 ]; then
  VENV="$CACHE/venv"
  python_setup() {
    [ -x "$VENV/bin/python" ] || python3 -m venv "$VENV" || return 1
    "$VENV/bin/python" -m pip install -q -r agentchattr/requirements.txt pytest
  }
  if step required "Python environment" python_setup; then
    step required "agentchattr tests" "$VENV/bin/python" -m pytest agentchattr/tests -q || true
    step required "Option A review tests" "$VENV/bin/python" scripts/test_option_a_review.py || true
  fi
fi

if [ "$FORMAL" = 1 ]; then
  JAR="${TLC_JAR:-}"
  for candidate in "$HOME/.local/lib/tla2tools.jar" "$CACHE/tla2tools.jar"; do
    [ -z "$JAR" ] && [ -f "$candidate" ] && JAR="$candidate"
  done
  [ -z "$JAR" ] && echo "ci-local: no tla2tools.jar found (set TLC_JAR); model checks will report infrastructure_failure" >&2
  step advisory "Formal advisory (base $BASE)" env TLC_JAR="$JAR" node scripts/formal_advisory.mjs \
    --base "$(git rev-parse "$BASE")" --head "$(git rev-parse HEAD)" \
    --cache-dir "$CACHE/tlc-cache" --output "$LOGS/formal-advisory.json" || true
fi

echo
BRANCH="$(git branch --show-current)"
echo "ci-local summary ($(git rev-parse --short HEAD) on ${BRANCH:-detached HEAD})"
for line in "${RESULTS[@]}"; do echo "  $line"; done
echo "  logs: $LOGS"
exit "$FAILED"
