#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bin/worktree-dev.sh <worktree-name|worktree-path>

Examples:
  bin/worktree-dev.sh FEAT-0001
  bin/worktree-dev.sh .worktrees/FEAT-0001
  bin/worktree-dev.sh /private/var/www/vibedeck/.worktrees/FEAT-0001

What it does (inside the worktree):
  - symlink ./projects -> ../../projects
  - symlink ./public/status.json -> ../../public/status.json
  - run: npm run dev
EOF
}

arg="${1:-}"
if [[ -z "${arg}" || "${arg}" == "-h" || "${arg}" == "--help" ]]; then
  usage
  exit 1
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
hub_root="$(cd -- "${script_dir}/.." && pwd)"

worktree_dir=""
if [[ -d "${arg}" ]]; then
  worktree_dir="$(cd -- "${arg}" && pwd)"
elif [[ -d "${hub_root}/.worktrees/${arg}" ]]; then
  worktree_dir="${hub_root}/.worktrees/${arg}"
else
  echo "Error: worktree not found: ${arg}" >&2
  echo "Checked: ${arg} and ${hub_root}/.worktrees/${arg}" >&2
  exit 2
fi

cd -- "${worktree_dir}"

rm -rf projects
ln -sfn ../../../projects projects

mkdir -p public
ln -sfn ../../../../public/status.json public/status.json

# exec npm run dev

