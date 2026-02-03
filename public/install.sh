#!/usr/bin/env bash
# =============================================================================
# NooviAI OpenClaw Installer
# https://openclaw.nooviai.com/install.sh
#
# Usage:
#   curl -fsSL https://openclaw.nooviai.com/install.sh | bash
#   curl -fsSL https://openclaw.nooviai.com/install.sh | bash -s -- --help
#   curl -fsSL https://openclaw.nooviai.com/install.sh | bash -s -- --beta
#   curl -fsSL https://openclaw.nooviai.com/install.sh | bash -s -- --install-method git
#
# Environment variables:
#   NOOVI_VERSION           - Version to install (default: latest)
#   NOOVI_BETA              - Set to 1 for beta channel
#   NOOVI_INSTALL_METHOD    - "npm" or "git" (default: npm)
#   NOOVI_GIT_DIR           - Directory for git checkout (default: ~/nooviai-openclaw)
#   NOOVI_GIT_REPO          - Git repository URL
#   NOOVI_GIT_BRANCH        - Git branch to checkout (default: main)
#   NOOVI_NO_ONBOARD        - Skip onboarding wizard
#   NOOVI_NO_PROMPT         - Disable interactive prompts (for CI)
#   NOOVI_NPM_PACKAGE       - npm package name (default: openclaw)
#   SHARP_IGNORE_GLOBAL_LIBVIPS - Set to 0 to use system libvips
# =============================================================================

set -euo pipefail

# -----------------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------------

NOOVI_VERSION="${NOOVI_VERSION:-latest}"
NOOVI_BETA="${NOOVI_BETA:-0}"
NOOVI_INSTALL_METHOD="${NOOVI_INSTALL_METHOD:-git}"
NOOVI_GIT_DIR="${NOOVI_GIT_DIR:-$HOME/nooviai-openclaw}"
NOOVI_GIT_REPO="${NOOVI_GIT_REPO:-https://github.com/Noovi-AI/NooviAi-OpenClaw.git}"
NOOVI_GIT_BRANCH="${NOOVI_GIT_BRANCH:-main}"
NOOVI_GIT_UPDATE="${NOOVI_GIT_UPDATE:-1}"
NOOVI_NO_ONBOARD="${NOOVI_NO_ONBOARD:-0}"
NOOVI_NO_PROMPT="${NOOVI_NO_PROMPT:-0}"
NOOVI_NPM_PACKAGE="${NOOVI_NPM_PACKAGE:-openclaw}"
NOOVI_NPM_LOGLEVEL="${NOOVI_NPM_LOGLEVEL:-error}"
NOOVI_VERBOSE="${NOOVI_VERBOSE:-0}"

# Avoid sharp native build issues by default
export SHARP_IGNORE_GLOBAL_LIBVIPS="${SHARP_IGNORE_GLOBAL_LIBVIPS:-1}"

# Minimum Node.js version required
MIN_NODE_VERSION=22

# Colors (disabled if not a terminal)
if [[ -t 1 ]]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  BLUE='\033[0;34m'
  CYAN='\033[0;36m'
  BOLD='\033[1m'
  NC='\033[0m' # No Color
else
  RED='' GREEN='' YELLOW='' BLUE='' CYAN='' BOLD='' NC=''
fi

# -----------------------------------------------------------------------------
# Utility functions
# -----------------------------------------------------------------------------

log_info() {
  echo -e "${BLUE}[INFO]${NC} $*"
}

log_success() {
  echo -e "${GREEN}[OK]${NC} $*"
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $*" >&2
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $*" >&2
}

log_verbose() {
  if [[ "$NOOVI_VERBOSE" == "1" ]]; then
    echo -e "${CYAN}[DEBUG]${NC} $*"
  fi
}

die() {
  log_error "$@"
  exit 1
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

is_macos() {
  [[ "$(uname -s)" == "Darwin" ]]
}

is_linux() {
  [[ "$(uname -s)" == "Linux" ]]
}

is_wsl() {
  is_linux && grep -qiE "(microsoft|wsl)" /proc/version 2>/dev/null
}

is_interactive() {
  [[ -t 0 && "$NOOVI_NO_PROMPT" != "1" ]]
}

get_node_version() {
  if command_exists node; then
    node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1
  else
    echo "0"
  fi
}

prompt_yes_no() {
  local prompt="$1"
  local default="${2:-n}"

  if ! is_interactive; then
    [[ "$default" == "y" ]] && return 0 || return 1
  fi

  local yn
  while true; do
    read -rp "$prompt " yn
    case "${yn:-$default}" in
      [Yy]* ) return 0 ;;
      [Nn]* ) return 1 ;;
      * ) echo "Please answer yes or no." ;;
    esac
  done
}

