#!/bin/bash
# Sync with upstream OpenClaw repository
#
# Usage:
#   ./scripts/sync-upstream.sh           # Show status
#   ./scripts/sync-upstream.sh fetch     # Fetch upstream
#   ./scripts/sync-upstream.sh diff      # Show diff from upstream
#   ./scripts/sync-upstream.sh merge     # Create merge branch

set -e

UPSTREAM_REMOTE="upstream"
UPSTREAM_URL="https://github.com/openclaw/openclaw.git"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Ensure upstream remote exists
ensure_upstream() {
    if ! git remote get-url "$UPSTREAM_REMOTE" &>/dev/null; then
        log_info "Adding upstream remote: $UPSTREAM_URL"
        git remote add "$UPSTREAM_REMOTE" "$UPSTREAM_URL"
    fi
}

show_status() {
    ensure_upstream

    echo ""
    log_info "Upstream sync status"
    echo ""

    # Current branch
    current_branch=$(git branch --show-current)
    echo "Current branch: $current_branch"

    # Check if upstream/main exists
    if git rev-parse --verify "$UPSTREAM_REMOTE/main" &>/dev/null; then
        upstream_sha=$(git rev-parse "$UPSTREAM_REMOTE/main")
        echo "Upstream main:  ${upstream_sha:0:8}"

        # Commits behind/ahead
        behind=$(git rev-list --count HEAD.."$UPSTREAM_REMOTE/main" 2>/dev/null || echo "?")
        ahead=$(git rev-list --count "$UPSTREAM_REMOTE/main"..HEAD 2>/dev/null || echo "?")
        echo "Behind upstream: $behind commits"
        echo "Ahead of upstream: $ahead commits"
    else
        log_warn "upstream/main not found. Run: ./scripts/sync-upstream.sh fetch"
    fi

    echo ""
    echo "Commands:"
    echo "  ./scripts/sync-upstream.sh fetch   # Fetch upstream changes"
    echo "  ./scripts/sync-upstream.sh diff    # Show diff from upstream"
    echo "  ./scripts/sync-upstream.sh merge   # Create merge branch"
}

do_fetch() {
    ensure_upstream

    log_info "Fetching from upstream..."
    git fetch "$UPSTREAM_REMOTE"

    log_info "Latest upstream commits:"
    git log "$UPSTREAM_REMOTE/main" --oneline -10

    echo ""
    show_status
}

do_diff() {
    ensure_upstream

    if ! git rev-parse --verify "$UPSTREAM_REMOTE/main" &>/dev/null; then
        log_error "upstream/main not found. Run: ./scripts/sync-upstream.sh fetch"
        exit 1
    fi

    log_info "Commits in upstream not in current branch:"
    echo ""
    git log HEAD.."$UPSTREAM_REMOTE/main" --oneline

    echo ""
    log_info "Files changed in upstream:"
    git diff --stat HEAD..."$UPSTREAM_REMOTE/main"
}

do_merge() {
    ensure_upstream

    if ! git rev-parse --verify "$UPSTREAM_REMOTE/main" &>/dev/null; then
        log_error "upstream/main not found. Run: ./scripts/sync-upstream.sh fetch"
        exit 1
    fi

    # Check for uncommitted changes
    if ! git diff-index --quiet HEAD --; then
        log_error "You have uncommitted changes. Please commit or stash them first."
        exit 1
    fi

    # Get upstream version
    upstream_sha=$(git rev-parse "$UPSTREAM_REMOTE/main")
    upstream_short="${upstream_sha:0:8}"

    # Create merge branch
    branch_name="update/upstream-${upstream_short}"

    log_info "Creating merge branch: $branch_name"
    git checkout -b "$branch_name"

    log_info "Merging upstream/main..."
    if git merge "$UPSTREAM_REMOTE/main" --no-edit; then
        log_info "Merge successful!"
        echo ""
        echo "Next steps:"
        echo "  1. Review changes: git diff main"
        echo "  2. Run tests: pnpm test"
        echo "  3. Check i18n: pnpm i18n:check (if available)"
        echo "  4. Merge to main: git checkout main && git merge $branch_name"
    else
        log_warn "Merge has conflicts. Please resolve them."
        echo ""
        echo "Conflicting files:"
        git diff --name-only --diff-filter=U
        echo ""
        echo "After resolving conflicts:"
        echo "  1. Stage resolved files: git add <file>"
        echo "  2. Complete merge: git commit"
        echo "  3. Run tests: pnpm test"
    fi
}

# Main
case "${1:-status}" in
    status)
        show_status
        ;;
    fetch)
        do_fetch
        ;;
    diff)
        do_diff
        ;;
    merge)
        do_merge
        ;;
    *)
        echo "Usage: $0 {status|fetch|diff|merge}"
        exit 1
        ;;
esac
