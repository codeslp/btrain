#!/usr/bin/env bash
# zvec-context.sh — optional, read-only semantic discovery for context-scout.
#
# This helper never installs zvec-grep, creates or rebuilds an index, starts a
# daemon, or grants remote embedding access. Missing tools and indexes are soft
# skips so native rg and normal local reads remain available.

set -uo pipefail

DEFAULT_LIMIT=5

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

The helper performs at most one semantic query. Use native rg for exact or
exhaustive lookup. Create indexes explicitly with zg; this helper never does it.
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
  if [ -z "$value" ] || [[ "$value" == --* ]]; then
    die_usage "$option requires a value"
  fi
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
  if ! zg status "$root" --mode direct --check-ready >/dev/null 2>&1; then
    emit_skip "a ready index was not found; create or refresh it explicitly with zg index"
    return 1
  fi
  return 0
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

    case "$limit" in
      ''|*[!0-9]*) die_usage "--limit must be an integer from 1 to 20" ;;
    esac
    if [ "$limit" -lt 1 ] || [ "$limit" -gt 20 ]; then
      die_usage "--limit must be an integer from 1 to 20"
    fi

    case "$freshness" in
      eventual) refresh="off" ;;
      strict) refresh="wait" ;;
      *) die_usage "--freshness must be eventual or strict" ;;
    esac

    root=$(resolve_root "$root")
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

    output=$(cd "$root" && zg "${args[@]}" 2>&1)
    rc=$?
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
    root=$(resolve_root "$root")
    require_zg || exit 0
    if ! zg status "$root" --mode direct --check-ready; then
      emit_skip "a ready index was not found; create or refresh it explicitly with zg index"
      exit 0
    fi
    ;;

  -h|--help|help)
    usage 0
    ;;

  *)
    die_usage "unknown subcommand: $subcommand"
    ;;
esac
