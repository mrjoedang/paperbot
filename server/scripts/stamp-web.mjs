import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../public/', import.meta.url));
const hash = createHash('sha256');
async function walk(dir = '') {
  for (const entry of (await readdir(root + dir, { withFileTypes: true })).sort((a,b)=>a.name.localeCompare(b.name))) {
    const path = dir + entry.name;
    if (entry.isDirectory()) { await walk(path + '/'); continue; }
    if (path === 'version.json') continue;
    let data = await readFile(root + path);
    if (path === 'index.html') data = Buffer.from(data.toString().replace(/<meta name="app-version" content="[^"]*">\n?/g, ''));
    hash.update(path + '\0'); hash.update(data);
  }
}
await walk();
const version = hash.digest('hex').slice(0,16);
let html = (await readFile(root + 'index.html','utf8')).replace(/<meta name="app-version" content="[^"]*">\n?/g, '');
html = html.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n<meta name="app-version" content="${version}">`);
await writeFile(root + 'index.html', html);
await writeFile(root + 'version.json', JSON.stringify({ version }) + '\n');
console.log(`Web version ${version}`);
