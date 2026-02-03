#!/usr/bin/env bash
# =============================================================================
# NooviAI OpenClaw CLI Installer (Non-root)
# https://nooviai.com/install-cli.sh
#
# Installs OpenClaw into a user prefix with its own Node.js runtime.
# No root/sudo required.
#
# Usage:
#   curl -fsSL https://nooviai.com/install-cli.sh | bash
#   curl -fsSL https://nooviai.com/install-cli.sh | bash -s -- --help
#   curl -fsSL https://nooviai.com/install-cli.sh | bash -s -- --prefix ~/.nooviai
#
# Environment variables:
#   NOOVI_PREFIX            - Installation prefix (default: ~/.openclaw)
#   NOOVI_VERSION           - Version to install (default: latest)
#   NOOVI_BETA              - Set to 1 for beta channel
#   NOOVI_NO_ONBOARD        - Skip onboarding wizard
#   NOOVI_NPM_PACKAGE       - npm package name (default: openclaw)
# =============================================================================

set -euo pipefail

# -----------------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------------

NOOVI_PREFIX="${NOOVI_PREFIX:-$HOME/.openclaw}"
NOOVI_VERSION="${NOOVI_VERSION:-latest}"
NOOVI_BETA="${NOOVI_BETA:-0}"
NOOVI_NO_ONBOARD="${NOOVI_NO_ONBOARD:-0}"
NOOVI_NO_PROMPT="${NOOVI_NO_PROMPT:-0}"
NOOVI_NPM_PACKAGE="${NOOVI_NPM_PACKAGE:-github:Noovi-AI/NooviAi-OpenClaw}"
NOOVI_SET_NPM_PREFIX="${NOOVI_SET_NPM_PREFIX:-0}"
NOOVI_VERBOSE="${NOOVI_VERBOSE:-0}"

# Node.js version to install
NODE_VERSION="22"

# Avoid sharp native build issues
export SHARP_IGNORE_GLOBAL_LIBVIPS="${SHARP_IGNORE_GLOBAL_LIBVIPS:-1}"

# Colors
if [[ -t 1 ]]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  BLUE='\033[0;34m'
  CYAN='\033[0;36m'
  BOLD='\033[1m'
  NC='\033[0m'
else
  RED='' GREEN='' YELLOW='' BLUE='' CYAN='' BOLD='' NC=''
fi

# -----------------------------------------------------------------------------
# Utility functions
# -----------------------------------------------------------------------------

log_info() { echo -e "${BLUE}[INFO]${NC} $*"; }
log_success() { echo -e "${GREEN}[OK]${NC} $*"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $*" >&2; }
log_error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
log_verbose() { [[ "$NOOVI_VERBOSE" == "1" ]] && echo -e "${CYAN}[DEBUG]${NC} $*"; }

die() { log_error "$@"; exit 1; }

command_exists() { command -v "$1" >/dev/null 2>&1; }

is_macos() { [[ "$(uname -s)" == "Darwin" ]]; }
is_linux() { [[ "$(uname -s)" == "Linux" ]]; }

is_interactive() { [[ -t 0 && "$NOOVI_NO_PROMPT" != "1" ]]; }

get_arch() {
  local arch
  arch=$(uname -m)
  case "$arch" in
    x86_64|amd64) echo "x64" ;;
    aarch64|arm64) echo "arm64" ;;
    armv7l|armv7) echo "armv7l" ;;
    *) die "Unsupported architecture: $arch" ;;
  esac
}

get_os() {
  if is_macos; then
    echo "darwin"
  elif is_linux; then
    echo "linux"
  else
    die "Unsupported OS: $(uname -s)"
  fi
}

# -----------------------------------------------------------------------------
# Help
# -----------------------------------------------------------------------------

