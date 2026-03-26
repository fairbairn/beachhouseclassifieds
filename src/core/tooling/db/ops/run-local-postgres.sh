#!/usr/bin/env bash

set -euo pipefail

MODE="${1:-neon}"

CONTAINER_NAME="${DB_CONTAINER_NAME:-local-db-container}"
HOST_PORT="${DB_HOST_PORT:-5432}"

resolve_default_postgres_volume_name() {
  sanitize_app_name "${CONTAINER_NAME}_pgdata"
}

resolved_postgres_volume_name() {
  local default_volume_name
  default_volume_name="$(resolve_default_postgres_volume_name)"
  echo "${DB_POSTGRES_VOLUME_NAME:-$default_volume_name}"
}

sanitize_app_name() {
  local value="$1"
  local sanitized

  sanitized="$(echo "$value" | tr '[:upper:]' '[:lower:]' | sed -E 's/^@//; s#[^a-z0-9]+#_#g; s/^_+//; s/_+$//; s/_+/_/g')"

  if [[ -n "$sanitized" ]]; then
    echo "$sanitized"
    return
  fi

  echo "app"
}

resolve_app_base_name() {
  local explicit="${APP_DB_BASENAME:-}"
  local package_name="${npm_package_name:-}"
  local app_name="${APP_NAME:-}"

  if [[ -n "$explicit" ]]; then
    sanitize_app_name "$explicit"
    return
  fi

  if [[ -n "$package_name" ]]; then
    sanitize_app_name "$package_name"
    return
  fi

  if [[ -n "$app_name" ]]; then
    sanitize_app_name "$app_name"
    return
  fi

  echo "app"
}

resolve_profile_suffix() {
  local profile="${APP_ENV_PROFILE:-local}"
  local normalized_profile
  normalized_profile="$(echo "$profile" | tr '[:upper:]' '[:lower:]')"

  case "$normalized_profile" in
    dev|development)
      echo "dev"
      ;;
    prod|production)
      echo "prod"
      ;;
    local|*)
      echo "local"
      ;;
  esac
}

resolve_default_database_name() {
  local app_base_name
  app_base_name="$(resolve_app_base_name)"

  local profile_suffix
  profile_suffix="$(resolve_profile_suffix)"

  echo "${app_base_name}_${profile_suffix}"
}

DEFAULT_DATABASE_NAME="$(resolve_default_database_name)"
DEFAULT_DATABASE_URL="postgresql://postgres:postgres@localhost:${HOST_PORT}/${DEFAULT_DATABASE_NAME}"

resolved_database_url() {
  echo "${DATABASE_URL:-$DEFAULT_DATABASE_URL}"
}

database_name_from_url() {
  local database_url="$1"
  local without_scheme="${database_url#*://}"
  local without_authority="${without_scheme#*@}"

  if [[ "$without_authority" == "$without_scheme" ]]; then
    without_authority="$without_scheme"
  fi

  local path_part="${without_authority#*/}"

  if [[ "$path_part" == "$without_authority" ]]; then
    echo "postgres"
    return
  fi

  path_part="${path_part%%\?*}"
  path_part="${path_part%%\#*}"
  path_part="${path_part%%/*}"

  if [[ -n "$path_part" ]]; then
    echo "$path_part"
    return
  fi

  echo "postgres"
}

database_user_from_url() {
  local database_url="$1"
  local without_scheme="${database_url#*://}"

  if [[ "$without_scheme" != *"@"* ]]; then
    echo "postgres"
    return
  fi

  local userinfo="${without_scheme%%@*}"
  local username="${userinfo%%:*}"

  if [[ -n "$username" ]]; then
    echo "$username"
    return
  fi

  echo "postgres"
}

database_password_from_url() {
  local database_url="$1"
  local without_scheme="${database_url#*://}"

  if [[ "$without_scheme" != *"@"* ]]; then
    echo "postgres"
    return
  fi

  local userinfo="${without_scheme%%@*}"

  if [[ "$userinfo" != *":"* ]]; then
    echo "postgres"
    return
  fi

  local password="${userinfo#*:}"

  if [[ -n "$password" ]]; then
    echo "$password"
    return
  fi

  echo "postgres"
}

require_env() {
  local variable_name="$1"
  if [[ -z "${!variable_name:-}" ]]; then
    echo "Missing required env var: ${variable_name}" >&2
    exit 2
  fi
}

container_exists() {
  docker ps -a --format '{{.Names}}' | grep -Fxq "$CONTAINER_NAME"
}

print_neon_connection_hint() {
  local local_database_url
  local_database_url="$(resolved_database_url)"
  local database_name="${DATABASE_NAME:-$(database_name_from_url "$local_database_url")}" 
  echo
  echo "Neon Local started on localhost:${HOST_PORT}"
  echo "Connection string:"
  echo "postgres://neon:npg@localhost:${HOST_PORT}/${database_name}?sslmode=require"
  echo
  echo "Note for Node Postgres clients in local dev:"
  echo "  ssl: { rejectUnauthorized: false }"
}

print_postgres_connection_hint() {
  local local_database_url
  local_database_url="$(resolved_database_url)"
  local database_name="${POSTGRES_DB:-$(database_name_from_url "$local_database_url")}" 
  local username="${POSTGRES_USER:-$(database_user_from_url "$local_database_url")}" 
  local password="${POSTGRES_PASSWORD:-$(database_password_from_url "$local_database_url")}" 
  local volume_name
  volume_name="$(resolved_postgres_volume_name)"

  echo
  echo "Local Postgres started on localhost:${HOST_PORT}"
  echo "Connection string:"
  echo "postgresql://${username}:${password}@localhost:${HOST_PORT}/${database_name}"
  echo "Data volume:"
  echo "${volume_name}"
}

