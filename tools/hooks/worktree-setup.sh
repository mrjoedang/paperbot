#!/bin/sh
# SessionStart / SubagentStart hook (.claude/settings.json): make a git worktree of paperbot ready to work
# in. Links the gitignored secrets from the main checkout (never copies or prints them), installs the
# server's npm deps, initializes the vendor submodule. Silent and quick when there's nothing to do.
here=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
main=$(git -C "$here" worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p' | head -n1)
[ -n "$main" ] || exit 0
done_=""
if [ "$here" != "$main" ]; then
  for p in .secrets.env .secrets server/.dev.vars server/.secrets firmware/paperbot/secrets.h; do
    if [ -e "$main/$p" ] && [ ! -e "$here/$p" ] && [ ! -L "$here/$p" ]; then
      ln -s "$main/$p" "$here/$p" && done_="$done_ linked $p;"
    fi
  done
fi
if [ -f "$here/server/package-lock.json" ] && [ ! -d "$here/server/node_modules" ]; then
  (cd "$here/server" && npm ci --silent >/dev/null 2>&1) && done_="$done_ installed server deps;"
fi
if [ -f "$here/.gitmodules" ] && [ -z "$(ls -A "$here/vendor/waveshare" 2>/dev/null)" ]; then
  git -C "$here" submodule update --init --quiet >/dev/null 2>&1 && done_="$done_ initialized vendor/waveshare;"
fi
[ -n "$done_" ] && echo "worktree setup:$done_"
exit 0
