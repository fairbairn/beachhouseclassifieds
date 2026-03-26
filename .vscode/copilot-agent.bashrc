#!/usr/bin/env bash

# Minimal, deterministic prompt for command detection.
unset PROMPT_COMMAND
export PS1='\u@\h:\w\$ '

# Enable VS Code shell integration when available for better command detection.
if [[ "$TERM_PROGRAM" == "vscode" ]] && command -v code >/dev/null 2>&1; then
  __vscode_shell_integration_path="$(code --locate-shell-integration-path bash 2>/dev/null || true)"
  if [[ -n "$__vscode_shell_integration_path" ]] && [[ -r "$__vscode_shell_integration_path" ]]; then
    . "$__vscode_shell_integration_path"
  fi
  unset __vscode_shell_integration_path
fi

# Scrub known sensitive vars inherited from parent shells.
unset ARENA_DB_URI
unset ARENA_POSTMARK_API
unset CLOUDFLARE_API_KEY
unset CLOUDFLARE_DNS_API_TOKEN
unset DOCKER_ARENA_ADMIN
unset DOCKER_ARENA_READ

# Import a small env subset from zsh login shell for stable local tooling resolution.
if command -v zsh >/dev/null 2>&1; then
  while IFS='=' read -r key value; do
    [[ -z "$key" || -z "$value" ]] && continue
    case "$key" in
      PATH|ASDF_DATA_DIR|LANG|LC_ALL|LC_CTYPE|PKG_CONFIG_PATH|GST_PLUGIN_PATH|VISUAL|EDITOR)
        export "$key=$value"
        ;;
    esac
  done < <(zsh -lic 'env | LC_ALL=C sort')
fi
