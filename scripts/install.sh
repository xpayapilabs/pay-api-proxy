#!/usr/bin/env bash
# Installs pay-api-proxy with Docker Compose.
# Supports Oracle Linux / RHEL-family hosts via dnf/yum Docker CE packages.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/pay-api-proxy}"
REPO_URL="${REPO_URL:-https://github.com/xpayapilabs/pay-api-proxy.git}"
GIT_BRANCH="${GIT_BRANCH:-${REPO_BRANCH:-}}"
DOMAIN_NAME="${DOMAIN_NAME:-${PUBLIC_HOST:-}}"
INSTALL_PROFILE="${INSTALL_PROFILE:-${COMPOSE_PROFILE:-auto}}"
APP_BIND="${APP_BIND:-127.0.0.1:8787}"
CLOUDFLARE_TUNNEL_MODE="${CLOUDFLARE_TUNNEL_MODE:-}"
ACME_EMAIL="${ACME_EMAIL:-}"
PAYMENT_RECIPIENT_ADDRESS="${PAYMENT_RECIPIENT_ADDRESS:-}"
PAYMENT_PROVIDER="${PAYMENT_PROVIDER:-}"
TEMPO_CHAIN_ID="${TEMPO_CHAIN_ID:-}"
TEMPO_RPC_URL="${TEMPO_RPC_URL:-}"
TEMPO_ACCEPTED_ASSET="${TEMPO_ACCEPTED_ASSET:-}"
DEFAULT_REQUEST_PRICE="${DEFAULT_REQUEST_PRICE:-}"
ROUTE_PRICES="${ROUTE_PRICES:-${TRADITIONAL_API_ROUTES:-}}"
ROUTE_ALLOWLIST="${ROUTE_ALLOWLIST:-${TRADITIONAL_API_ROUTES_ONLY:-}}"
OPENAPI_DOCUMENT_URL="${OPENAPI_DOCUMENT_URL:-${TRADITIONAL_OPENAPI_DOCUMENT_URL:-}}"
OPENAPI_SOURCE_PATH="${OPENAPI_SOURCE_PATH:-${TRADITIONAL_OPENAPI_SOURCE_PATH:-}}"
OPENAPI_DOCUMENT_PATH="${OPENAPI_DOCUMENT_PATH:-${TRADITIONAL_OPENAPI_DOCUMENT_PATH:-}}"
UPSTREAM_BASE_URL="${UPSTREAM_BASE_URL:-}"
UPSTREAM_AUTH_TYPE="${UPSTREAM_AUTH_TYPE:-}"
UPSTREAM_BEARER_TOKEN="${UPSTREAM_BEARER_TOKEN:-}"
UPSTREAM_AUTH_HEADER="${UPSTREAM_AUTH_HEADER:-}"
UPSTREAM_AUTH_HEADER_VALUE="${UPSTREAM_AUTH_HEADER_VALUE:-}"
XPAYAPI_DIRECTORY_URL="${XPAYAPI_DIRECTORY_URL:-https://api.xpayapi.com}"
XPAYAPI_PUBLIC_URL="${XPAYAPI_PUBLIC_URL:-https://xpayapi.com}"
XPAYAPI_REGISTER="${XPAYAPI_REGISTER:-auto}"  # auto | no — set "no" to skip auto-registration
PUBLIC_SCHEME="http"
PUBLIC_URL=""

quote_env_value() {
  local value="$1"
  value="${value//\'/\'\\\'\'}"
  printf "'%s'" "$value"
}

set_env() {
  local name="$1"
  local value="$2"

  if grep -q "^${name}=" .env; then
    local tmp_file
    tmp_file="$(mktemp)"
    grep -v "^${name}=" .env > "$tmp_file" || true
    cat "$tmp_file" > .env
    rm -f "$tmp_file"
  fi
  printf '%s=%s\n' "$name" "$(quote_env_value "$value")" >> .env
}

