#!/usr/bin/env bash
# zvec-context.sh — optional, read-only semantic discovery for context-scout.
#
# This helper never installs zvec-grep, creates or rebuilds an index, starts a
# daemon, or grants remote embedding access. Missing tools and indexes are soft
# skips so native rg and normal local reads remain available.

set -uo pipefail

DEFAULT_LIMIT=5
# Upper bound on one zg call. --freshness strict maps to --refresh wait, which
# blocks until the index is fresh; optional retrieval must never block a task,
# so an expired call is reported as a soft skip.
ZVEC_CONTEXT_TIMEOUT="${ZVEC_CONTEXT_TIMEOUT:-120}"

usage() {
  local exit_code="${1:-64}"
  cat <<'EOF' >&2
Usage: zvec-context.sh search <query> [options]
       zvec-context.sh status [--root <path>]

Search options:
  --root <path>                    Indexed workspace root (default: current directory)
  --freshness <eventual|strict>    eventual uses --refresh off; strict uses --refresh wait
  --limit <1-20>                   Maximum ranked passages (default: 5)
  --glob <pattern>                 Repeatable indexed path scope

Environment:
  ZVEC_CONTEXT_TIMEOUT             Wall-clock bound in seconds for each zg call
                                   (default 120). An expired call is a soft skip.
                                   search makes two bounded calls (readiness
                                   probe, then query), so its worst case is 2x.

The helper performs at most one semantic query. Use native rg for exact or
exhaustive lookup. Create indexes explicitly with zg; this helper never does it.
Soft skips (exit 0, "zvec-context: skipped"): zg is not installed, no ready
index, or the time bound expired. Usage errors exit 64.
EOF
  exit "$exit_code"
}

die_usage() {
  printf '%s\n' "$1" >&2
  exit 64
}

require_value() {
  local option="$1"
  local value="${2:-}"
  # A value that starts with "-" would be re-parsed by zg as an option, so it is
  # never forwarded (argv safety), even when it was clearly meant as a value.
  if [ -z "$value" ] || [[ "$value" == -* ]]; then
    die_usage "$option requires a value that does not start with -"
  fi
}

# Temp files owned by the run_bounded call in progress, removed on exit or on a
# signal so a killed helper leaves nothing behind. Set per shell: a run_bounded
# inside $(...) registers its own traps in that subshell.
ZVEC_TMP_OUT=""
ZVEC_TMP_PID=""
ZVEC_TMP_WATCHDOG=""
ZVEC_BOUNDED_OUTPUT=""
cleanup_tmp() {
  if [ -n "$ZVEC_TMP_OUT" ]; then
    rm -f "$ZVEC_TMP_OUT" "$ZVEC_TMP_OUT.timeout"
  fi
  return 0
}
on_signal() {
  if [ -n "$ZVEC_TMP_PID" ]; then
    kill -TERM "$ZVEC_TMP_PID" 2>/dev/null
  fi
  if [ -n "$ZVEC_TMP_WATCHDOG" ]; then
    kill -TERM "$ZVEC_TMP_WATCHDOG" 2>/dev/null
  fi
  cleanup_tmp
  exit 143
}

# Change directory, then become the command (used as the bounded child so the
# helper's own shell never changes directory).
run_in_dir() {
  cd "$1" || exit 1
  shift
  exec "$@"
}

validate_timeout() {
  if ! [[ "$ZVEC_CONTEXT_TIMEOUT" =~ ^[1-9][0-9]{0,3}$ ]]; then
    die_usage "ZVEC_CONTEXT_TIMEOUT must be an integer number of seconds from 1 to 9999"
  fi
}

# Run one command with a wall-clock bound, in the calling shell (never inside
# $(...): a signal to the helper must reach the child and the temp files). The
# command's stdout and stderr go to a temp file, not to a pipe: a descendant
# that keeps an inherited pipe open would otherwise hold a capture past the
# bound. Leaves the captured output in ZVEC_BOUNDED_OUTPUT and returns the
# command's own status; 124 when the bound expired (a sentinel file plus a
# signal exit status marks the timeout, so a command that really exits 143 is
# reported as its own failure); 125 when no temp file could be created.
run_bounded() {
  local secs="$1"
  shift
  local out sentinel pid watchdog rc
  out=$(mktemp "${TMPDIR:-/tmp}/zvec-context.XXXXXX" 2>/dev/null) || return 125
  sentinel="$out.timeout"
  ZVEC_TMP_OUT="$out"
  trap cleanup_tmp EXIT
  trap on_signal TERM INT HUP
  "$@" >"$out" 2>&1 </dev/null &
  pid=$!
  ZVEC_TMP_PID="$pid"
  (
    sleep "$secs" &
    sleeper=$!
    trap 'kill "$sleeper" 2>/dev/null; exit 0' TERM
    wait "$sleeper"
    : >"$sentinel"
    kill -TERM "$pid" 2>/dev/null
  ) >/dev/null 2>&1 </dev/null &
  watchdog=$!
  ZVEC_TMP_WATCHDOG="$watchdog"
  wait "$pid" 2>/dev/null
  rc=$?
  kill -TERM "$watchdog" 2>/dev/null
  wait "$watchdog" 2>/dev/null
  ZVEC_TMP_WATCHDOG=""
  ZVEC_BOUNDED_OUTPUT=$(cat "$out")
  # Only a child that died by signal after the sentinel appeared counts as a
  # timeout; a sentinel written in the instant after a normal exit does not.
  if [ -e "$sentinel" ] && [ "$rc" -ge 128 ]; then
    rc=124
  fi
  rm -f "$out" "$sentinel"
  ZVEC_TMP_OUT=""
  ZVEC_TMP_PID=""
  return "$rc"
}