# Retry a command up to N times
retry() {
  local max_attempts="$1"
  local delay="$2"
  shift 2
  local cmd=("$@")

  for ((attempt=1; attempt<=max_attempts; attempt++)); do
    if "${cmd[@]}"; then
      return 0
    fi
    if ((attempt < max_attempts)); then
      log_warn "Command failed (attempt $attempt/$max_attempts). Retrying in ${delay}s..."
      sleep "$delay"
    fi
  done

  log_error "Command failed after $max_attempts attempts: ${cmd[*]}"
  return 1
}

# -----------------------------------------------------------------------------
# Help / Usage
# -----------------------------------------------------------------------------

show_help() {
  cat << 'EOF'

  _   _                 _    _    ___
 | \ | | ___   _____  _(_)  / \  |_ _|
 |  \| |/ _ \ / _ \ \ / / | / _ \  | |
 | |\  | (_) | (_) \ V /| |/ ___ \ | |
 |_| \_|\___/ \___/ \_/ |_/_/   \_\___|

  NooviAI OpenClaw Installer

USAGE:
  curl -fsSL https://openclaw.nooviai.com/install.sh | bash [-- OPTIONS]

OPTIONS:
  --help, -h              Show this help message
  --version VERSION       Install specific version (default: latest)
  --beta                  Install beta version
  --install-method METHOD Installation method: npm (default) or git
  --git-dir DIR           Directory for git checkout (default: ~/nooviai-openclaw)
  --git-branch BRANCH     Git branch to checkout (default: main)
  --no-onboard            Skip the onboarding wizard after install
  --no-prompt             Disable interactive prompts (for CI/automation)
  --verbose               Enable verbose output

ENVIRONMENT VARIABLES:
  NOOVI_VERSION           Version to install
  NOOVI_BETA              Set to 1 for beta channel
  NOOVI_INSTALL_METHOD    "npm" or "git"
  NOOVI_GIT_DIR           Git checkout directory
  NOOVI_GIT_REPO          Git repository URL
  NOOVI_GIT_BRANCH        Git branch
  NOOVI_NO_ONBOARD        Set to 1 to skip onboarding
  NOOVI_NO_PROMPT         Set to 1 to disable prompts
  NOOVI_NPM_PACKAGE       npm package name (default: openclaw)

EXAMPLES:
  # Standard installation (npm)
  curl -fsSL https://openclaw.nooviai.com/install.sh | bash

  # Install beta version
  curl -fsSL https://openclaw.nooviai.com/install.sh | bash -s -- --beta

  # Install from git
  curl -fsSL https://openclaw.nooviai.com/install.sh | bash -s -- --install-method git

  # Install specific version
  curl -fsSL https://openclaw.nooviai.com/install.sh | bash -s -- --version 2026.2.1

  # CI/Headless installation
  NOOVI_NO_PROMPT=1 curl -fsSL https://openclaw.nooviai.com/install.sh | bash

EOF
  exit 0
}

# -----------------------------------------------------------------------------
# Parse command line arguments
# -----------------------------------------------------------------------------

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --help|-h)
        show_help
        ;;
      --version)
        NOOVI_VERSION="$2"
        shift 2
        ;;
      --beta)
        NOOVI_BETA=1
        shift
        ;;
      --install-method)
        NOOVI_INSTALL_METHOD="$2"
        shift 2
        ;;
      --git-dir)
        NOOVI_GIT_DIR="$2"
        shift 2
        ;;
      --git-branch)
        NOOVI_GIT_BRANCH="$2"
        shift 2
        ;;
      --no-onboard)
        NOOVI_NO_ONBOARD=1
        shift
        ;;
      --no-prompt)
        NOOVI_NO_PROMPT=1
        shift
        ;;
      --verbose)
        NOOVI_VERBOSE=1
        shift
        ;;
      *)
        log_warn "Unknown option: $1"
        shift
        ;;
    esac
  done
}

# -----------------------------------------------------------------------------
# OS-specific setup
# -----------------------------------------------------------------------------

