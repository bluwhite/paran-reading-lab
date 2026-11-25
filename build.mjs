import { mkdir, readFile, writeFile } from 'node:fs/promises';
await mkdir('dist/server', {recursive:true});
const html = await readFile('worker/page.html','utf8');
const worker = await readFile('worker/index.mjs','utf8');
await writeFile('dist/server/index.js', 'const page = ' + JSON.stringify(html) + ';\n' + worker);
