#!/bin/sh
# Deploy site/ (paperbot.ca) to Cloudflare. Agents: read .agents/skills/deploy-site/SKILL.md first.
#
#   tools/site/deploy.sh preview    # separate *.workers.dev URL, never touches paperbot.ca
#   tools/site/deploy.sh prod       # paperbot.ca + www.paperbot.ca, then checks the live site
#   tools/site/deploy.sh rollback   # back to the previous production version
#   tools/site/deploy.sh status     # recent production deployments
#
# prod refuses uncommitted changes in site/ (pass --allow-dirty to override) so every deploy maps to a commit.
# Auth: wrangler's own login (`npx wrangler login`, already done on Joe's Mac) or CLOUDFLARE_API_TOKEN
# (+ CLOUDFLARE_ACCOUNT_ID) in the environment.
set -eu
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")/../.."
MODE=${1:-}
ALLOW_DIRTY=no; [ "${2:-}" = "--allow-dirty" ] && ALLOW_DIRTY=yes

# wrangler: the server's pinned copy if installed, otherwise the same version via npx (works in any worktree)
if [ -x server/node_modules/.bin/wrangler ]; then WRANGLER=../server/node_modules/.bin/wrangler
else WRANGLER="npx -y wrangler@$(node -p "require('./server/package.json').devDependencies.wrangler.replace(/^[^0-9]*/, '')")"; fi
w() { (cd site && $WRANGLER "$@" --config wrangler.jsonc); }

SHA=$(git rev-parse --short HEAD)
case "$MODE" in
  preview)
    python3 tools/site/check.py
    w deploy --env preview --message "preview @ $SHA" | tee /tmp/paperbot-site-preview.log
    URL=$(grep -Eo 'https://[a-z0-9.-]+\.workers\.dev' /tmp/paperbot-site-preview.log | head -1)
    [ -n "$URL" ] && python3 tools/site/check.py --live "$URL" && echo "preview: $URL"
    ;;
  prod)
    if [ "$ALLOW_DIRTY" = no ] && [ -n "$(git status --porcelain -- site)" ]; then
      echo "site/ has uncommitted changes. Commit first (or pass --allow-dirty)."; git status --short -- site; exit 1
    fi
    python3 tools/site/check.py
    w deploy --message "site @ $SHA"
    echo "waiting for paperbot.ca to serve the new version..."
    OK=no
    for i in 1 2 3 4 5 6; do if python3 tools/site/check.py --live https://paperbot.ca; then OK=yes; break; fi; sleep 10; done
    if [ "$OK" = yes ]; then echo "deployed site @ $SHA -> https://paperbot.ca"; exit 0; fi
    echo "DEPLOYED site @ $SHA, but the live check failed. If the error is a DNS lookup, this machine may have a"
    echo "stale cache (check: dig +short paperbot.ca @1.1.1.1). Otherwise investigate, or: make site-rollback"
    exit 1
    ;;
  rollback) w rollback ;;
  status) w deployments list | tail -40 ;;
  *) sed -n '2,10p' "$SELF"; exit 2 ;;
esac
