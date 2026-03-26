#!/usr/bin/env bash

set -uo pipefail

output_dir=".tmp/terminal-capture"
output_file=""

if [[ "${1:-}" == "--out" ]]; then
  if [[ -z "${2:-}" ]]; then
    echo "Missing value for --out" >&2
    exit 2
  fi
  output_file="$2"
  shift 2
fi

if [[ "${1:-}" == "--" ]]; then
  shift
fi

if [[ $# -eq 0 ]]; then
  echo "Usage: bash src/core/tooling/terminal/capture-command.sh [--out <file>] -- <command> [args...]" >&2
  exit 2
fi

mkdir -p "$output_dir"

if [[ -z "$output_file" ]]; then
  output_file="$output_dir/latest.log"
fi

{
  printf '__CAPTURE_COMMAND__:'
  printf ' %q' "$@"
  printf '\n'
} >"$output_file"

TERM=dumb CLICOLOR=0 "$@" >>"$output_file" 2>&1
exit_code=$?

echo "__CAPTURE_EXIT__:$exit_code" >>"$output_file"
echo "Capture file: $output_file"

exit "$exit_code"
