#!/usr/bin/env bash

# Release guard for the dsh-stream-rules monorepo: validates the package
# (build, clean tree, pack), then --publish pushes it to npm after a
# confirmation prompt.

set -euo pipefail

mode="${1:---check}"
registry="https://registry.npmjs.org/"

if [[ "$mode" != "--check" && "$mode" != "--publish" ]]; then
  echo "usage: $0 [--check|--publish]" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "release refused: git worktree is not clean" >&2
  exit 1
fi

packages=(
  "packages/stream-rules"
)

for dir in "${packages[@]}"; do
  if [[ ! -f "$dir/package.json" || ! -f "$dir/LICENSE" ]]; then
    echo "release refused: $dir/package.json and LICENSE are required" >&2
    exit 1
  fi
  package_name="$(node -p "require('./$dir/package.json').name")"
  if [[ "$package_name" != @hy-sde-org/* ]]; then
    echo "release refused: unexpected package name $package_name (expected @hy-sde-org/*)" >&2
    exit 1
  fi
done

echo "Validating from commit $(git rev-parse HEAD)"

pnpm install
pnpm -r build
pnpm -r check
pnpm -r test

for dir in "${packages[@]}"; do
  package_ref="$(node -p "require('./$dir/package.json').name + '@' + require('./$dir/package.json').version")"
  (cd "$dir" && pnpm pack --pack-destination "$repo_root")
  echo "packed $package_ref"
done

if [[ "$mode" != "--publish" ]]; then
  echo "check passed: builds, tests, and packs all green; nothing published"
  exit 0
fi

if [[ "$(git branch --show-current)" != "main" ]]; then
  echo "release refused: publish only from main" >&2
  exit 1
fi

for dir in "${packages[@]}"; do
  package_ref="$(node -p "require('./$dir/package.json').name + '@' + require('./$dir/package.json').version")"
  read -r -p "Publish $package_ref to $registry? [y/N] " answer
  if [[ "$answer" != "y" && "$answer" != "Y" ]]; then
    echo "aborted"
    exit 1
  fi
done

for dir in "${packages[@]}"; do
  (cd "$dir" && npm publish --registry "$registry" --access public)
done

echo "published"
