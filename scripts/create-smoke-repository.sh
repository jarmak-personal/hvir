#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 2 ]]; then
  echo 'Usage: create-smoke-repository.sh <source-checkout> <repository>' >&2
  exit 2
fi

source_checkout=$1
repository=$2

case "$source_checkout" in
/*) ;;
*)
  echo "Smoke source checkout must be absolute: $source_checkout" >&2
  exit 2
  ;;
esac

case "$repository" in
/*) ;;
*)
  echo "Smoke repository must be absolute: $repository" >&2
  exit 2
  ;;
esac

# Git exports repository-local variables while running hooks. They must not
# redirect this constructor's explicit source and destination repositories.
while IFS= read -r variable; do
  if [[ -n "$variable" ]]; then unset "$variable"; fi
done < <(git -C "$source_checkout" rev-parse --local-env-vars)

source_commit=$(git -C "$source_checkout" rev-parse --verify HEAD^{commit})

if [[ -e "$repository" ]]; then
  if [[ ! -d "$repository" ]]; then
    echo "Smoke repository path is not a directory: $repository" >&2
    exit 2
  fi
  if [[ -n "$(find "$repository" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    echo "Smoke repository must start empty: $repository" >&2
    exit 2
  fi
else
  mkdir -p "$repository"
fi

# The source checkout is an immutable construction input. `git archive` excludes
# its worktree changes, ignored output, Git metadata, and neighboring worktrees.
git -C "$source_checkout" archive "$source_commit" | tar -x -C "$repository"

git -C "$repository" init --quiet --initial-branch=main
git -C "$repository" config user.name 'hvir smoke'
git -C "$repository" config user.email 'hvir-smoke@invalid.example'
git -C "$repository" config commit.gpgsign false
# The fixture is short-lived and deleted as soon as its scenario/test finishes.
# Keep Git from launching detached maintenance that can still be writing under
# .git while the owner removes that temporary directory.
git -C "$repository" config maintenance.auto false
git -C "$repository" config gc.auto 0

export GIT_AUTHOR_DATE='2000-01-01T00:00:00Z'
export GIT_COMMITTER_DATE='2000-01-01T00:00:00Z'
git -C "$repository" add --all
git -C "$repository" commit --quiet -m 'Create smoke source fixture'

git -C "$repository" switch --quiet -c smoke/workflow
export GIT_AUTHOR_DATE='2000-01-01T00:01:00Z'
export GIT_COMMITTER_DATE='2000-01-01T00:01:00Z'
printf 'deterministic branch-point and history fixture\n' \
  >"$repository/.hvir-smoke-history.txt"
git -C "$repository" add .hvir-smoke-history.txt
git -C "$repository" commit --quiet -m 'Add smoke workflow history'

# Keep an ignored entry available for the real Git classification path without
# making the initial worktree dirty. Workflow-owned mutations provide diff and
# working-tree evidence after Electron starts.
printf 'ignored smoke fixture\n' >"$repository/.hvir-smoke-ignored.log"
