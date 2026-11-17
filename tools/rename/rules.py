"""Rules for tools/rename/rename.py. Ordered: the first rule whose pattern covers an occurrence takes it.

Each rule: id, action ("keep" or "rename"), why (one line, shown in the summary), pattern (a regex that must cover the
occurrence on its line), paths (fnmatch globs, default every file), examples (lines, or [path, line], that must
classify to this rule: `rename.py --check`).

Keep rules name what can't or shouldn't change: old addresses boards still use, a Google Cloud project id, commands of
a removed tool. Round 2 (2026-11-16) moved the Cloudflare resources (Workers, D1, R2, Workflows, AI Gateways), the
GitHub repo and the local folders to paperbot, so their names are renames now.
"""

# Standalone word only: not part of a longer name (pocketbot-dev, firmware/pocketbot, pocketbot_core, .pocketbot), so
# any compound we haven't looked at stays UNCLASSIFIED instead of being renamed blind. A trailing "." is fine (a sentence
# end); domains and file names with dots are taken by keep rules above.
WORD = r"(?i)(?<![\w./-])pocket[-_]?bot(?![\w/-])(?!\.(?:ca|glb|webp|bin|ino|git|mrjoedang)\b)"

RULES = [
    # ---------------------------------------------------------------- keep: can't or shouldn't change
    {"id": "gcp-project", "action": "keep",
     "why": "the Google Cloud project id (holds the Google sign-in client): ids can't be renamed",
     "pattern": r"pocketbot-514715",
     "examples": ["`pocketbot-514715` (redirect https://app.paperbot.ca/api/auth/callback/google)"]},
    {"id": "old-workers-dev", "action": "keep",
     "why": "the old pocketbot.mrjoedang.workers.dev address: boards flashed with it still call it (legacy-shim/pocketbot.ts)",
     "pattern": r"(?i)pocketbot\\?\.mrjoedang\\?\.workers\\?\.dev|\(pocketbot\|paperbot\)\\?\.mrjoedang",
     "paths": ["tools/e2e/*", "docs/device-api.md", "server/README.md", "server/legacy-shim/*", "README.md"],
     "examples": [["docs/device-api.md", "The old https://pocket-voice.mrjoedang.workers.dev and https://pocketbot.mrjoedang.workers.dev proxy"],
                  ["tools/e2e/shots.mjs", r"|^https:\/\/(pocketbot|paperbot)\.mrjoedang\.workers\.dev$/.test(B)"]]},
    {"id": "legacy-shim", "action": "keep",
     "why": "the shim Worker that keeps the old address: its name is the old Worker name",
     "pattern": r"(?i)pocketbot", "paths": ["server/legacy-shim/pocketbot.*"],
     "examples": [["server/legacy-shim/pocketbot.jsonc", '  "name": "pocketbot",']]},
    {"id": "legacy-shim-file", "action": "keep",
     "why": "names the shim's files",
     "pattern": r"legacy-shim/pocketbot\.(?:jsonc|ts)\b",
     "examples": [["README.md", "legacy-shim/pocketbot.jsonc"]]},
    {"id": "removed-cli", "action": "keep",
     "why": "the Rust CLI's commands and folder (removed 2026-11-15): renaming would name a command that never existed",
     "pattern": r"pocketbot (?:setup|status|wifi|claude)\b(?:/[a-z/]+)?(?: --sim)?|~/\.pocketbot\b",
     "examples": ["// networks come from `pocketbot setup` (the Mac's saved ones)", "The Rust CLI (`pocketbot setup/status/wifi/claude`)", "a stale `~/.pocketbot`"]},
    {"id": "prod-guards", "action": "keep",
     "why": "scripts' guards against running on production: old and new names both serve it",
     "pattern": r"\(pocketbot\|paperbot\)",
     "examples": [["tools/e2e/shots.mjs", r"if (/^https:\/\/((www|app)\.)?(pocketbot|paperbot)\.ca$/.test(B))"]]},
    {"id": "old-domains", "action": "keep",
     "why": "pocketbot.ca addresses still serve boards and redirect; they're named as what they are",
     "pattern": r"(?i)(?:[a-z]+\.)?pocketbot\.ca\b",
     "examples": ["Old addresses (pocketbot.ca, workers.dev) keep serving boards", "https://app.pocketbot.ca/v1"]},

    # ---------------------------------------------------------------- rename: Cloudflare, GitHub, this Mac (moved in round 2)
    {"id": "cf-resources", "action": "rename",
     "why": "Cloudflare names (Workers, D1, R2, Workflows, AI Gateways): moved to paperbot-* on 2026-11-16",
     "pattern": r"pocketbot-(?:dev-auth|dev-pipeline|dev|auth|pipeline|site-preview|site|local)\b",
     "examples": ['"name": "pocketbot-dev",', "Worker `pocketbot-site` on paperbot.ca", '"database_name": "pocketbot-auth"', 'c["name"] = "pocketbot-local"']},
    {"id": "cf-prod-names", "action": "rename",
     "why": "the production Worker, R2 bucket and AI Gateway, all named `paperbot` now",
     "pattern": r'`pocketbot`|"name": "pocketbot"|"bucket_name": "pocketbot"|"GATEWAY_ID": "pocketbot"|pocketbot\\?\.mrjoedang\\?\.workers\\?\.dev|proxied to pocketbot\b',
     "examples": ["Production is the `pocketbot` Worker, https://app.paperbot.ca.", ["server/wrangler.jsonc", '      "name": "pocketbot",'],
                  '        "GATEWAY_ID": "pocketbot",', ["AGENTS.md", "Never verify on production (`pocketbot` Worker, pocketbot.mrjoedang.workers.dev"]]},
    {"id": "secrets-env", "action": "rename",
     "why": "env var names (.secrets.env renamed with it)",
     "pattern": r"POCKETBOT_(?:WIFI_KEY|BACKUPS)",
     "examples": ["`POCKETBOT_WIFI_KEY`"]},
    {"id": "browser-storage", "action": "rename",
     "why": "localStorage keys: renaming resets them once (the install tip shows again; the update loop guard restarts)",
     "pattern": r"pocketbot-(?:install-dismissed|refresh-state)",
     "examples": ["const STORAGE = 'pocketbot-refresh-state';"]},
    {"id": "repo-and-paths", "action": "rename",
     "why": "the GitHub repo and folders on this Mac (renamed with it)",
     "pattern": r"(?:github\.com/)?mrjoedang/pocketbot(?:\.git)?\b|pocketbot\.git\b|&& cd pocketbot\b|(?:~|\$HOME|/Users/\w+)?/src/projects/(?:worktrees/)?pocketbot[\w-]*|pocketbot-hw-backup",
     "examples": ["https://github.com/mrjoedang/pocketbot", "~/src/projects/pocketbot-hw-backup/", "git clone git@github.com:mrjoedang/pocketbot.git && cd pocketbot"]},
    {"id": "firmware-build", "action": "rename",
     "why": "the Arduino sketch folder, the core library and build file names (OTA keys in R2 don't use the name)",
     "pattern": r"firmware/pocketbot\b|^\s+pocketbot/(?=\s)|pocketbot\.ino(?:\.[a-z.]+)?\b|build/pocketbot[\w-]*|pocketbot_(?:gen|core)\b|pocketbot-(?:generic|<v>|<ver>|<version>|\$VER|\{offer|\d+\.\d+\.\d)[\w.{}\['\]<>$-]*\.?(?:bin)?|pocketbot\.bin\b",
     "examples": [["README.md", "  pocketbot/     board sketch: ESP32 hardware layer"], "firmware/pocketbot/fw_version.txt", "name=pocketbot_core", "manifest.json + pocketbot-<v>.bin", 'cp "$BIN" "$OUT/pocketbot-$VER.bin"']},
    {"id": "asset-files", "action": "rename",
     "why": "asset file names (the 3D model, a photo): the files move too",
     "pattern": r"pocketbot(?:\.glb|-front\.webp)\b",
     "examples": ['src="assets/pocketbot.glb"', "assets/img/pocketbot-front.webp"]},

    # ---------------------------------------------------------------- rename: names inside the repo
    {"id": "skill-name", "action": "rename",
     "why": "the verify-pocketbot skill (its folder moves too)",
     "pattern": r"verify-pocketbot",
     "examples": ["`prove-it-works` with `verify-pocketbot`"]},
    {"id": "code-identifiers", "action": "rename",
     "why": "names in code that only this repo uses (JS globals, npm package, a download's file name)",
     "pattern": r"window\.(?:pocketbotBoot|__pocketbotPreview)|\b(?:pocketbotBoot|__pocketbotPreview)\b|pocketbot-e2e|pocketbot-export\.json|\bS\.pocketbot\b",
     "examples": ["window.pocketbotBoot?.ready();", '"name": "pocketbot-e2e",', 'filename="pocketbot-export.json"']},

    # ---------------------------------------------------------------- rename: the product's name, by area
    {"id": "web-app", "action": "rename", "why": "the web app at app.paperbot.ca: copy people read",
     "pattern": WORD, "paths": ["server/public/*"],
     "examples": [["server/public/install.js", "h('strong',null,'pocketbot on your Home Screen')"]]},
    {"id": "server", "action": "rename", "why": "server code: names sent to people and services (passkeys, MCP, OpenBelt), comments",
     "pattern": WORD, "paths": ["server/src/*", "server/test/*", "server/*.md", "server/scripts/*", "server/legacy-shim/*", "server/wrangler.jsonc", "server/package.json"],
     "examples": [["server/src/mcp.ts", 'serverInfo: { name: "pocketbot", version: "1.0.0" },']]},
    {"id": "site", "action": "rename", "why": "paperbot.ca: copy, titles and link-preview tags",
     "pattern": WORD, "paths": ["site/*"],
     "examples": [["site/index.html", '<a class="wordmark" href="#top">pocketbot</a>']]},
    {"id": "firmware-sim", "action": "rename", "why": "firmware and simulator: comments and docs (no strings on the screen)",
     "pattern": WORD, "paths": ["firmware/*", "sim/*"],
     "examples": [["firmware/build.sh", "# Build (and optionally flash) the pocketbot firmware."]]},
    {"id": "docs", "action": "rename", "why": "docs, READMEs, AGENTS.md, skills, design notes",
     "pattern": WORD, "paths": ["*.md", "docs/*", ".agents/*", "design/*", "AGENTS.md", "CLAUDE.md"],
     "examples": [["AGENTS.md", "# pocketbot"]]},
    {"id": "tools", "action": "rename", "why": "repo tools and the Makefile: comments, messages",
     "pattern": WORD, "paths": ["tools/*", "Makefile", ".gitignore"],
     "examples": [["Makefile", "sim: ## the pocketbot simulator"]]},
]

# Paths that move with --apply (git mv), old -> new. Only tracked paths that exist are moved.
PATH_RENAMES = [
    ("firmware/pocketbot/pocketbot.ino", "firmware/pocketbot/paperbot.ino"),  # Arduino: the .ino matches its folder
    ("firmware/pocketbot", "firmware/paperbot"),
    ("site/assets/pocketbot.glb", "site/assets/paperbot.glb"),
    ("site/assets/img/pocketbot-front.webp", "site/assets/img/paperbot-front.webp"),
    ("server/public/setup/assets/pocketbot.glb", "server/public/setup/assets/paperbot.glb"),
]
