# paperbot — common tasks. `make help` lists them.
PORT ?= $(firstword $(wildcard /dev/cu.usbmodem*))

.PHONY: help sim sim-build sim-test sim-mock sim-clean firmware flash logs deploy deploy-dev e2e e2e-setup setup-screens fresh board-reset board-backup board-restore shots release site site-shots site-check site-preview site-deploy site-rollback site-status
help:           ## list targets
	@grep -E '^[a-z0-9-]+:.*## ' $(MAKEFILE_LIST) | sed 's/:.*## /\t/' | expand -t16

sim:            ## interactive simulator + browser UI (http://localhost:8090)
	$(MAKE) -C sim run
sim-build:      ## build the simulator only
	$(MAKE) -C sim build -j8
sim-test:       ## headless scenarios -> build/sim-test/report.html
	$(MAKE) -C sim build -j8
	$(MAKE) -C sim test
sim-mock:       ## mock device API only (port 8788)
	$(MAKE) -C sim mock
sim-clean:
	$(MAKE) -C sim clean

firmware:       ## compile the board firmware (no flashing)
	sh firmware/build.sh
flash:          ## compile + flash over USB (PORT=/dev/cu.usbmodemXXXX, auto-detected)
	@test -n "$(PORT)" || { echo "board not found on USB (see docs/hardware.md: recovery)"; exit 1; }
	sh firmware/build.sh $(PORT)
logs:           ## print the board's serial log (no reset)
	uv run -q tools/bootlog.py 600

deploy:         ## deploy the server + web app to production (paperbot)
	cd server && npx wrangler deploy --env production
deploy-dev:     ## deploy the server to the dev Worker (paperbot-dev, https://dev.paperbot.ca)
	cd server && npx tsc -p . && npx wrangler deploy
shots:          ## screenshots of every web screen (light/dark, desktop/phone) -> build/shots/index.html; needs sh tools/local-worker.sh
	cd tools/e2e && npm install --silent && node shots.mjs $(SCREENS)
e2e:            ## a new person's whole journey on dev.paperbot.ca (sign-up, /setup on the simulator, research, delete)
	$(MAKE) sim-build && cd tools/e2e && npm install --silent && node accounts.mjs
e2e-setup:      ## /setup end to end on the plugged-in board via dev (WIZ_SSID=... WIZ_PSK=... your Wi-Fi; hold ☀ when asked)
	@test -n "$$WIZ_PSK" || { echo 'WIZ_SSID="your Wi-Fi" WIZ_PSK="its password" make e2e-setup'; exit 1; }
	cd tools/e2e && npm install --silent && node web-setup.mjs --server https://dev.paperbot.ca
setup-screens:  ## every /setup screen and error state, no board (a scripted one) -> build/e2e/screens/sheet.png (SERVER=...)
	cd tools/e2e && npm install --silent && node setup-screens.mjs --server $(or $(SERVER),https://dev.paperbot.ca)
fresh:          ## start over like a new owner: factory-reset the board, then open /setup (SERVER=dev|prod)
	sh tools/fresh.sh all $(or $(SERVER),dev)
board-reset:    ## factory-reset the board (backs it up first): Waveshare's demo, like out of the box
	sh tools/fresh.sh board
board-backup:   ## back up the whole board (16 MB: firmware, settings, Wi-Fi) to ~/src/projects/paperbot-hw-backup/
	sh tools/fresh.sh backup
board-restore:  ## write a board backup back: make board-restore FILE=~/src/projects/paperbot-hw-backup/board-....bin
	sh tools/fresh.sh restore $(FILE)
release:        ## build + sign an OTA release: make release VERSION=1.0.1
	sh tools/ota/release.sh $(VERSION)
site:           ## preview the paperbot.ca site locally (http://localhost:8411, never cached)
	python3 tools/site/serve.py site
site-shots:     ## the web app screenshots on paperbot.ca (site/assets/img/app-list-*.webp); needs sh tools/local-worker.sh and a local OpenBelt (ARGS="--openbelt <url>", tools/e2e/site-shots.mjs)
	cd tools/e2e && npm install --silent && node site-shots.mjs $(ARGS)
site-check:     ## check site/ before deploying (missing files, link-preview tags, sizes)
	python3 tools/site/check.py
site-preview:   ## deploy site/ to a separate *.workers.dev preview URL (never touches paperbot.ca)
	sh tools/site/deploy.sh preview
site-deploy:    ## deploy site/ to paperbot.ca (committed changes only), then check the live site
	sh tools/site/deploy.sh prod
site-rollback:  ## put paperbot.ca back to the previous version
	sh tools/site/deploy.sh rollback
site-status:    ## recent paperbot.ca deployments
	sh tools/site/deploy.sh status
