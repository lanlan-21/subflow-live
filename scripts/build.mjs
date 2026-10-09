import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
await mkdir('static/licenses', { recursive: true });
await build({ entryPoints: ['frontend/collaboration.js'], bundle: true, minify: true, outfile: 'static/collaboration.js' });
await copyFile('node_modules/quill/dist/quill.snow.css', 'static/quill.snow.css');
const qr = await readFile('node_modules/qrcodejs/qrcode.js', 'utf8');
await writeFile('static/qrcode.js', qr.split(/\r?\n/).map(line => line.replace(/^[\t ]+/, indent => indent.replace(/\t/g, '    ')).trimEnd()).join('\n'));
for (const name of ['yjs', 'y-quill', 'y-indexeddb', 'y-protocols', 'lib0', 'quill', 'quill-cursors', 'socket.io-client', 'qrcodejs']) {
  try { await copyFile(`node_modules/${name}/LICENSE`, `static/licenses/${name}.txt`); }
  catch { try { await copyFile(`node_modules/${name}/LICENSE.md`, `static/licenses/${name}.txt`); } catch {} }
}