start_neon_local() {
  require_env NEON_API_KEY
  require_env NEON_PROJECT_ID

  local image="${NEON_LOCAL_IMAGE:-neondatabase/neon_local:latest}"
  local local_database_url
  local_database_url="$(resolved_database_url)"
  local database_name="${DATABASE_NAME:-$(database_name_from_url "$local_database_url")}" 

  if container_exists; then
    echo "Removing existing container: ${CONTAINER_NAME}"
    docker rm -f "$CONTAINER_NAME" >/dev/null
  fi

  local -a environment_args
  environment_args+=("-e" "NEON_API_KEY=${NEON_API_KEY}")
  environment_args+=("-e" "NEON_PROJECT_ID=${NEON_PROJECT_ID}")

  if [[ -n "${BRANCH_ID:-}" && -n "${PARENT_BRANCH_ID:-}" ]]; then
    echo "Set only one of BRANCH_ID or PARENT_BRANCH_ID, not both." >&2
    exit 2
  fi

  if [[ -n "${BRANCH_ID:-}" ]]; then
    environment_args+=("-e" "BRANCH_ID=${BRANCH_ID}")
  fi

  if [[ -n "${PARENT_BRANCH_ID:-}" ]]; then
    environment_args+=("-e" "PARENT_BRANCH_ID=${PARENT_BRANCH_ID}")
  fi

  if [[ -n "${DELETE_BRANCH:-}" ]]; then
    environment_args+=("-e" "DELETE_BRANCH=${DELETE_BRANCH}")
  fi

  echo "Starting Neon Local container: ${CONTAINER_NAME}"
  docker run -d \
    --name "$CONTAINER_NAME" \
    -p "${HOST_PORT}:5432" \
    "${environment_args[@]}" \
    "$image" >/dev/null

  print_neon_connection_hint

  echo
  echo "Quick test:"
  echo "psql \"postgres://neon:npg@localhost:${HOST_PORT}/${database_name}?sslmode=require\" -c 'select now();'"
}

start_local_postgres() {
  local local_database_url
  local_database_url="$(resolved_database_url)"
  local image="${POSTGRES_IMAGE:-postgres:16}"
  local username="${POSTGRES_USER:-$(database_user_from_url "$local_database_url")}" 
  local password="${POSTGRES_PASSWORD:-$(database_password_from_url "$local_database_url")}" 
  local database_name="${POSTGRES_DB:-$(database_name_from_url "$local_database_url")}" 
  local volume_name
  volume_name="$(resolved_postgres_volume_name)"

  if container_exists; then
    echo "Removing existing container: ${CONTAINER_NAME}"
    docker rm -f "$CONTAINER_NAME" >/dev/null
  fi

  echo "Starting local Postgres container: ${CONTAINER_NAME}"
  docker run -d \
    --name "$CONTAINER_NAME" \
    -p "${HOST_PORT}:5432" \
    -v "${volume_name}:/var/lib/postgresql/data" \
    -e "POSTGRES_USER=${username}" \
    -e "POSTGRES_PASSWORD=${password}" \
    -e "POSTGRES_DB=${database_name}" \
    "$image" >/dev/null

  print_postgres_connection_hint

  echo
  echo "Quick test:"
  echo "psql \"postgresql://${username}:${password}@localhost:${HOST_PORT}/${database_name}\" -c 'select now();'"
}

stop_container() {
  if container_exists; then
    echo "Stopping and removing: ${CONTAINER_NAME}"
    docker rm -f "$CONTAINER_NAME" >/dev/null
    echo "Done."
    return
  fi

  echo "No container found named ${CONTAINER_NAME}."
}

print_usage() {
  cat <<'USAGE'
Usage:
  bash src/core/tooling/db/run-local-postgres.sh neon
  bash src/core/tooling/db/run-local-postgres.sh postgres
  bash src/core/tooling/db/run-local-postgres.sh stop

Modes:
  neon      Start Neon Local (requires NEON_API_KEY and NEON_PROJECT_ID)
  postgres  Start plain local Postgres (no Neon credentials)
  stop      Stop/remove current DB container

Optional env vars:
  DB_CONTAINER_NAME   (default: local-db-container)
  DB_HOST_PORT        (default: 5432)
  DB_POSTGRES_VOLUME_NAME (default: <container_name>_pgdata)
  APP_DB_BASENAME     (optional, default: npm package name or APP_NAME)
  APP_ENV_PROFILE     (optional, default: local; supports local/dev/prod)

Default DATABASE_URL when unset:
  postgresql://postgres:postgres@localhost:<port>/<app>_<profile>
  Example: app_local, app_dev, app_prod

Neon mode env vars:
  NEON_API_KEY        (required)
  NEON_PROJECT_ID     (required)
  BRANCH_ID           (optional, connect existing branch)
  PARENT_BRANCH_ID    (optional, create ephemeral branch)
  DELETE_BRANCH       (optional, Neon Local branch delete behavior)
  DATABASE_NAME       (optional, default: parsed from DATABASE_URL)

Postgres mode env vars:
  POSTGRES_USER       (default: parsed from DATABASE_URL)
  POSTGRES_PASSWORD   (default: parsed from DATABASE_URL)
  POSTGRES_DB         (default: parsed from DATABASE_URL)
  POSTGRES_IMAGE      (default: postgres:16)
USAGE
}

case "$MODE" in
  neon)
    start_neon_local
    ;;
  postgres)
    start_local_postgres
    ;;
  stop)
    stop_container
    ;;
  -h|--help|help)
    print_usage
    ;;
  *)
    echo "Unknown mode: ${MODE}" >&2
    print_usage
    exit 2
    ;;
esac