public_url_from_domain_name() {
  local domain_name="${1%%,*}"
  domain_name="${domain_name#"${domain_name%%[![:space:]]*}"}"
  domain_name="${domain_name%"${domain_name##*[![:space:]]}"}"

  if [ -z "$domain_name" ] || [[ "$domain_name" == :* ]]; then
    return 1
  fi

  if [[ "$domain_name" == *://* ]]; then
    printf '%s\n' "${domain_name%/}"
  elif [[ "$domain_name" == localhost || "$domain_name" == localhost:* || "$domain_name" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+(:[0-9]+)?$ ]]; then
    printf 'http://%s\n' "$domain_name"
  else
    printf 'https://%s\n' "$domain_name"
  fi
}

public_host_from_url() {
  local value="${1%/}"
  local rest host_port host

  if [[ "$value" == *://* ]]; then
    rest="${value#*://}"
    host_port="${rest%%/*}"
  else
    host_port="${value%%/*}"
  fi

  host_port="${host_port%%\?*}"
  host_port="${host_port%%#*}"

  host="${host_port%%:*}"
  host="${host,,}"
  printf '%s\n' "$host"
}

normalize_domain_name() {
  local value="${1%%,*}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"

  if [ -z "$value" ]; then
    return 1
  fi

  if [[ "$value" == *://* ]]; then
    public_host_from_url "$value"
    return 0
  fi

  value="${value%%/*}"
  value="${value%%\?*}"
  value="${value%%#*}"
  value="${value%.}"
  printf '%s\n' "$value"
}

normalize_public_base_url() {
  local value="${1%/}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"

  if [ -z "$value" ]; then
    return 1
  fi

  if [[ "$value" == http://* || "$value" == https://* ]]; then
    printf '%s\n' "$value"
    return 0
  fi

  public_url_from_domain_name "$value"
}

normalize_public_endpoint_env() {
  if [ -n "${DOMAIN_NAME:-}" ]; then
    DOMAIN_NAME="$(normalize_domain_name "$DOMAIN_NAME" 2>/dev/null || printf '%s\n' "$DOMAIN_NAME")"
  fi
  if [ -n "${CADDY_SITE_ADDRESS:-}" ]; then
    CADDY_SITE_ADDRESS="$(normalize_domain_name "$CADDY_SITE_ADDRESS" 2>/dev/null || printf '%s\n' "$CADDY_SITE_ADDRESS")"
  fi
  if [ -n "${PUBLIC_BASE_URL:-}" ]; then
    PUBLIC_BASE_URL="$(normalize_public_base_url "$PUBLIC_BASE_URL" 2>/dev/null || printf '%s\n' "${PUBLIC_BASE_URL%/}")"
  fi
}

resolve_initial_domain_name() {
  if [ -n "${CADDY_SITE_ADDRESS:-}" ]; then
    printf '%s\n' "$CADDY_SITE_ADDRESS"
    return 0
  fi
  if [ -n "${PUBLIC_BASE_URL:-}" ]; then
    public_host_from_url "$PUBLIC_BASE_URL"
    return 0
  fi
  printf '%s\n' "$DOMAIN_NAME"
}

persist_public_endpoint_env() {
  local host=""
  local normalized_public_base_url=""

  normalize_public_endpoint_env

  if [ -n "${PUBLIC_BASE_URL:-}" ]; then
    normalized_public_base_url="${PUBLIC_BASE_URL%/}"
    set_env "PUBLIC_BASE_URL" "$normalized_public_base_url"
  fi
  if [ -n "${CADDY_SITE_ADDRESS:-}" ]; then
    set_env "CADDY_SITE_ADDRESS" "$CADDY_SITE_ADDRESS"
    host="$CADDY_SITE_ADDRESS"
  elif [ -n "$normalized_public_base_url" ] && is_registerable_public_domain_url "$normalized_public_base_url"; then
    host="$(public_host_from_url "$normalized_public_base_url")"
  elif [ -n "${DOMAIN_NAME:-}" ]; then
    host="$DOMAIN_NAME"
  fi

  if [ -n "$host" ]; then
    set_env "DOMAIN_NAME" "$host"
    PUBLIC_SCHEME="https"
    if [ -z "$normalized_public_base_url" ]; then
      normalized_public_base_url="$(public_url_from_domain_name "$host" 2>/dev/null || true)"
      if [ -n "$normalized_public_base_url" ]; then
        set_env "PUBLIC_BASE_URL" "$normalized_public_base_url"
      fi
    fi
  fi
}

is_registerable_public_domain_url() {
  local value="$1"
  local rest host_port path host
  if [[ "$value" != http://* && "$value" != https://* ]]; then
    return 1
  fi
  rest="${value#*://}"
  host_port="${rest%%/*}"
  path="${rest#"$host_port"}"
  host="${host_port%%:*}"
  host="${host,,}"

  if [ -z "$host" ]; then
    return 1
  fi
  if [ -n "$path" ] && [ "$path" != "/" ]; then
    return 1
  fi
  if [[ "$host" == localhost || "$host" == *.local ]]; then
    return 1
  fi
  if [[ "$host" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    return 1
  fi
  if [[ "$host" != *.* ]]; then
    return 1
  fi
  return 0
}

is_valid_email() {
  local value="$1"
  [[ "$value" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]
}

render_caddyfile_email_option() {
  if [ ! -f deploy/Caddyfile ]; then
    return 0
  fi

  local caddy_email="${ACME_EMAIL:-}"
  if [ -z "$caddy_email" ] && [ -f .env ]; then
    caddy_email="$(awk -F= '$1 == "ACME_EMAIL" { print $2 }' .env | tail -1)"
  fi

  local body tmp email_line
  body="$(mktemp)"
  tmp="$(mktemp)"

  email_line=""
  if [ -n "$caddy_email" ]; then
    if is_valid_email "$caddy_email"; then
      email_line="$(printf '\temail %s' "$caddy_email")"
    else
      echo "Skipping Caddy ACME email: ACME_EMAIL is not a valid email address." >&2
    fi
  fi

  if [ -n "$email_line" ]; then
    awk -v email_line="$email_line" '
      NR == 1 && $0 ~ /^[[:space:]]*\{[[:space:]]*$/ {
        print "{"
        print email_line
        in_global = 1
        next
      }
      in_global {
        if ($0 ~ /^[[:space:]]*\}[[:space:]]*$/) {
          print "}"
          in_global = 0
          next
        }
        if ($0 ~ /^[[:space:]]*email([[:space:]]|$)/) next
        print
        next
      }
      NR == 1 {
        print "{"
        print email_line
        print "}"
        print ""
      }
      { print }
    ' deploy/Caddyfile > "$body"
  else
    awk '
      NR == 1 && $0 ~ /^[[:space:]]*\{[[:space:]]*$/ {
        in_global = 1
        next
      }
      in_global {
        if ($0 ~ /^[[:space:]]*\}[[:space:]]*$/) {
          if (has_other) {
            print "{"
            for (i = 1; i <= n; i += 1) print global_lines[i]
            print "}"
            print ""
          }
          in_global = 0
          next
        }
        if ($0 ~ /^[[:space:]]*email([[:space:]]|$)/) next
        if ($0 !~ /^[[:space:]]*$/) has_other = 1
        global_lines[++n] = $0
        next
      }
      { print }
    ' deploy/Caddyfile > "$body"
  fi

  cat "$body" > "$tmp"
  cat "$tmp" > deploy/Caddyfile
  rm -f "$body" "$tmp"
}

copy_openapi_document_from_source() {
  local source_path="$1"
  local source_file=""
  if [ -z "$source_path" ]; then
    return 1
  fi

  if [ -d "$source_path" ]; then
    if [ -f "$source_path/openapi.json" ]; then
      source_file="$source_path/openapi.json"
    elif [ -f "$source_path/swagger.json" ]; then
      source_file="$source_path/swagger.json"
    else
      echo "OpenAPI source folder must contain openapi.json or swagger.json: $source_path" >&2
      exit 1
    fi
  elif [ -f "$source_path" ]; then
    source_file="$source_path"
  else
    echo "OpenAPI source path does not exist on this server: $source_path" >&2
    exit 1
  fi

  mkdir -p data
  cp "$source_file" data/imported-openapi.json
  chmod 644 data/imported-openapi.json
  set_env "OPENAPI_DOCUMENT_PATH" "/app/data/imported-openapi.json"
  unset_env "OPENAPI_DOCUMENT_URL"
  unset_env "TRADITIONAL_OPENAPI_DOCUMENT_URL"
  echo "Copied OpenAPI document from $source_file to $APP_DIR/data/imported-openapi.json"
}

fetch_openapi_document_from_url() {
  local url="$1"
  if [ -z "$url" ]; then
    return 1
  fi

  mkdir -p data
  if ! curl -fsSL "$url" -o data/imported-openapi.json; then
    return 1
  fi
  if ! node -e "const fs=require('fs'); const v=JSON.parse(fs.readFileSync('data/imported-openapi.json','utf8')); if(!v||typeof v!=='object'||Array.isArray(v)) process.exit(1)"; then
    echo "OpenAPI document URL did not return a JSON object: $url" >&2
    rm -f data/imported-openapi.json
    return 1
  fi

  chmod 644 data/imported-openapi.json
  set_env "OPENAPI_DOCUMENT_PATH" "/app/data/imported-openapi.json"
  unset_env "OPENAPI_DOCUMENT_URL"
  unset_env "TRADITIONAL_OPENAPI_DOCUMENT_URL"
  echo "Imported OpenAPI document from $url to $APP_DIR/data/imported-openapi.json"
  return 0
}

unset_env() {
  local name="$1"
  if [ ! -f .env ] || ! grep -q "^${name}=" .env; then
    return 0
  fi
  local tmp_file
  tmp_file="$(mktemp)"
  grep -v "^${name}=" .env > "$tmp_file" || true
  cat "$tmp_file" > .env
  rm -f "$tmp_file"
}

OS_ID=""
OS_ID_LIKE=""
OS_VERSION_ID=""

load_os_release() {
  OS_ID=""
  OS_ID_LIKE=""
  OS_VERSION_ID=""
  if [ -f /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    OS_ID="${ID:-}"
    OS_ID_LIKE="${ID_LIKE:-}"
    OS_VERSION_ID="${VERSION_ID:-}"
  fi
}

is_oracle_linux() {
  case "${OS_ID,,}" in
    ol|oraclelinux) return 0 ;;
  esac
  return 1
}

is_rhel_family() {
  if is_oracle_linux; then
    return 0
  fi
  case "${OS_ID,,}" in
    rhel|centos|rocky|almalinux|fedora|ol) return 0 ;;
  esac
  [[ " ${OS_ID_LIKE} " == *" rhel "* ]] || [[ " ${OS_ID_LIKE} " == *" fedora "* ]]
}

run_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    echo "Root privileges are required to run: $*" >&2
    exit 1
  fi
}

pkg_manager() {
  if command -v dnf >/dev/null 2>&1; then
    printf '%s\n' dnf
  elif command -v yum >/dev/null 2>&1; then
    printf '%s\n' yum
  else
    return 1
  fi
}

ensure_prerequisites() {
  local missing=0
  command -v curl >/dev/null 2>&1 || missing=1
  command -v git >/dev/null 2>&1 || missing=1
  if [ "$missing" -eq 0 ]; then
    return 0
  fi

  if is_rhel_family && pkg_manager >/dev/null; then
    local pm
    pm="$(pkg_manager)"
    if [ "$pm" = dnf ]; then
      run_root dnf -y install curl git ca-certificates
    else
      run_root yum -y install curl git ca-certificates
    fi
    return 0
  fi

  echo "Missing required commands (curl, git). Install them and retry." >&2
  exit 1
}

docker_compose_available() {
  docker compose version >/dev/null 2>&1
}

docker_uses_podman_shim() {
  if ! command -v docker >/dev/null 2>&1; then
    return 1
  fi
  if docker info 2>/dev/null | grep -qi podman; then
    return 0
  fi
  if command -v rpm >/dev/null 2>&1 && rpm -q podman-docker >/dev/null 2>&1; then
    if ! systemctl is-active --quiet docker 2>/dev/null; then
      return 0
    fi
  fi
  return 1
}

start_docker_service() {
  if command -v systemctl >/dev/null 2>&1; then
    run_root systemctl enable --now docker >/dev/null 2>&1 || run_root systemctl start docker >/dev/null 2>&1 || true
  elif command -v service >/dev/null 2>&1; then
    run_root service docker start >/dev/null 2>&1 || true
  fi
}

install_docker_rhel_family() {
  local pm
  pm="$(pkg_manager)" || {
    echo "No supported package manager (dnf/yum) found for ${OS_ID:-linux}." >&2
    return 1
  }

  echo "Installing Docker Engine via ${pm} (${OS_ID:-linux})..."

  if [ "$pm" = dnf ]; then
    run_root dnf -y install dnf-plugins-core
  else
    run_root yum -y install yum-utils
  fi

  if [ ! -f /etc/yum.repos.d/docker-ce.repo ]; then
    run_root "$pm" config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
  fi

  run_root "$pm" -y remove podman-docker 2>/dev/null || true
  run_root "$pm" -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

  start_docker_service
}

install_docker_compose_plugin_rhel() {
  local pm
  pm="$(pkg_manager)" || return 1
  run_root "$pm" -y install docker-compose-plugin
}

ensure_docker() {
  load_os_release

  if command -v docker >/dev/null 2>&1 && ! docker_uses_podman_shim && docker_compose_available; then
    start_docker_service
    return 0
  fi

  if is_rhel_family; then
    install_docker_rhel_family
    if ! docker_compose_available; then
      install_docker_compose_plugin_rhel || true
    fi
    start_docker_service
    return 0
  fi

  if ! command -v docker >/dev/null 2>&1; then
    curl -fsSL https://get.docker.com | sh
  fi

  start_docker_service

  if ! docker_compose_available && is_rhel_family; then
    install_docker_compose_plugin_rhel || true
  fi
}

load_os_release
ensure_prerequisites
ensure_docker

if ! docker_compose_available; then
  echo "Docker Compose plugin is required but was not found after Docker installation." >&2
  if is_oracle_linux; then
    echo "On Oracle Linux, install it with: sudo dnf install docker-compose-plugin" >&2
  fi
  exit 1
fi

mkdir -p "$APP_DIR"

if [ ! -d "$APP_DIR/.git" ]; then
  if [ -n "$GIT_BRANCH" ]; then
    git clone --branch "$GIT_BRANCH" "$REPO_URL" "$APP_DIR"
  else
    git clone "$REPO_URL" "$APP_DIR"
  fi
fi

cd "$APP_DIR"

if [ -d .git ]; then
  git fetch origin --prune
  if [ -n "$GIT_BRANCH" ]; then
    git checkout "$GIT_BRANCH"
    git pull --ff-only origin "$GIT_BRANCH" 2>/dev/null || git pull origin "$GIT_BRANCH"
  fi
fi

if [ -z "$DOMAIN_NAME" ]; then
  DOMAIN_NAME="$(hostname -I 2>/dev/null | awk '{print $1}')"
  if [ -z "$DOMAIN_NAME" ]; then
    DOMAIN_NAME="localhost"
  fi
fi

if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  set_env "NODE_ENV" "production"
  normalize_public_endpoint_env
  INITIAL_DOMAIN_NAME="$(resolve_initial_domain_name)"
  if normalized="$(normalize_domain_name "$INITIAL_DOMAIN_NAME" 2>/dev/null)"; then
    set_env "DOMAIN_NAME" "$normalized"
  else
    set_env "DOMAIN_NAME" "$INITIAL_DOMAIN_NAME"
  fi
fi

set_env "APP_BIND" "$APP_BIND"
if [ -n "$CLOUDFLARE_TUNNEL_MODE" ]; then
  set_env "CLOUDFLARE_TUNNEL_MODE" "$CLOUDFLARE_TUNNEL_MODE"
fi
if [ -n "$ACME_EMAIL" ]; then
  if is_valid_email "$ACME_EMAIL"; then
    set_env "ACME_EMAIL" "$ACME_EMAIL"
  else
    echo "Skipping ACME_EMAIL in .env: value is not a valid email address." >&2
  fi
fi
if [ -n "$PAYMENT_RECIPIENT_ADDRESS" ]; then
  set_env "PAYMENT_RECIPIENT_ADDRESS" "$PAYMENT_RECIPIENT_ADDRESS"
fi
if [ -n "$PAYMENT_PROVIDER" ]; then
  set_env "PAYMENT_PROVIDER" "$PAYMENT_PROVIDER"
fi
if [ -n "$TEMPO_CHAIN_ID" ]; then
  set_env "TEMPO_CHAIN_ID" "$TEMPO_CHAIN_ID"
fi
if [ -n "$TEMPO_RPC_URL" ]; then
  set_env "TEMPO_RPC_URL" "$TEMPO_RPC_URL"
fi
if [ -n "$TEMPO_ACCEPTED_ASSET" ]; then
  set_env "TEMPO_ACCEPTED_ASSET" "$TEMPO_ACCEPTED_ASSET"
fi
if [ -n "$DEFAULT_REQUEST_PRICE" ]; then
  set_env "DEFAULT_REQUEST_PRICE" "$DEFAULT_REQUEST_PRICE"
fi
if [ -n "$ROUTE_PRICES" ]; then
  set_env "ROUTE_PRICES" "$ROUTE_PRICES"
  unset_env "TRADITIONAL_API_ROUTES"
fi
if [ -n "$ROUTE_ALLOWLIST" ]; then
  set_env "ROUTE_ALLOWLIST" "$ROUTE_ALLOWLIST"
  unset_env "TRADITIONAL_API_ROUTES_ONLY"
fi
if [ -n "$OPENAPI_SOURCE_PATH" ]; then
  copy_openapi_document_from_source "$OPENAPI_SOURCE_PATH"
elif [ -n "$OPENAPI_DOCUMENT_URL" ]; then
  if ! fetch_openapi_document_from_url "$OPENAPI_DOCUMENT_URL"; then
    echo "Warning: could not import OpenAPI from URL at install time; proxy will fetch it at runtime." >&2
    set_env "OPENAPI_DOCUMENT_URL" "$OPENAPI_DOCUMENT_URL"
    unset_env "TRADITIONAL_OPENAPI_DOCUMENT_URL"
  fi
elif [ -n "$OPENAPI_DOCUMENT_PATH" ] &&
  [[ "$OPENAPI_DOCUMENT_PATH" != /app/* ]] &&
  [ -e "$OPENAPI_DOCUMENT_PATH" ]; then
  copy_openapi_document_from_source "$OPENAPI_DOCUMENT_PATH"
elif [ -n "$OPENAPI_DOCUMENT_PATH" ]; then
  set_env "OPENAPI_DOCUMENT_PATH" "$OPENAPI_DOCUMENT_PATH"
  unset_env "TRADITIONAL_OPENAPI_DOCUMENT_PATH"
fi
if [ -n "$UPSTREAM_BASE_URL" ]; then
  set_env "UPSTREAM_BASE_URL" "$UPSTREAM_BASE_URL"
fi
if [ -n "$UPSTREAM_AUTH_TYPE" ]; then
  set_env "UPSTREAM_AUTH_TYPE" "$UPSTREAM_AUTH_TYPE"
fi
if [ -n "$UPSTREAM_BEARER_TOKEN" ]; then
  set_env "UPSTREAM_BEARER_TOKEN" "$UPSTREAM_BEARER_TOKEN"
fi
if [ -n "$UPSTREAM_AUTH_HEADER" ]; then
  set_env "UPSTREAM_AUTH_HEADER" "$UPSTREAM_AUTH_HEADER"
fi
if [ -n "$UPSTREAM_AUTH_HEADER_VALUE" ]; then
  set_env "UPSTREAM_AUTH_HEADER_VALUE" "$UPSTREAM_AUTH_HEADER_VALUE"
fi

persist_public_endpoint_env

if [ -f .env ]; then
  PUBLIC_BASE_URL="$(awk -F= '$1 == "PUBLIC_BASE_URL" { print $2 }' .env)"
  PUBLIC_URL="${PUBLIC_BASE_URL%/}"
  if [ -z "$PUBLIC_URL" ]; then
    CONFIG_DOMAIN_NAME="$(awk -F= '$1 == "DOMAIN_NAME" { print $2 }' .env)"
    if [ -z "$CONFIG_DOMAIN_NAME" ]; then
      CONFIG_DOMAIN_NAME="$(awk -F= '$1 == "PUBLIC_HOST" { print $2 }' .env)"
    fi
    if [ -z "$CONFIG_DOMAIN_NAME" ]; then
      CONFIG_DOMAIN_NAME="$(awk -F= '$1 == "CADDY_SITE_ADDRESS" { print $2 }' .env)"
    fi
    PUBLIC_URL="$(public_url_from_domain_name "$CONFIG_DOMAIN_NAME" || true)"
  fi
  if [[ "$PUBLIC_BASE_URL" == https://* ]]; then
    PUBLIC_SCHEME="https"
  fi
fi

COMPOSE_PROFILE=""
case "$INSTALL_PROFILE" in
  local)
    COMPOSE_PROFILE=""
    ;;
  caddy|vps|public)
    COMPOSE_PROFILE="vps"
    ;;
  tunnel|cloudflare)
    TUNNEL_MODE="$(awk -F= '$1 == "CLOUDFLARE_TUNNEL_MODE" { print $2 }' .env 2>/dev/null)"
    TUNNEL_TOKEN="$(awk -F= '$1 == "CLOUDFLARE_TUNNEL_TOKEN" { print $2 }' .env 2>/dev/null)"
    if [ "$TUNNEL_MODE" = "named" ] || { [ "$TUNNEL_MODE" != "quick" ] && [ -n "$TUNNEL_TOKEN" ]; }; then
      COMPOSE_PROFILE="tunnel"
    else
      COMPOSE_PROFILE="quick-tunnel"
    fi
    ;;
  auto)
    TUNNEL_TOKEN="$(awk -F= '$1 == "CLOUDFLARE_TUNNEL_TOKEN" { print $2 }' .env 2>/dev/null)"
    if [ -n "$TUNNEL_TOKEN" ]; then
      COMPOSE_PROFILE="tunnel"
    else
      COMPOSE_PROFILE="vps"
    fi
    ;;
  *)
    echo "Unknown INSTALL_PROFILE: $INSTALL_PROFILE. Use local, caddy, tunnel, or auto." >&2
    exit 1
    ;;
esac

render_caddyfile_email_option

if [ -n "$COMPOSE_PROFILE" ]; then
  docker compose --profile "$COMPOSE_PROFILE" up -d --build
else
  docker compose up -d --build
fi

echo "Paid API Node is running."
echo "Install profile: $INSTALL_PROFILE"
echo "Compose profile: ${COMPOSE_PROFILE:-default}"
echo "Open: ${PUBLIC_URL:-${PUBLIC_SCHEME}://$DOMAIN_NAME}/health"
if [ "$COMPOSE_PROFILE" = "quick-tunnel" ]; then
  echo "Quick tunnel URL is printed by cloudflared:"
  echo "  docker compose logs cloudflared-quick"
fi

# Auto-register with the xpayapi directory so the listing appears without
# any further admin step. Best-effort: failures print a manual retry command
# but never fail the install.
register_with_xpayapi() {
  if [ "$XPAYAPI_REGISTER" = "no" ]; then
    return 0
  fi

  local effective="${PUBLIC_URL:-}"
  if [ -z "$effective" ] && [ -n "${DOMAIN_NAME:-}" ]; then
    effective="$(public_url_from_domain_name "$DOMAIN_NAME" 2>/dev/null || true)"
  fi

  if [ "$COMPOSE_PROFILE" = "quick-tunnel" ]; then
    echo
    echo "Skipping auto-registration: quick-tunnel URL is dynamic."
    echo "After 'docker compose logs cloudflared-quick' shows your URL, register with:"
    echo "  curl -X POST ${XPAYAPI_DIRECTORY_URL}/api/register \\"
    echo "    -H 'Content-Type: application/json' \\"
    echo "    -d '{\"publicBaseUrl\":\"<your-tunnel-url>\"}'"
    return 0
  fi

  if [ -z "$effective" ]; then
    echo
    echo "Skipping auto-registration: no PUBLIC_URL resolved. Register manually with:"
    echo "  curl -X POST ${XPAYAPI_DIRECTORY_URL}/api/register \\"
    echo "    -H 'Content-Type: application/json' \\"
    echo "    -d '{\"publicBaseUrl\":\"<your-public-url>\"}'"
    return 0
  fi

  if ! is_registerable_public_domain_url "$effective"; then
    echo
    echo "Skipping auto-registration: PUBLIC_BASE_URL must be a real domain-name base URL, not localhost or an IP address."
    echo "Register later with:"
    echo "  curl -X POST ${XPAYAPI_DIRECTORY_URL}/api/register \\"
    echo "    -H 'Content-Type: application/json' \\"
    echo "    -d '{\"publicBaseUrl\":\"https://api.example.com\"}'"
    return 0
  fi

  echo
  echo "Waiting for the proxy to accept requests on ${effective}/health ..."
  local attempt
  for attempt in $(seq 1 30); do
    if curl -fsS --max-time 3 "${effective}/health" >/dev/null 2>&1; then
      break
    fi
    sleep 2
  done

  echo "Registering with xpayapi directory at ${XPAYAPI_DIRECTORY_URL} ..."
  local body response http_status
  body="$(printf '{"publicBaseUrl":"%s"}' "$effective")"
  response="$(curl -sS --max-time 15 -w '\n%{http_code}' \
      -X POST "${XPAYAPI_DIRECTORY_URL}/api/register" \
      -H 'Content-Type: application/json' \
      -d "$body" 2>&1 || printf '\n000')"
  http_status="${response##*$'\n'}"
  response="${response%$'\n'*}"

  case "$http_status" in
    200|201)
      echo "Registered."
      local first_api_id
      first_api_id="$(printf '%s' "$response" | sed -n 's/.*"apiIds":\[[^"]*"\([^"]*\)".*/\1/p' | head -1)"
      if [ -n "$first_api_id" ]; then
        echo "Listing: ${XPAYAPI_PUBLIC_URL}/api.html?id=${first_api_id}"
      else
        echo "Listing: ${XPAYAPI_PUBLIC_URL}/"
      fi
      ;;
    *)
      echo "Auto-registration failed (HTTP ${http_status}). Retry with:"
      echo "  curl -X POST ${XPAYAPI_DIRECTORY_URL}/api/register \\"
      echo "    -H 'Content-Type: application/json' \\"
      echo "    -d '${body}'"
      if [ -n "$response" ]; then
        echo "Directory response: ${response}"
      fi
      ;;
  esac
}

register_with_xpayapi
