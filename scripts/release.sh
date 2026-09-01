#!/usr/bin/env bash
set -euo pipefail

usage() {
    printf 'Usage: %s <version>\n' "$0"
}

while getopts ":h" opt; do
    case "$opt" in
        h) usage; exit 0 ;;
        *) usage; exit 1 ;;
    esac
done
shift $((OPTIND - 1))

input="${1:-}"
for command in gh git; do
    if ! command -v "$command" >/dev/null 2>&1; then
        echo "Error: $command is required"
        exit 1
    fi
done

branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" != "main" ]; then
    echo "Error: must be on main branch (currently on $branch)"
    exit 1
fi

git fetch origin main --tags --quiet
local_commit="$(git rev-parse HEAD)"
remote_commit="$(git rev-parse origin/main)"
if [ "$local_commit" != "$remote_commit" ]; then
    echo "Error: local main is not up to date with origin/main"
    exit 1
fi

previous="$(git tag -l 'v*' | sort -V | tail -n1)"
if [ -z "$input" ]; then
    echo "Current release: ${previous:-(none)}"
    read -rp "Enter new version: " input
fi

input="${input#v}"
if [[ ! "$input" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Error: version must be valid semver"
    exit 1
fi

version="v${input}"
root="$(git rev-parse --show-toplevel)"
if git tag -l "$version" | grep -q "^${version}$"; then
    echo "Error: tag $version already exists"
    exit 1
fi

echo "Release: $version"
echo "Commit: $(git rev-parse --short HEAD)"
echo "Images:"
echo "  ghcr.io/gaucho-racing/workbench-server:$input"
echo "  ghcr.io/gaucho-racing/workbench-web:$input"
read -rp "Proceed? (y/N) " confirm
if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
    echo "Aborted."
    exit 0
fi

sed -i '' "s/const Version = \".*\"/const Version = \"${input}\"/" "$root/workbench/config/config.go"
git add workbench/config/config.go
git commit --allow-empty -m "release: workbench ${version}"
git push origin main
gh release create "$version" --target main --title "$version" --generate-notes

echo "Released $version. Image and deployment workflows are running."

