import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)),
  server: { middlewareMode: true }, appType: 'custom' });
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  if (input !== '/iea15mw-aero-v1.json') throw new Error(`Unexpected check asset: ${input}`);
  return new Response(await readFile(new URL('../public/iea15mw-aero-v1.json', import.meta.url)));
};
try {
  for (const name of ['runTorqueControllerChecks', 'runSteadyStateChecks']) {
    const suite = await server.ssrLoadModule(`/src/dev/${name}.ts`);
    await suite[name]();
  }
} finally {
  globalThis.fetch = originalFetch;
  await server.close();
}
