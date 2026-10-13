#!/usr/bin/env bash
# Run btrain's CI checks inside the Linux image hosted CI uses, on this Mac
# (OrbStack provides the docker daemon). The image carries Node 22, git 2.55,
# jq and ast-grep 0.45.3, which is where Linux-only failures show up that
# scripts/ci-local.sh cannot reproduce on macOS (init.defaultBranch, git
# auto-maintenance, case-sensitive paths).
#
# The repository is bind-mounted at its own absolute path so a linked
# worktree's `.git` pointer (an absolute path into the main checkout's
# .git/worktrees) still resolves inside the container.
#
# Usage: scripts/ci-container.sh [--image <name>] [--main <main checkout>] [-- <ci-local.sh args>]
#   --image <name>  docker image (default btrain-ci:latest, built from
#                   scripts/ci-container.Dockerfile on top of btrain-git255
#                   when missing)
#   --main <path>   the main checkout whose .git the worktree shares
#                   (default: git rev-parse --git-common-dir's parent)
#   anything after -- goes to scripts/ci-local.sh (e.g. -- --no-formal)
set -u

IMAGE="btrain-ci:latest"
MAIN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --image) [ $# -ge 2 ] || { echo "ci-container: --image needs a value" >&2; exit 2; }; IMAGE="$2"; shift 2 ;;
    --main) [ $# -ge 2 ] || { echo "ci-container: --main needs a path" >&2; exit 2; }; MAIN="$2"; shift 2 ;;
    --) shift; break ;;
    -h|--help) awk 'NR > 1 && /^#/ { print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    *) echo "ci-container: unknown option $1 (pass ci-local.sh options after --)" >&2; exit 2 ;;
  esac
done

ROOT="$(git rev-parse --show-toplevel)" || exit 2
if [ -z "$MAIN" ]; then
  COMMON="$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || git -C "$ROOT" rev-parse --git-common-dir)"
  case "$COMMON" in /*) ;; *) COMMON="$ROOT/$COMMON" ;; esac
  MAIN="$(dirname "$COMMON")"
fi
command -v docker >/dev/null || { echo "ci-container: docker not on PATH (start OrbStack)" >&2; exit 2; }
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  if [ "$IMAGE" = "btrain-ci:latest" ]; then
    echo "ci-container: building $IMAGE from scripts/ci-container.Dockerfile" >&2
    docker build -q -f "$ROOT/scripts/ci-container.Dockerfile" -t "$IMAGE" "$ROOT/scripts" >/dev/null || exit 2
  else
    echo "ci-container: image $IMAGE not found" >&2; exit 2
  fi
fi

# The container runs as the Mac user's uid, not root: the hosted runner is
# unprivileged too, and tests that rely on permission bits (an unreadable
# template file, an executable check) pass vacuously as root. That uid has no
# passwd entry in the image, so HOME is a mounted cache dir, which also keeps
# the Python venv and npm cache between runs. git still wants safe.directory
# because the bind mount's ownership is reported differently inside. Step
# logs land under the host's cache dir so they outlive the container.
# node_modules from the Mac are reused: btrain's only dev dependency is pure
# JavaScript.
CACHE_HOST="${XDG_CACHE_HOME:-$HOME/.cache}/btrain-ci"
LOG_HOST="$CACHE_HOST/container-logs"
HOME_HOST="$CACHE_HOST/container-home"
mkdir -p "$LOG_HOST" "$HOME_HOST"
echo "ci-container: step logs under $LOG_HOST" >&2
exec docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v "$MAIN:$MAIN" \
  -v "$LOG_HOST:/ci-logs" \
  -v "$HOME_HOST:/ci-home" \
  -w "$ROOT" \
  -e HOME=/ci-home -e CI=true -e BTRAIN_NO_REVIEW_DISPATCH=1 -e BTRAIN_CI_LOG_DIR=/ci-logs \
  "$IMAGE" bash -lc "git config --global --add safe.directory '*' && exec scripts/ci-local.sh $*"
