import { mkdir, readFile, writeFile } from 'node:fs/promises';

const source = await readFile('worker/page.html','utf8');
const api = new URL(process.env.READING_LAB_API_ORIGIN || 'https://paran-reading-lab.epichawk20.chatgpt.site');
if (api.protocol !== 'https:' || api.href !== api.origin + '/') {
  throw new Error('READING_LAB_API_ORIGIN must be an HTTPS origin.');
}
const pages = source.replace('<html lang="ko">', '<html lang="ko" data-static-pages data-api-origin="' + api.origin + '">');
if (pages === source) throw new Error('Missing HTML root element.');
await mkdir('dist-pages/student',{recursive:true});
await Promise.all([
  writeFile('dist-pages/index.html',pages),
  writeFile('dist-pages/student/index.html',pages),
  writeFile('dist-pages/.nojekyll','')
]);
