#!/usr/bin/env bash
#
# COPIES this repository's commercial history to a PRIVATE GitHub repository
# and verifies the copy. It deletes nothing.
#
# Why this exists: 22500107Zc/LLM is a *public fork* of
# Mintplex-Labs/anything-llm. GitHub does not allow a fork's visibility to be
# changed to private, so the commercial work has to move to a new private
# repository rather than being hidden in place.
#
# Usage:
#   export GITHUB_TOKEN=<a token with repo scope>
#   ./scripts/migrate-to-private-repo.sh <owner>/<new-private-repo>
#
#   ./scripts/migrate-to-private-repo.sh --dry-run <owner>/<new-private-repo>
#
# Removing the public copy is a SEPARATE, explicit action:
#
#   ./scripts/migrate-to-private-repo.sh --remove-public <owner>/<private-repo>
#
# What deleting the public branch does and does not do:
#   It removes the branch from the public repository. It does NOT retract
#   commits that were already published - forks, clones, GitHub's own cached
#   commit views and third-party mirrors may still hold them. Treat anything
#   that was public as public. A private repository protects FUTURE work; it
#   does not un-publish past work.
#
# What it does, in order:
#   1. Refuses unless the target repository exists AND is private.
#   2. Pushes every branch and tag to it.
#   3. Verifies commit parity - twice, independently.
#   4. Repoints this clone's `origin` at the private repository.
#
# It deletes nothing unless --remove-public is given, and even then only after
# both parity checks have passed, so the commercial history is never in only
# one place.
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMMERCIAL_BRANCH="${COMMERCIAL_BRANCH:-claude/commercial-b2b-ai-platform-0skp39}"
PUBLIC_REMOTE_URL="${PUBLIC_REMOTE_URL:-$(git -C "$ROOT" remote get-url origin)}"
DRY_RUN=0

info() { printf '\033[36m[migrate]\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m[migrate]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[migrate]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[migrate]\033[0m %s\n' "$*" >&2; exit 1; }

run() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '\033[2m  would run: %s\033[0m\n' "$*"
    return 0
  fi
  "$@"
}

REMOVE_PUBLIC=0
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --remove-public) REMOVE_PUBLIC=1 ;;
    *) ARGS+=("$arg") ;;
  esac
done
TARGET="${ARGS[0]:-}"

