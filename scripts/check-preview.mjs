// HTTP smoke check of a running production preview. It checks deployed assets
// and MIME types; it does not execute React or substitute for a browser test.
import assert from 'node:assert/strict';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:4173/');
async function get(path, mime) {
  const url = new URL(path, base);
  assert.equal(url.origin, base.origin, 'Expected same-origin application assets');
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200, url.href);
  assert.match(response.headers.get('content-type') ?? '', mime, url.href);
  const body = await response.text();
  assert(body.length > 0, 'Empty asset: ' + url.href);
  console.log('PASS: HTTP 200 and MIME type for ' + url.pathname);
  return body;
}

const html = await get(base, /text\/html/);
assert(html.includes('<div id="root">'), 'Application mount is present');
const script = html.match(/<script[^>]*src="([^"]+)"/)?.[1];
const style = html.match(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/)?.[1];
assert(script && style, 'Expected built JavaScript and CSS');
const bundle = await get(script, /(?:javascript|ecmascript)/);
await get(style, /text\/css/);
const worker = bundle.match(/\/assets\/simulationWorker-[\w-]+\.js/)?.[0];
assert(worker, 'Expected bundled worker URL in the production app');
await get(worker, /(?:javascript|ecmascript)/);
await get('favicon.svg', /image\/svg\+xml/);
const table = JSON.parse(await get('iea15mw-aero-v1.json', /application\/json/));
const axes = [table.rotorSpeedRadPerSec, table.pitchRad, table.windSpeedMps];
for (const axis of axes) assert(Array.isArray(axis) && axis.length > 1 && axis.every(Number.isFinite));
const cells = axes.reduce((size, axis) => size * axis.length, 1);
for (const field of [table.cp, table.ct, table.cq]) {
  assert(Array.isArray(field) && field.length === cells && field.every(Number.isFinite), 'Complete finite aerodynamic table');
}
console.log('PASS: production aerodynamic table, ' + cells + ' cells per coefficient');
console.log('NOTE: asset smoke check only; Start/Stop/Reset, layout and Chrome memory need browser review.');
