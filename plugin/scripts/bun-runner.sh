#!/bin/bash
# Bun runner - finds and executes bun from common installation paths
# Used by hooks to avoid PATH issues in minimal shell environments

# Common bun installation paths (in order of preference)
BUN_PATHS=(
  "$HOME/.bun/bin/bun"
  "/usr/local/bin/bun"
  "/opt/homebrew/bin/bun"
  "${USERPROFILE}/.bun/bin/bun.exe"
)

# Try each path
for p in "${BUN_PATHS[@]}"; do
  if [ -x "$p" ]; then
    exec "$p" "$@"
  fi
done

# Fallback: try bun in PATH (might work if shell is configured)
if command -v bun &> /dev/null; then
  exec bun "$@"
fi

# If we get here, bun wasn't found
echo "Error: bun not found. Please install bun: curl -fsSL https://bun.sh/install | bash" >&2
exit 1
