import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { getHeapSnapshot } from 'node:v8';

const mode = process.argv[2] ?? 'msw'; // none | msw | interceptors
const scenario = process.argv[3] ?? 'fetch-reset'; // fetch-reset | http-abort | http-ok
assert.equal(typeof global.gc, 'function', 'Run node --expose-gc repro.mjs');
let interception;
if (mode === 'msw') {
  const { setupServer } = await import('msw/node');
  interception = setupServer();
  interception.listen({ onUnhandledRequest: 'bypass' });
} else if (mode === 'interceptors') {
  const { BatchInterceptor } = await import('@mswjs/interceptors');
  const { default: nodeInterceptors } = await import('@mswjs/interceptors/presets/node');
  interception = new BatchInterceptor({ name: 'repro', interceptors: nodeInterceptors });
  interception.apply();
} else assert.equal(mode, 'none');
let stopped = false;
function stopInterception() {
  if (stopped) return;
  stopped = true;
  if (mode === 'msw') interception.close();
  if (mode === 'interceptors') interception.dispose();
}
const backend = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => scenario === 'fetch-reset' ? req.socket.destroy() : res.end('ok'));
});
await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${backend.address().port}`;
async function batch() {
  for (let i = 0; i < 500; i++) {
    if (scenario === 'fetch-reset') {
      await assert.rejects(fetch(url), TypeError);
    } else if (scenario === 'http-abort') {
      await new Promise(resolve => {
        const req = http.request(url, { agent: false });
        req.on('error', () => {});
        req.on('close', resolve);
        req.on('socket', () => req.destroy()); // deliberately abort before end()
      });
    } else {
      assert.equal(scenario, 'http-ok');
      await new Promise((resolve, reject) => {
        http.get(url, { agent: false }, res => {
          res.resume();
          res.on('end', resolve);
          res.on('error', reject);
        }).on('error', reject);
      });
    }
  }
}
async function settle() {
  for (let i = 0; i < 4; i++) { await delay(100); global.gc(); }
}
async function counts() {
  const chunks = [];
  for await (const chunk of getHeapSnapshot()) chunks.push(chunk);
  const s = JSON.parse(Buffer.concat(chunks).toString());
  const f = s.snapshot.meta.node_fields;
  const names = ['HTTPParser', 'InterceptorHttpNetworkFrame', 'MockHttpSocket'];
  const result = Object.fromEntries(names.map(n => [n, 0]));
  const t = f.indexOf('type'), n = f.indexOf('name');
  for (let i = 0; i < s.nodes.length; i += f.length) {
    const name = s.strings[s.nodes[i+n]];
    if (name in result && s.snapshot.meta.node_types[t][s.nodes[i+t]] === 'object') result[name]++;
  }
  return result;
}
try {
  await batch();
  await settle();
  const before = await counts();
  await settle();
  const samples = [process.memoryUsage()];
  for (let i = 0; i < 3; i++) { await batch(); await settle(); samples.push(process.memoryUsage()); }
  await delay(2000);
  await settle();
  const after = await counts();
  const growth = samples.at(-1).heapUsed - samples[0].heapUsed;
  stopInterception();
  await settle();
  const afterClose = await counts();
  console.log(JSON.stringify({ afterClose, node: process.version, mode, scenario, measuredRequests: 1500, before, after, samples, growth }));
  assert.ok(growth < 8 * 1024 * 1024, 'More than 8 MiB retained after warmup');
  assert.ok(after.HTTPParser <= before.HTTPParser + 32, 'HTTPParser instances accumulate');
} finally {
  stopInterception();
  backend.closeAllConnections();
  await new Promise(resolve => backend.close(resolve));
}