ensure_homebrew() {
  if ! command_exists brew; then
    log_info "Installing Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

    # Add Homebrew to PATH for this session
    if [[ -f /opt/homebrew/bin/brew ]]; then
      eval "$(/opt/homebrew/bin/brew shellenv)"
    elif [[ -f /usr/local/bin/brew ]]; then
      eval "$(/usr/local/bin/brew shellenv)"
    fi
  fi
  log_success "Homebrew is available"
}

ensure_node_macos() {
  local current_version
  current_version=$(get_node_version)

  if ((current_version >= MIN_NODE_VERSION)); then
    log_success "Node.js v$current_version is installed (>= $MIN_NODE_VERSION required)"
    return 0
  fi

  log_info "Node.js $MIN_NODE_VERSION+ required. Installing via Homebrew..."
  ensure_homebrew

  if ((current_version > 0)); then
    log_info "Upgrading Node.js from v$current_version..."
    brew upgrade node || brew install node
  else
    brew install node
  fi

  # Verify installation
  current_version=$(get_node_version)
  if ((current_version < MIN_NODE_VERSION)); then
    die "Failed to install Node.js $MIN_NODE_VERSION+. Got v$current_version"
  fi

  log_success "Node.js v$current_version installed"
}

detect_linux_distro() {
  if [[ -f /etc/os-release ]]; then
    # shellcheck source=/dev/null
    . /etc/os-release
    echo "${ID:-unknown}"
  elif command_exists lsb_release; then
    lsb_release -is | tr '[:upper:]' '[:lower:]'
  else
    echo "unknown"
  fi
}

ensure_node_linux() {
  local current_version
  current_version=$(get_node_version)

  if ((current_version >= MIN_NODE_VERSION)); then
    log_success "Node.js v$current_version is installed (>= $MIN_NODE_VERSION required)"
    return 0
  fi

  local distro
  distro=$(detect_linux_distro)
  log_info "Detected Linux distribution: $distro"
  log_info "Node.js $MIN_NODE_VERSION+ required. Installing..."

  case "$distro" in
    ubuntu|debian|linuxmint|pop)
      install_node_debian
      ;;
    centos|rhel|fedora|rocky|almalinux|amzn)
      install_node_rhel
      ;;
    arch|manjaro)
      install_node_arch
      ;;
    alpine)
      install_node_alpine
      ;;
    *)
      log_warn "Unknown distribution: $distro. Trying NodeSource..."
      install_node_debian
      ;;
  esac

  # Verify installation
  current_version=$(get_node_version)
  if ((current_version < MIN_NODE_VERSION)); then
    die "Failed to install Node.js $MIN_NODE_VERSION+. Got v$current_version"
  fi

  log_success "Node.js v$current_version installed"
}

install_node_debian() {
  local sudo_cmd=""
  if [[ $EUID -ne 0 ]]; then
    sudo_cmd="sudo"
  fi

  log_info "Installing Node.js via NodeSource (Debian/Ubuntu)..."

  # Install prerequisites
  $sudo_cmd apt-get update -qq
  $sudo_cmd apt-get install -y -qq ca-certificates curl gnupg

  # Add NodeSource GPG key
  $sudo_cmd mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | \
    $sudo_cmd gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg --yes

  # Add NodeSource repository
  local node_major=$MIN_NODE_VERSION
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$node_major.x nodistro main" | \
    $sudo_cmd tee /etc/apt/sources.list.d/nodesource.list >/dev/null

  # Install Node.js
  $sudo_cmd apt-get update -qq
  $sudo_cmd apt-get install -y -qq nodejs

  # Install build tools for native modules
  $sudo_cmd apt-get install -y -qq build-essential || true
}

install_node_rhel() {
  local sudo_cmd=""
  if [[ $EUID -ne 0 ]]; then
    sudo_cmd="sudo"
  fi

  log_info "Installing Node.js via NodeSource (RHEL/CentOS/Fedora)..."

  # Add NodeSource repository
  local node_major=$MIN_NODE_VERSION
  curl -fsSL "https://rpm.nodesource.com/setup_$node_major.x" | $sudo_cmd bash -

  # Install Node.js
  if command_exists dnf; then
    $sudo_cmd dnf install -y nodejs
  else
    $sudo_cmd yum install -y nodejs
  fi

  # Install build tools
  if command_exists dnf; then
    $sudo_cmd dnf groupinstall -y "Development Tools" || true
  else
    $sudo_cmd yum groupinstall -y "Development Tools" || true
  fi
}

install_node_arch() {
  local sudo_cmd=""
  if [[ $EUID -ne 0 ]]; then
    sudo_cmd="sudo"
  fi

  log_info "Installing Node.js via pacman (Arch Linux)..."
  $sudo_cmd pacman -Sy --noconfirm nodejs npm
}