emit_skip() {
  printf 'zvec-context: skipped\nreason: %s\n' "$1"
}

resolve_root() {
  local requested="$1"
  local resolved
  if ! resolved=$(cd "$requested" 2>/dev/null && pwd -P); then
    die_usage "--root must name an accessible directory: $requested"
  fi
  printf '%s\n' "$resolved"
}

require_zg() {
  if ! command -v zg >/dev/null 2>&1; then
    emit_skip "zg CLI is not installed; btrain does not install it or create an index"
    return 1
  fi
  return 0
}

require_ready_index() {
  local root="$1"
  run_bounded "$ZVEC_CONTEXT_TIMEOUT" zg status "$root" --mode direct --check-ready
  case $? in
    0) return 0 ;;
    124) emit_skip "zg status did not finish within ${ZVEC_CONTEXT_TIMEOUT}s (ZVEC_CONTEXT_TIMEOUT)"; return 1 ;;
    125) emit_skip "could not create a temp file under ${TMPDIR:-/tmp}"; return 1 ;;
    *) emit_skip "a ready index was not found; create or refresh it explicitly with zg index"; return 1 ;;
  esac
}

[ $# -lt 1 ] && usage
subcommand="$1"
shift

case "$subcommand" in
  search)
    [ $# -lt 1 ] && usage
    query="$1"
    shift
    [ -z "$query" ] && die_usage "search query must not be empty"
    [[ "$query" == -* ]] && die_usage "search query must not start with -; zg would read it as an option"

    root="$PWD"
    freshness="eventual"
    limit="$DEFAULT_LIMIT"
    globs=()

    while [ $# -gt 0 ]; do
      case "$1" in
        --root)
          require_value "$1" "${2:-}"
          root="$2"
          shift 2
          ;;
        --freshness)
          require_value "$1" "${2:-}"
          freshness="$2"
          shift 2
          ;;
        --limit)
          require_value "$1" "${2:-}"
          limit="$2"
          shift 2
          ;;
        --glob)
          require_value "$1" "${2:-}"
          globs+=("$2")
          shift 2
          ;;
        *)
          die_usage "search: unknown argument: $1"
          ;;
      esac
    done

    # Validate by pattern, not arithmetic: a digit string outside Bash's integer
    # range makes [ -lt ] print "integer expression expected" and evaluate false,
    # which would let the raw value through to zg.
    if ! [[ "$limit" =~ ^([1-9]|1[0-9]|20)$ ]]; then
      die_usage "--limit must be an integer from 1 to 20"
    fi
    validate_timeout

    case "$freshness" in
      eventual) refresh="off" ;;
      strict) refresh="wait" ;;
      *) die_usage "--freshness must be eventual or strict" ;;
    esac

    root=$(resolve_root "$root") || exit $?
    require_zg || exit 0
    require_ready_index "$root" || exit 0

    args=(
      query
      --hybrid "$query"
      --mode direct
      --refresh "$refresh"
      --preview short
      --limit "$limit"
    )
    for glob in "${globs[@]-}"; do
      if [ -n "$glob" ]; then
        args+=(--glob "$glob")
      fi
    done

    run_bounded "$ZVEC_CONTEXT_TIMEOUT" run_in_dir "$root" zg "${args[@]}"
    rc=$?
    output="$ZVEC_BOUNDED_OUTPUT"
    if [ "$rc" -eq 124 ]; then
      emit_skip "zg did not finish within ${ZVEC_CONTEXT_TIMEOUT}s (ZVEC_CONTEXT_TIMEOUT); refresh the index explicitly or use --freshness eventual"
      exit 0
    fi
    if [ "$rc" -eq 125 ]; then
      emit_skip "could not create a temp file under ${TMPDIR:-/tmp}"
      exit 0
    fi
    if [ "$rc" -ne 0 ]; then
      printf 'zvec-context: error\nroot: %s\nfreshness-policy: %s\n%s\n' \
        "$root" "$freshness" "$output" >&2
      exit "$rc"
    fi

    printf 'zvec-context: ok\nroot: %s\nfreshness-policy: %s\n%s\n' \
      "$root" "$freshness" "$output"
    ;;

  status)
    root="$PWD"
    while [ $# -gt 0 ]; do
      case "$1" in
        --root)
          require_value "$1" "${2:-}"
          root="$2"
          shift 2
          ;;
        *) die_usage "status: unknown argument: $1" ;;
      esac
    done
    validate_timeout
    root=$(resolve_root "$root") || exit $?
    require_zg || exit 0
    run_bounded "$ZVEC_CONTEXT_TIMEOUT" zg status "$root" --mode direct --check-ready
    rc=$?
    output="$ZVEC_BOUNDED_OUTPUT"
    if [ "$rc" -eq 124 ]; then
      emit_skip "zg status did not finish within ${ZVEC_CONTEXT_TIMEOUT}s (ZVEC_CONTEXT_TIMEOUT)"
      exit 0
    fi
    if [ "$rc" -eq 125 ]; then
      emit_skip "could not create a temp file under ${TMPDIR:-/tmp}"
      exit 0
    fi
    if [ "$rc" -ne 0 ]; then
      emit_skip "a ready index was not found; create or refresh it explicitly with zg index"
      exit 0
    fi
    printf 'zvec-context: ok\nroot: %s\n%s\n' "$root" "$output"
    ;;

  -h|--help|help)
    usage 0
    ;;

  *)
    die_usage "unknown subcommand: $subcommand"
    ;;
esac