[ -n "$TARGET" ] || die "Usage: $0 [--dry-run] <owner>/<new-private-repo>"
[[ "$TARGET" == */* ]] || die "Target must be <owner>/<repo>, got '$TARGET'."
[ -n "${GITHUB_TOKEN:-}" ] || die "GITHUB_TOKEN is not set. It needs 'repo' scope to read visibility and delete the public branch."
command -v curl >/dev/null 2>&1 || die "curl is required."

api() {
  curl -fsS -X "${2:-GET}" \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/$1" ${3:+-d "$3"}
}

# ------------------------------------------------- 1. the target is private --
info "Checking $TARGET"
META="$(api "repos/$TARGET")" || die "Cannot read $TARGET. Create it first (private, empty, no README) and check the token."
PRIVATE="$(printf '%s' "$META" | python3 -c 'import json,sys; print(json.load(sys.stdin)["private"])')"
[ "$PRIVATE" = "True" ] || die "$TARGET is NOT private. Refusing to push commercial code to a public repository."
ok "$TARGET exists and is private."

# --------------------------------------------------------- 2. push all refs --
info "Pushing every branch and tag to $TARGET"
run git -C "$ROOT" remote remove private 2>/dev/null
run git -C "$ROOT" remote add private "https://github.com/$TARGET.git"
run git -C "$ROOT" push private --all  || die "Pushing branches failed."
run git -C "$ROOT" push private --tags || die "Pushing tags failed."
ok "Pushed."

# -------------------------------------------------- 3. verify parity, twice --
LOCAL_SHA="$(git -C "$ROOT" rev-parse "$COMMERCIAL_BRANCH")"
verify_parity() {
  local label="$1"
  local remote_sha
  remote_sha="$(git -C "$ROOT" ls-remote private "refs/heads/$COMMERCIAL_BRANCH" | awk '{print $1}')"
  [ -n "$remote_sha" ] || { warn "$label: branch not found on the private remote."; return 1; }
  if [ "$remote_sha" != "$LOCAL_SHA" ]; then
    warn "$label: SHA mismatch (local $LOCAL_SHA, remote $remote_sha)."
    return 1
  fi
  local local_count remote_count
  local_count="$(git -C "$ROOT" rev-list --count "$COMMERCIAL_BRANCH")"
  run git -C "$ROOT" fetch -q private "$COMMERCIAL_BRANCH" || return 1
  remote_count="$(git -C "$ROOT" rev-list --count FETCH_HEAD)"
  [ "$local_count" = "$remote_count" ] || {
    warn "$label: commit count mismatch ($local_count vs $remote_count)."; return 1; }
  ok "$label: $COMMERCIAL_BRANCH matches at $LOCAL_SHA ($local_count commits)."
  return 0
}

if [ "$DRY_RUN" = "1" ]; then
  info "Would verify commit parity twice, then repoint origin."
  [ "$REMOVE_PUBLIC" = "1" ] \
    && warn "Would then delete the public commercial branch (--remove-public)." \
    || info "Would delete nothing. Pass --remove-public to remove the public branch."
  exit 0
fi

verify_parity "Verification 1" || die "First parity check failed. Nothing was deleted."
sleep 2
verify_parity "Verification 2" || die "Second parity check failed. Nothing was deleted."

# The LICENSE and NOTICE must have travelled with it.
for f in LICENSE NOTICE; do
  git -C "$ROOT" cat-file -e "$COMMERCIAL_BRANCH:$f" 2>/dev/null \
    && ok "$f is present in the pushed history." \
    || die "$f is missing from $COMMERCIAL_BRANCH. Refusing to continue."
done

# ------------------------------------------------------- 4. repoint origin --
info "Repointing origin at the private repository"
git -C "$ROOT" remote set-url origin "https://github.com/$TARGET.git"
git -C "$ROOT" remote remove private
ok "origin is now $(git -C "$ROOT" remote get-url origin)"

# ------------------- optional, explicit: remove the public commercial copy --
PUBLIC_SLUG="$(printf '%s' "$PUBLIC_REMOTE_URL" | sed -E 's#.*github.com[:/]##; s#\.git$##')"

if [ "$REMOVE_PUBLIC" != "1" ]; then
  echo
  ok "Copy complete and verified. Nothing was deleted."
  echo "  Private repository : https://github.com/$TARGET (private)"
  echo "  Branch             : $COMMERCIAL_BRANCH at $LOCAL_SHA"
  echo "  Public fork        : https://github.com/$PUBLIC_SLUG (unchanged)"
  echo
  info "To remove the public commercial branch, run this again with --remove-public."
  warn "Removing it hides the branch from the public repository. It does NOT retract"
  warn "commits that were already published: forks, clones and cached views may keep"
  warn "them. A private repository protects future work, not past work."
  echo
  warn "Never give the private repository URL to a customer."
  exit 0
fi

echo
warn "About to delete branch '$COMMERCIAL_BRANCH' from the PUBLIC repository $PUBLIC_SLUG."
warn "Its 'master' is untouched upstream code and stays as an ordinary fork."
warn "This hides the branch. It does not retract already-published commits."
printf "Type the public repository name to confirm (%s): " "$PUBLIC_SLUG"
read -r confirmation
[ "$confirmation" = "$PUBLIC_SLUG" ] || die "Confirmation did not match. Nothing was deleted."

api "repos/$PUBLIC_SLUG/git/refs/heads/$COMMERCIAL_BRANCH" DELETE >/dev/null \
  && ok "Public commercial branch removed." \
  || die "Could not delete the public branch. The private copy is complete and verified; remove the public branch by hand."

echo
ok "Migration complete."
echo "  Private repository : https://github.com/$TARGET (private)"
echo "  Branch             : $COMMERCIAL_BRANCH at $LOCAL_SHA"
echo "  Public fork        : https://github.com/$PUBLIC_SLUG (upstream code only)"
echo
warn "Commits published before this point may still exist in forks, clones and"
warn "caches. Rotate anything that was ever a real secret rather than assuming"
warn "deletion retracted it."
warn "Never give the private repository URL to a customer."
