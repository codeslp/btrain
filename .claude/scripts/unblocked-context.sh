#!/usr/bin/env bash
# unblocked-context.sh — thin sub-wrapper around the Unblocked CLI for repo-local skills.
#
# Always emits a JSON object on stdout (never bare error text), so downstream
# `jq` calls in skills don't need to special-case missing-CLI / unauthed
# environments.
#
# Sub-commands:
#   research <query> [--effort low|medium|high] [--limit N]
#   search-issues|search-prs|search-messages|search-code|search-documentation <query> [--limit N]
#   query-issues|query-prs <query> [--projects X]... [--user-name Y] [--limit N]
#   get-urls <url1> [url2 ...]
#
# Notes:
#   --effort is only valid on `research` (the CLI rejects it on search/query).
#   --limit is implemented as `jq '.sources[:N]'`; the CLI has no --limit flag.
#   --projects / --user-name are only valid on `query-*`.
#
# Exit codes:
#   0   success, OR a graceful skip (CLI missing, unauthed, malformed output) — see `_skipped`
#   2   the CLI returned a real error other than UNAUTHENTICATED — JSON passed through
#   64  bad invocation (caller passed wrong args)

set -uo pipefail

DEFAULT_LIMIT=5

usage() {
  cat <<'EOF' >&2
Usage: unblocked-context.sh <subcommand> [args]

Subcommands:
  research <query> [--effort low|medium|high] [--limit N]
  search-issues <query> [--limit N]
  search-prs <query> [--limit N]
  search-messages <query> [--limit N]
  search-code <query> [--limit N]
  search-documentation <query> [--limit N]
  query-issues <query> [--projects X]... [--user-name Y] [--limit N]
  query-prs <query> [--projects X]... [--user-name Y] [--limit N]
  get-urls <url1> [url2 ...]
EOF
  exit 64
}

emit_skip() {
  jq -cn --arg reason "$1" '{sources: [], _skipped: $reason}'
}

if ! command -v jq >/dev/null 2>&1; then
  printf '{"sources":[],"_skipped":"jq not installed"}\n'
  exit 0
fi

if ! command -v unblocked >/dev/null 2>&1; then
  emit_skip "unblocked CLI not installed"
  exit 0
fi

[ $# -lt 1 ] && usage
sub="$1"
shift

# Run the CLI and shape the result.
# Args: <jq_filter> <cli_arg>...
run_unblocked() {
  local jq_filter="$1"
  shift
  local raw
  raw=$(unblocked "$@" 2>/dev/null)
  local rc=$?

  if [ -z "$raw" ]; then
    emit_skip "unblocked returned empty output (exit $rc)"
    return 0
  fi

  if ! printf '%s' "$raw" | jq -e . >/dev/null 2>&1; then
    emit_skip "unblocked returned non-JSON output"
    return 0
  fi

  local err_code
  err_code=$(printf '%s' "$raw" | jq -r '.error // empty')
  if [ -n "$err_code" ]; then
    if [ "$err_code" = "UNAUTHENTICATED" ]; then
      emit_skip "unblocked unauthed; run \`unblocked auth\`"
      return 0
    fi
    printf '%s' "$raw"
    return 2
  fi

  printf '%s' "$raw" | jq -c "$jq_filter"
}

case "$sub" in
  research)
    [ $# -lt 1 ] && usage
    query="$1"; shift
    effort=""
    limit="$DEFAULT_LIMIT"
    while [ $# -gt 0 ]; do
      case "$1" in
        --effort) effort="${2:-}"; shift 2 ;;
        --limit)  limit="${2:-}"; shift 2 ;;
        *) echo "research: unknown arg: $1" >&2; exit 64 ;;
      esac
    done
    args=(context-research --query "$query")
    [ -n "$effort" ] && args+=(--effort "$effort")
    run_unblocked "{summary: (.summary // \"\"), sources: ([.sources[] | {title, url, sourceType}][:$limit])}" "${args[@]}"
    ;;

  search-issues|search-prs|search-messages|search-code|search-documentation)
    [ $# -lt 1 ] && usage
    query="$1"; shift
    limit="$DEFAULT_LIMIT"
    while [ $# -gt 0 ]; do
      case "$1" in
        --limit) limit="${2:-}"; shift 2 ;;
        *) echo "$sub: unknown arg: $1" >&2; exit 64 ;;
      esac
    done
    run_unblocked "{sources: ([.sources[] | {title, url, sourceType}][:$limit])}" \
      "context-$sub" --query "$query"
    ;;

  query-issues|query-prs)
    [ $# -lt 1 ] && usage
    query="$1"; shift
    limit="$DEFAULT_LIMIT"
    projects=()
    user_name=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --projects)  projects+=("${2:-}"); shift 2 ;;
        --user-name) user_name="${2:-}"; shift 2 ;;
        --limit)     limit="${2:-}"; shift 2 ;;
        *) echo "$sub: unknown arg: $1" >&2; exit 64 ;;
      esac
    done
    args=(context-"$sub" --query "$query")
    if [ ${#projects[@]} -gt 0 ]; then
      for p in "${projects[@]}"; do args+=(--projects "$p"); done
    fi
    [ -n "$user_name" ] && args+=(--user-name "$user_name")
    run_unblocked "{sources: ([.sources[] | {title, url, sourceType}][:$limit])}" "${args[@]}"
    ;;

  get-urls)
    [ $# -lt 1 ] && usage
    args=(context-get-urls)
    for u in "$@"; do args+=(--urls "$u"); done
    run_unblocked "." "${args[@]}"
    ;;

  -h|--help|help)
    usage
    ;;

  *)
    echo "Unknown sub-command: $sub" >&2
    usage
    ;;
esac
