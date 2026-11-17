// Captures /setup's opening view (poster.webp) from the real viewer: the bottom view, "plug me in" on the screen, no
// cable, at 1.4:1 and full stage height (setup.css .still). Rerun when the camera, model or opening screen changes:
//   node tools/render3d/poster.mjs http://127.0.0.1:8787   (sh tools/local-worker.sh running)
import { chromium } from "../e2e/node_modules/playwright-core/index.mjs";
import { execFileSync } from "node:child_process";
const url = process.argv[2] || "http://127.0.0.1:8787";
const out = new URL("../../server/public/setup/assets/poster.webp", import.meta.url).pathname;
const b = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--use-angle=metal"] });
const p = await b.newPage({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 2 });
await p.route("**/setup/setup.js", (r) => r.fulfill({ contentType: "text/javascript",
  body: `import { screen } from "/setup/screen.js"; const sc = screen(document.querySelector("#mv")); sc.show("plug"); sc.ready.then(() => { window.__ready = true; });` }));
await p.addStyleTag({ content: "" }).catch(() => {});
await p.goto(`${url}/setup`);
await p.addStyleTag({ content: ".stage{width:700px!important;height:500px!important;-webkit-mask-image:none!important;mask-image:none!important}.still{display:none}.setup{display:block}" });
await p.waitForFunction(() => window.__ready, null, { timeout: 30000 });
await p.waitForTimeout(1500);
const png = out.replace(/\.webp$/, ".png");
await p.locator("#stage").screenshot({ path: png });
await b.close();
execFileSync("uv", ["run", "-q", "--with", "pillow", "python", "-c", `from PIL import Image; Image.open("${png}").convert("RGB").save("${out}", "WEBP", quality=82, method=6)`]);
execFileSync("rm", [png]);
console.log("poster", out);
