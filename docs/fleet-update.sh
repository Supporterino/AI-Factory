#!/usr/bin/env bash
# Example: update ai-factory in many workspaces, one local commit each.
#
#   docs/fleet-update.sh 0.2.0 ~/src/team-a-ai ~/src/team-b-ai
#
# It never pushes. Review each workspace's update commit, then push or open merge
# requests with your usual tooling. A workspace with a change in progress, a dirty
# tree or a merge conflict is skipped and listed at the end.
set -uo pipefail

version="${1:?usage: fleet-update.sh <version> <workspace>...}"
shift

ok=()
skipped=()
for ws in "$@"; do
  echo "== $ws"
  if ! bunx "ai-factory@${version}" -C "$ws" update --dry-run; then
    skipped+=("$ws (plan failed)")
    continue
  fi
  bunx "ai-factory@${version}" -C "$ws" update
  case $? in
    0) ok+=("$ws") ;;
    4) skipped+=("$ws (in progress, dirty or conflicts: see above; \`ai-factory rollback\` undoes a conflicted update)") ;;
    *) skipped+=("$ws (failed)") ;;
  esac
done

echo
echo "updated: ${#ok[@]}"
for ws in "${ok[@]}"; do echo "  $ws  $(git -C "$ws" log -1 --format='%h %s')"; done
echo "skipped: ${#skipped[@]}"
for ws in "${skipped[@]}"; do echo "  $ws"; done
[ "${#skipped[@]}" -eq 0 ]