install_node_alpine() {
  local sudo_cmd=""
  if [[ $EUID -ne 0 ]]; then
    sudo_cmd="sudo"
  fi

  log_info "Installing Node.js via apk (Alpine)..."
  $sudo_cmd apk add --no-cache nodejs npm
}

ensure_git() {
  if command_exists git; then
    log_verbose "Git is available: $(git --version)"
    return 0
  fi

  log_info "Installing Git..."

  if is_macos; then
    ensure_homebrew
    brew install git
  elif is_linux; then
    local sudo_cmd=""
    [[ $EUID -ne 0 ]] && sudo_cmd="sudo"

    local distro
    distro=$(detect_linux_distro)

    case "$distro" in
      ubuntu|debian|linuxmint|pop)
        $sudo_cmd apt-get update -qq
        $sudo_cmd apt-get install -y -qq git
        ;;
      centos|rhel|fedora|rocky|almalinux|amzn)
        if command_exists dnf; then
          $sudo_cmd dnf install -y git
        else
          $sudo_cmd yum install -y git
        fi
        ;;
      arch|manjaro)
        $sudo_cmd pacman -Sy --noconfirm git
        ;;
      alpine)
        $sudo_cmd apk add --no-cache git
        ;;
      *)
        die "Cannot install Git on unknown distribution: $distro"
        ;;
    esac
  fi

  log_success "Git installed"
}

# -----------------------------------------------------------------------------
# npm PATH and permissions
# -----------------------------------------------------------------------------

setup_npm_prefix() {
  # On Linux, npm global installs often fail with EACCES
  # Fix by using ~/.npm-global as the prefix

  if is_macos; then
    return 0  # Usually not needed on macOS with Homebrew
  fi

  local npm_prefix
  npm_prefix=$(npm config get prefix 2>/dev/null || echo "")

  # If prefix is /usr or /usr/local, switch to user directory
  if [[ "$npm_prefix" == "/usr" || "$npm_prefix" == "/usr/local" ]]; then
    local user_prefix="$HOME/.npm-global"

    log_info "Configuring npm to use user-local prefix: $user_prefix"
    mkdir -p "$user_prefix"
    npm config set prefix "$user_prefix"

    # Add to PATH in shell config files
    local npm_bin="$user_prefix/bin"
    local path_export="export PATH=\"$npm_bin:\$PATH\""

    for rc_file in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
      if [[ -f "$rc_file" ]]; then
        if ! grep -q "$npm_bin" "$rc_file" 2>/dev/null; then
          log_verbose "Adding npm bin to $rc_file"
          echo "" >> "$rc_file"
          echo "# NooviAI OpenClaw - npm global bin" >> "$rc_file"
          echo "$path_export" >> "$rc_file"
        fi
      fi
    done

    # Export for current session
    export PATH="$npm_bin:$PATH"

    log_success "npm prefix configured: $user_prefix"
  fi
}

# -----------------------------------------------------------------------------
# Installation methods
# -----------------------------------------------------------------------------

install_via_npm() {
  log_info "Installing NooviAI OpenClaw via npm..."

  local package_spec="$NOOVI_NPM_PACKAGE"

  # Determine version
  if [[ "$NOOVI_BETA" == "1" ]]; then
    log_info "Using beta channel..."
    local beta_version
    beta_version=$(npm view "$NOOVI_NPM_PACKAGE" dist-tags.beta 2>/dev/null || echo "")
    if [[ -n "$beta_version" ]]; then
      package_spec="$NOOVI_NPM_PACKAGE@$beta_version"
      log_info "Beta version: $beta_version"
    else
      log_warn "No beta version found, using latest"
      package_spec="$NOOVI_NPM_PACKAGE@latest"
    fi
  elif [[ "$NOOVI_VERSION" != "latest" ]]; then
    package_spec="$NOOVI_NPM_PACKAGE@$NOOVI_VERSION"
  else
    package_spec="$NOOVI_NPM_PACKAGE@latest"
  fi

  log_info "Installing: $package_spec"

  # Run npm install with retry
  retry 3 2 npm install -g "$package_spec" --loglevel="$NOOVI_NPM_LOGLEVEL"

  # Verify installation
  if ! command_exists openclaw; then
    # Try to find it in common locations
    local possible_paths=(
      "$HOME/.npm-global/bin/openclaw"
      "/usr/local/bin/openclaw"
      "/usr/bin/openclaw"
    )

    for path in "${possible_paths[@]}"; do
      if [[ -x "$path" ]]; then
        log_warn "openclaw installed but not in PATH. Found at: $path"
        log_info "Add the following to your shell config:"
        echo "  export PATH=\"$(dirname "$path"):\$PATH\""
        break
      fi
    done

    die "Installation completed but 'openclaw' command not found in PATH"
  fi

  local installed_version
  installed_version=$(openclaw --version 2>/dev/null || echo "unknown")
  log_success "NooviAI OpenClaw v$installed_version installed via npm"
}