show_help() {
  cat << 'EOF'

  NooviAI OpenClaw CLI Installer (Non-root)

USAGE:
  curl -fsSL https://nooviai.com/install-cli.sh | bash [-- OPTIONS]

OPTIONS:
  --help, -h              Show this help message
  --prefix DIR            Installation prefix (default: ~/.openclaw)
  --version VERSION       Install specific version (default: latest)
  --beta                  Install beta version
  --no-onboard            Skip onboarding wizard
  --set-npm-prefix        Configure npm to use the prefix for global installs
  --verbose               Enable verbose output

ENVIRONMENT VARIABLES:
  NOOVI_PREFIX            Installation prefix
  NOOVI_VERSION           Version to install
  NOOVI_BETA              Set to 1 for beta channel
  NOOVI_NO_ONBOARD        Set to 1 to skip onboarding
  NOOVI_NPM_PACKAGE       npm package name

EXAMPLES:
  # Standard installation
  curl -fsSL https://nooviai.com/install-cli.sh | bash

  # Custom prefix
  curl -fsSL https://nooviai.com/install-cli.sh | bash -s -- --prefix ~/.nooviai

  # Beta version
  curl -fsSL https://nooviai.com/install-cli.sh | bash -s -- --beta

EOF
  exit 0
}

# -----------------------------------------------------------------------------
# Parse arguments
# -----------------------------------------------------------------------------

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --help|-h) show_help ;;
      --prefix) NOOVI_PREFIX="$2"; shift 2 ;;
      --version) NOOVI_VERSION="$2"; shift 2 ;;
      --beta) NOOVI_BETA=1; shift ;;
      --no-onboard) NOOVI_NO_ONBOARD=1; shift ;;
      --set-npm-prefix) NOOVI_SET_NPM_PREFIX=1; shift ;;
      --verbose) NOOVI_VERBOSE=1; shift ;;
      *) log_warn "Unknown option: $1"; shift ;;
    esac
  done
}

# -----------------------------------------------------------------------------
# Install Node.js
# -----------------------------------------------------------------------------

install_node() {
  local os arch node_url node_archive node_dir

  os=$(get_os)
  arch=$(get_arch)

  log_info "Installing Node.js $NODE_VERSION for $os-$arch..."

  # Get latest Node.js version in the major version
  local node_full_version
  node_full_version=$(curl -fsSL "https://nodejs.org/dist/latest-v${NODE_VERSION}.x/" | \
    grep -oE "node-v${NODE_VERSION}\.[0-9]+\.[0-9]+" | head -1 | sed 's/node-//')

  if [[ -z "$node_full_version" ]]; then
    die "Failed to determine Node.js version"
  fi

  log_info "Node.js version: $node_full_version"

  node_archive="node-v${node_full_version}-${os}-${arch}.tar.gz"
  node_url="https://nodejs.org/dist/v${node_full_version}/${node_archive}"
  node_dir="node-v${node_full_version}-${os}-${arch}"

  local tmp_dir
  tmp_dir=$(mktemp -d)
  cd "$tmp_dir"

  log_info "Downloading Node.js..."
  curl -fsSL -o "$node_archive" "$node_url"

  log_info "Extracting Node.js..."
  tar -xzf "$node_archive"

  # Move to prefix
  mkdir -p "$NOOVI_PREFIX"
  rm -rf "${NOOVI_PREFIX:?}/node"
  mv "$node_dir" "$NOOVI_PREFIX/node"

  # Cleanup
  cd /
  rm -rf "$tmp_dir"

  log_success "Node.js $node_full_version installed to $NOOVI_PREFIX/node"
}

# -----------------------------------------------------------------------------
# Install OpenClaw
# -----------------------------------------------------------------------------

install_openclaw() {
  local node_bin="$NOOVI_PREFIX/node/bin"
  local npm="$node_bin/npm"
  local node="$node_bin/node"

  # Verify Node.js installation
  if [[ ! -x "$node" ]]; then
    die "Node.js not found at $node"
  fi

  log_info "Using Node.js: $("$node" --version)"

  # Set npm prefix to our directory
  export npm_config_prefix="$NOOVI_PREFIX"

  # Determine package spec
  local package_spec="$NOOVI_NPM_PACKAGE"

  if [[ "$NOOVI_BETA" == "1" ]]; then
    log_info "Using beta channel..."
    local beta_version
    beta_version=$("$npm" view "$NOOVI_NPM_PACKAGE" dist-tags.beta 2>/dev/null || echo "")
    if [[ -n "$beta_version" ]]; then
      package_spec="$NOOVI_NPM_PACKAGE@$beta_version"
    else
      package_spec="$NOOVI_NPM_PACKAGE@latest"
    fi
  elif [[ "$NOOVI_VERSION" != "latest" ]]; then
    package_spec="$NOOVI_NPM_PACKAGE@$NOOVI_VERSION"
  else
    package_spec="$NOOVI_NPM_PACKAGE@latest"
  fi

  log_info "Installing: $package_spec"

  # Install with npm
  "$npm" install -g "$package_spec" --loglevel=error

  log_success "OpenClaw installed to $NOOVI_PREFIX"
}

