import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv, normalizeBase, redact, mediaType, createHttp } from './runtime.mjs';
import http from 'node:http';
import { extractQwenOmniPcm, selectImageVideoAdapter } from './media-inputs.mjs';

test('configuration parser handles BOM, export, quotes and comments', () => {
  assert.deepEqual(parseEnv('\uFEFFexport API_KEY="abc#def" # comment\nMODEL=demo # comment\nX=\'with spaces\''), { API_KEY: 'abc#def', MODEL: 'demo', X: 'with spaces' });
  assert.throws(() => parseEnv('KEY="unclosed'), /quote/);
});
test('base rejects secrets and normalizes one version suffix', () => {
  assert.equal(normalizeBase('https://example.invalid/proxy/v1/'), 'https://example.invalid/proxy');
  for (const url of ['file:///test', 'https://user:pass@example.invalid', 'https://example.invalid/?key=secret']) assert.throws(() => normalizeBase(url));
});
test('redaction removes key, bearer and signed parameters', () => {
  const text = redact('key abc123 Bearer abc123 https://example.invalid/?token=hello&x=1', 'abc123');
  assert.ok(!text.includes('abc123')); assert.ok(!text.includes('hello'));
});
test('media signatures reject empty or HTML data', () => {
  assert.equal(mediaType(Buffer.alloc(0)), undefined); assert.equal(mediaType(Buffer.from('<html>not image</html>')), undefined);
});
test('unknown model cannot silently select a video adapter', () => {
  assert.throws(() => selectImageVideoAdapter('wan2.6-i2v'), /adapter/i);
});
test('independently padded Qwen audio chunks decode completely', () => {
  const a = Buffer.from([1, 2]), b = Buffer.from([3, 4]);
  const stream = [a, b].map(chunk => 'data: ' + JSON.stringify({ choices: [{ delta: { audio: { data: chunk.toString('base64') } } }] })).join('\n');
  assert.deepEqual(extractQwenOmniPcm(stream), Buffer.concat([a, b]));
});
test('stream error is fatal even after partial audio', () => {
  const stream = 'data: {"choices":[{"delta":{"audio":{"data":"AQI="}}}]}\ndata: {"error":{"message":"failed"}}';
  assert.throws(() => extractQwenOmniPcm(stream), /failed|error/i);
});
test('HTTP client rejects oversized declared response before reading body', async t => {
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Length': '300000000' }); res.end('{}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const request = createHttp({ key: '', timeout: 200 });
  await assert.rejects(request(`http://127.0.0.1:${server.address().port}`), /size limit/);
});