install_via_git() {
  log_info "Installing NooviAI OpenClaw via git..."

  ensure_git

  local install_dir="$NOOVI_GIT_DIR"

  if [[ -d "$install_dir" ]]; then
    if [[ "$NOOVI_GIT_UPDATE" == "1" ]]; then
      log_info "Updating existing checkout at $install_dir..."
      cd "$install_dir"
      git fetch origin
      git checkout "$NOOVI_GIT_BRANCH"
      git pull --rebase origin "$NOOVI_GIT_BRANCH"
    else
      log_info "Using existing checkout at $install_dir (NOOVI_GIT_UPDATE=0)"
      cd "$install_dir"
    fi
  else
    log_info "Cloning repository to $install_dir..."
    git clone --branch "$NOOVI_GIT_BRANCH" "$NOOVI_GIT_REPO" "$install_dir"
    cd "$install_dir"
  fi

  # Install pnpm if not available
  if ! command_exists pnpm; then
    log_info "Installing pnpm..."
    npm install -g pnpm@latest
  fi

  # Install dependencies and build
  log_info "Installing dependencies..."
  pnpm install --frozen-lockfile || pnpm install

  log_info "Building..."
  pnpm build

  # Create wrapper script
  local bin_dir="$HOME/.local/bin"
  mkdir -p "$bin_dir"

  local wrapper_script="$bin_dir/openclaw"
  cat > "$wrapper_script" << WRAPPER
#!/usr/bin/env bash
# NooviAI OpenClaw wrapper (git install)
# Source: $install_dir
exec node "$install_dir/openclaw.mjs" "\$@"
WRAPPER
  chmod +x "$wrapper_script"

  # Add to PATH if needed
  if [[ ":$PATH:" != *":$bin_dir:"* ]]; then
    local path_export="export PATH=\"$bin_dir:\$PATH\""

    for rc_file in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
      if [[ -f "$rc_file" ]]; then
        if ! grep -q "$bin_dir" "$rc_file" 2>/dev/null; then
          log_verbose "Adding $bin_dir to $rc_file"
          echo "" >> "$rc_file"
          echo "# NooviAI OpenClaw - local bin" >> "$rc_file"
          echo "$path_export" >> "$rc_file"
        fi
      fi
    done

    export PATH="$bin_dir:$PATH"
  fi

  local installed_version
  installed_version=$("$wrapper_script" --version 2>/dev/null || echo "unknown")
  log_success "NooviAI OpenClaw v$installed_version installed via git"
  log_info "Source directory: $install_dir"
}

# -----------------------------------------------------------------------------
# Post-installation
# -----------------------------------------------------------------------------

run_doctor() {
  if command_exists openclaw; then
    log_info "Running openclaw doctor..."
    openclaw doctor --non-interactive || true
  fi
}

run_onboarding() {
  if [[ "$NOOVI_NO_ONBOARD" == "1" ]]; then
    log_info "Skipping onboarding (--no-onboard)"
    return 0
  fi

  if [[ "$NOOVI_NO_PROMPT" == "1" ]]; then
    log_info "Skipping onboarding (non-interactive mode)"
    return 0
  fi

  if ! command_exists openclaw; then
    log_warn "openclaw command not found, skipping onboarding"
    return 0
  fi

  # Check if terminal is available
  if [[ ! -e /dev/tty ]]; then
    log_info "No terminal available for onboarding."
    log_info "Run manually: openclaw onboard"
    return 0
  fi

  # Prompt for language selection (output to tty, read from tty)
  echo "" >/dev/tty
  echo -e "${BOLD}${CYAN}Select language / Selecione o idioma:${NC}" >/dev/tty
  echo "" >/dev/tty
  echo "  1) English" >/dev/tty
  echo "  2) Português (Brasil)" >/dev/tty
  echo "" >/dev/tty

  local choice
  read -rp "Choose [1/2]: " choice </dev/tty

  local selected_lang="en"
  case "$choice" in
    2|pt|PT|português|portugues)
      selected_lang="pt"
      ;;
  esac

  if [[ "$selected_lang" == "pt" ]]; then
    log_info "Idioma selecionado: Português (Brasil)"
  else
    log_info "Selected language: English"
  fi

  log_info "Starting onboarding wizard..."
  # Restore terminal for interactive input
  OPENCLAW_LANGUAGE="$selected_lang" openclaw onboard </dev/tty || true
}