# -----------------------------------------------------------------------------
# Setup PATH
# -----------------------------------------------------------------------------

setup_path() {
  local bin_dir="$NOOVI_PREFIX/bin"
  local node_bin="$NOOVI_PREFIX/node/bin"
  local path_export="export PATH=\"$bin_dir:$node_bin:\$PATH\""

  # Add to shell config files
  for rc_file in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
    if [[ -f "$rc_file" ]]; then
      if ! grep -q "$NOOVI_PREFIX" "$rc_file" 2>/dev/null; then
        log_info "Adding to $rc_file..."
        echo "" >> "$rc_file"
        echo "# NooviAI OpenClaw" >> "$rc_file"
        echo "$path_export" >> "$rc_file"
      fi
    fi
  done

  # Export for current session
  export PATH="$bin_dir:$node_bin:$PATH"

  log_success "PATH configured"

  echo ""
  echo "To use openclaw in the current session, run:"
  echo ""
  echo "  export PATH=\"$bin_dir:$node_bin:\$PATH\""
  echo ""
  echo "Or open a new terminal."
}

# -----------------------------------------------------------------------------
# Configure npm prefix (optional)
# -----------------------------------------------------------------------------

configure_npm_prefix() {
  if [[ "$NOOVI_SET_NPM_PREFIX" != "1" ]]; then
    return 0
  fi

  local npm="$NOOVI_PREFIX/node/bin/npm"

  log_info "Configuring npm prefix to $NOOVI_PREFIX..."
  "$npm" config set prefix "$NOOVI_PREFIX"

  log_success "npm prefix configured"
}

# -----------------------------------------------------------------------------
# Post-installation
# -----------------------------------------------------------------------------

run_doctor() {
  local openclaw="$NOOVI_PREFIX/bin/openclaw"

  if [[ -x "$openclaw" ]]; then
    log_info "Running openclaw doctor..."
    "$openclaw" doctor --non-interactive || true
  fi
}

run_onboarding() {
  if [[ "$NOOVI_NO_ONBOARD" == "1" ]]; then
    log_info "Skipping onboarding (--no-onboard)"
    return 0
  fi

  if ! is_interactive; then
    log_info "Skipping onboarding (non-interactive mode)"
    return 0
  fi

  local openclaw="$NOOVI_PREFIX/bin/openclaw"

  if [[ -x "$openclaw" ]]; then
    log_info "Starting onboarding wizard..."
    "$openclaw" onboard || true
  fi
}

# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------

main() {
  echo ""
  echo -e "${BOLD}${CYAN}"
  cat << 'BANNER'
  _   _                 _    _    ___
 | \ | | ___   _____  _(_)  / \  |_ _|
 |  \| |/ _ \ / _ \ \ / / | / _ \  | |
 | |\  | (_) | (_) \ V /| |/ ___ \ | |
 |_| \_|\___/ \___/ \_/ |_/_/   \_\___|

  OpenClaw CLI Installer (Non-root)
BANNER
  echo -e "${NC}"
  echo ""

  parse_args "$@"

  log_info "Installation prefix: $NOOVI_PREFIX"

  # Install Node.js
  install_node

  # Install OpenClaw
  install_openclaw

  # Configure npm prefix if requested
  configure_npm_prefix

  # Setup PATH
  setup_path

  # Run doctor
  run_doctor

  echo ""
  echo -e "${GREEN}${BOLD}Installation complete!${NC}"
  echo ""
  echo "Installation directory: $NOOVI_PREFIX"
  echo ""

  # Run onboarding
  run_onboarding
}

main "$@"