# -----------------------------------------------------------------------------
# Detect existing installation
# -----------------------------------------------------------------------------

detect_existing_checkout() {
  # Check if we're inside a OpenClaw source checkout
  local check_dir="${PWD}"

  while [[ "$check_dir" != "/" ]]; do
    if [[ -f "$check_dir/package.json" && -f "$check_dir/pnpm-workspace.yaml" ]]; then
      local pkg_name
      pkg_name=$(grep -o '"name":\s*"[^"]*"' "$check_dir/package.json" 2>/dev/null | head -1 | cut -d'"' -f4)
      if [[ "$pkg_name" == "openclaw" ]]; then
        echo "$check_dir"
        return 0
      fi
    fi
    check_dir=$(dirname "$check_dir")
  done

  return 1
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

  OpenClaw Installer
BANNER
  echo -e "${NC}"
  echo ""

  # Parse command line arguments
  parse_args "$@"

  log_verbose "Configuration:"
  log_verbose "  NOOVI_VERSION=$NOOVI_VERSION"
  log_verbose "  NOOVI_BETA=$NOOVI_BETA"
  log_verbose "  NOOVI_INSTALL_METHOD=$NOOVI_INSTALL_METHOD"
  log_verbose "  NOOVI_GIT_DIR=$NOOVI_GIT_DIR"
  log_verbose "  NOOVI_NO_ONBOARD=$NOOVI_NO_ONBOARD"

  # Detect OS
  if is_macos; then
    log_info "Detected: macOS $(sw_vers -productVersion 2>/dev/null || echo "")"
  elif is_wsl; then
    log_info "Detected: Windows Subsystem for Linux (WSL)"
  elif is_linux; then
    log_info "Detected: Linux ($(detect_linux_distro))"
  else
    die "Unsupported operating system: $(uname -s)"
  fi

  # Check for existing checkout
  local existing_checkout
  if existing_checkout=$(detect_existing_checkout); then
    log_info "Found existing OpenClaw checkout at: $existing_checkout"

    if is_interactive && [[ "$NOOVI_INSTALL_METHOD" != "git" && "$NOOVI_INSTALL_METHOD" != "npm" ]]; then
      echo ""
      echo "You're running the installer from inside an existing OpenClaw source checkout."
      echo ""
      echo "Options:"
      echo "  1) Update and use this checkout (git)"
      echo "  2) Install globally via npm (migrate to npm)"
      echo ""

      local choice
      read -rp "Choose [1/2]: " choice
      case "$choice" in
        1) NOOVI_INSTALL_METHOD="git"; NOOVI_GIT_DIR="$existing_checkout" ;;
        2) NOOVI_INSTALL_METHOD="npm" ;;
        *) die "Invalid choice. Run with --install-method git or --install-method npm" ;;
      esac
    elif [[ -z "$NOOVI_INSTALL_METHOD" || "$NOOVI_INSTALL_METHOD" == "" ]]; then
      die "Inside existing checkout but --install-method not specified. Use --install-method git or --install-method npm"
    fi
  fi

  # Ensure Node.js is installed
  if is_macos; then
    ensure_node_macos
  else
    ensure_node_linux
  fi

  # Setup npm prefix for Linux
  setup_npm_prefix

  # Install based on method
  case "$NOOVI_INSTALL_METHOD" in
    npm)
      install_via_npm
      ;;
    git)
      install_via_git
      ;;
    *)
      die "Unknown install method: $NOOVI_INSTALL_METHOD (use 'npm' or 'git')"
      ;;
  esac

  # Post-installation
  run_doctor

  echo ""
  echo -e "${GREEN}${BOLD}Installation complete!${NC}"
  echo ""
  echo "Next steps:"
  echo "  1. Open a new terminal (or run: source ~/.bashrc)"
  echo "  2. Run: openclaw --help"
  echo ""

  # Run onboarding
  run_onboarding
}

# Run main function with all script arguments
main "$@"
