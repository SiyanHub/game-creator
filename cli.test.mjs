import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pcm16MonoToWav } from './media-inputs.mjs';

const source = path.dirname(fileURLToPath(import.meta.url));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
async function setup(t, handler, config = '') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'game-creator-test-'));
  for (const file of await fs.readdir(source)) {
    if (file.endsWith('.mjs') && !file.endsWith('.test.mjs')) await fs.copyFile(path.join(source, file), path.join(dir, file));
  }
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const row = { url: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() };
    requests.push(row);
    res.setHeader('Content-Type', 'application/json');
    try { await handler(row, res, requests.length); } catch { res.writeHead(500); res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  await fs.writeFile(path.join(dir, '.env'), `API_KEY=test-only-credential\nAPI_BASE_URL=${base}\n${config}`);
  await fs.writeFile(path.join(dir, 'input.png'), png);
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); });
  async function run(args, env = {}) {
    return new Promise((resolve, reject) => {
      // Do not inherit real provider credentials or user config overrides.
      const child = spawn(process.execPath, ['asset-gen.mjs', ...args], {
        cwd: dir, env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: os.tmpdir(), ...env },
        windowsHide: true,
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
      const timer = setTimeout(() => { child.kill(); reject(new Error('CLI test timeout')); }, 12000);
      child.on('error', reject);
      child.on('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
  }
  return { dir, base, requests, run };
}
const imageResponse = (_req, res) => res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));

test('legacy image command still generates a file', async t => {
  const f = await setup(t, imageResponse); const r = await f.run(['image', 'sprite', 'out.png']);
  assert.equal(r.code, 0, r.stderr); assert.deepEqual(await fs.readFile(path.join(f.dir, 'out.png')), png);
});
test('quoted dotenv and /v1 URL normalize correctly', async t => {
  const f = await setup(t, imageResponse);
  await fs.writeFile(path.join(f.dir, '.env'), `export API_KEY="test-only-credential"\nAPI_BASE_URL='${f.base}/v1/'\n`);
  const r = await f.run(['image', 'sprite', 'out.png']);
  assert.equal(r.code, 0, r.stderr); assert.equal(f.requests[0].url, '/v1/images/generations');
  assert.equal(f.requests[0].headers.authorization, 'Bearer test-only-credential');
});
test('process configuration takes precedence', async t => {
  const f = await setup(t, imageResponse);
  const r = await f.run(['image', 'sprite', 'out.png'], { API_KEY: 'process-key', API_BASE_URL: `${f.base}/v1` });
  assert.equal(r.code, 0, r.stderr); assert.equal(f.requests[0].headers.authorization, 'Bearer process-key');
});
test('doctor and dry-run do not make requests or expose keys', async t => {
  const f = await setup(t, imageResponse);
  for (const args of [['doctor'], ['image', 'sprite', 'out.png', '--dry-run']]) {
    const r = await f.run(args); assert.equal(r.code, 0, r.stderr);
    assert.ok(!r.stdout.includes('test-only-credential')); assert.doesNotThrow(() => JSON.parse(r.stdout));
  }
  assert.equal(f.requests.length, 0);
});
test('image-edit model override reaches request', async t => {
  const f = await setup(t, imageResponse);
  const r = await f.run(['image-edit', 'blue', '--input', 'input.png', '--output', 'out.png', '--model', 'other-image']);
  assert.equal(r.code, 0, r.stderr); assert.equal(JSON.parse(f.requests[0].body).model, 'other-image');
});
test('standard multipart edits use images/edits', async t => {
  const f = await setup(t, imageResponse);
  const r = await f.run(['image-edit', 'blue', '--input', 'input.png', '--output', 'out.png', '--adapter', 'openai-edits']);
  assert.equal(r.code, 0, r.stderr); assert.equal(f.requests[0].url, '/v1/images/edits');
  assert.match(f.requests[0].headers['content-type'], /multipart/); assert.match(f.requests[0].body, /name="image"/);
});
test('existing output is preserved before any paid request', async t => {
  const f = await setup(t, imageResponse); await fs.writeFile(path.join(f.dir, 'out.png'), 'keep');
  const r = await f.run(['image', 'sprite', 'out.png']);
  assert.equal(r.code, 1); assert.equal(await fs.readFile(path.join(f.dir, 'out.png'), 'utf8'), 'keep'); assert.equal(f.requests.length, 0);
});
test('non-image payload is rejected without writing output', async t => {
  const f = await setup(t, (_req, res) => res.end(JSON.stringify({ data: [{ b64_json: Buffer.from('<html>not image</html>').toString('base64') }] })));
  const r = await f.run(['image', 'sprite', 'out.png']); assert.equal(r.code, 1);
  await assert.rejects(fs.stat(path.join(f.dir, 'out.png')), { code: 'ENOENT' });
});
test('upstream errors redact credentials and do not retry POST', async t => {
  const f = await setup(t, (_req, res) => { res.statusCode = 401; res.end(JSON.stringify({ error: { message: 'bad test-only-credential' } })); });
  const r = await f.run(['image', 'sprite', 'out.png']); assert.equal(r.code, 1);
  assert.ok(!r.stderr.includes('test-only-credential')); assert.match(r.stderr, /401/); assert.equal(f.requests.length, 1);
});
test('unknown image-video adapter rejected before upload', async t => {
  const f = await setup(t, (_req, res) => { res.statusCode = 400; res.end('{}'); });
  const r = await f.run(['image-video', 'move', '--input', 'input.png', '--output', 'out.mp4', '--model', 'wan2.6-i2v']);
  assert.equal(r.code, 1); assert.match(r.stderr, /adapter/i); assert.equal(f.requests.length, 0);
});
test('body stall times out without resubmission', async t => {
  const f = await setup(t, (_req, res) => { res.writeHead(200); res.write('{'); });
  const r = await f.run(['image', 'sprite', 'out.png', '--timeout-ms', '100']);
  assert.equal(r.code, 1); assert.match(r.stderr, /time|abort/i); assert.equal(f.requests.length, 1);
});
test('vocal request never falls back to instrumental synthesis', async t => {
  const f = await setup(t, (_req, res) => { res.statusCode = 403; res.end('{}'); });
  const r = await f.run(['music', 'sing', 'song.wav', 'false']); assert.equal(r.code, 1);
  await assert.rejects(fs.stat(path.join(f.dir, 'song.wav')), { code: 'ENOENT' });
});
test('fallback is opt-in and reports local provenance', async t => {
  const f = await setup(t, (_req, res) => { res.statusCode = 403; res.end('{}'); });
  const r = await f.run(['music', 'calm', 'bgm.wav', '--fallback', 'local', '--json']);
  assert.equal(r.code, 0, r.stderr); assert.equal(JSON.parse(r.stdout).provider, 'local-procedural');
  assert.equal((await fs.readFile(path.join(f.dir, 'bgm.wav'))).toString('ascii', 0, 4), 'RIFF');
});
test('video task persists and resumes with GET only', async t => {
  let base;
  const mp4 = Buffer.from('000000186674797069736f6d0000000069736f6d6d703432000000086d646174', 'hex');
  const f = await setup(t, (req, res) => {
    if (req.method === 'POST') return res.end('{"id":"task-123","status":"queued"}');
    if (req.url === '/v1/tasks/task-123') return res.end(JSON.stringify({ status: 'completed', video_url: `${base}/clip` }));
    res.setHeader('content-type', 'video/mp4'); res.end(mp4);
  }); base = f.base;
  const r = await f.run(['video', 'move', 'out.mp4', '--submit-only', '--json']);
  assert.equal(r.code, 0, r.stderr); assert.equal(JSON.parse(r.stdout).status, 'submitted');
  const task = JSON.parse(await fs.readFile(path.join(f.dir, 'out.mp4.task.json'), 'utf8'));
  assert.equal(task.id, 'task-123'); assert.ok(!JSON.stringify(task).includes('test-only-credential'));
  const resumed = await f.run(['resume', 'out.mp4.task.json', '--poll-ms', '10']);
  assert.equal(resumed.code, 0, resumed.stderr); assert.equal(f.requests.filter(r => r.method === 'POST').length, 1);
  assert.deepEqual(await fs.readFile(path.join(f.dir, 'out.mp4')), mp4);
});

test('speech uses the selected model and voice without rewording', async t => {
  const wav = pcm16MonoToWav(Buffer.alloc(480, 1));
  const f = await setup(t, (_req, res) => { res.setHeader('content-type', 'audio/wav'); res.end(wav); });
  const r = await f.run(['speech', '原样台词', 'voice.wav', '--model', 'voice-model', '--voice', 'nova', '--json']);
  assert.equal(r.code, 0, r.stderr); assert.equal(f.requests[0].url, '/v1/audio/speech');
  const body = JSON.parse(f.requests[0].body); assert.equal(body.model, 'voice-model'); assert.equal(body.input, '原样台词'); assert.equal(body.voice, 'nova');
  assert.equal(JSON.parse(r.stdout).provider, 'api');
});
test('Suno music completes via task polling and download', async t => {
  let base; const wav = pcm16MonoToWav(Buffer.alloc(480, 1));
  const f = await setup(t, (req, res) => {
    if (req.method === 'POST') return res.end('{"code":"success","data":"music-1"}');
    if (req.url === '/suno/fetch/music-1') return res.end(JSON.stringify({ data: { status: 'SUCCESS', data: [{ audio_url: base + '/audio' }] } }));
    res.end(wav);
  }); base = f.base;
  const r = await f.run(['music', 'theme', 'song.wav', '--model', 'suno-v4', '--json']);
  assert.equal(r.code, 0, r.stderr); assert.equal(JSON.parse(f.requests[0].body).mv, 'chirp-v4'); assert.equal(JSON.parse(r.stdout).provider, 'api');
});
test('Seedance validates before upload and sends first-frame fields', async t => {
  const f = await setup(t, (req, res) => {
    res.end(req.url === '/fileSystem/upload' ? '{"data":{"url":"https://example.invalid/frame.png"}}' : '{"id":"i2v-1"}');
  });
  const bad = await f.run(['image-video', 'move', '--input', 'input.png', '--output', 'bad.mp4', '--seconds', '99']);
  assert.equal(bad.code, 1); assert.equal(f.requests.length, 0);
  const r = await f.run(['image-video', 'move', '--input', 'input.png', '--output', 'clip.mp4', '--submit-only']);
  assert.equal(r.code, 0, r.stderr); assert.equal(f.requests[0].url, '/fileSystem/upload');
  const body = JSON.parse(f.requests[1].body); assert.equal(body.images[0], 'https://example.invalid/frame.png'); assert.equal(body.metadata.duration, 8);
});
test('OpenAI video uses multipart then authenticated content endpoint', async t => {
  const mp4 = Buffer.from('000000186674797069736f6d0000000069736f6d6d703432000000086d646174', 'hex');
  const f = await setup(t, (req, res) => {
    if (req.method === 'POST') return res.end('{"id":"sora-1","status":"queued"}');
    if (req.url.endsWith('/content')) return res.end(mp4);
    res.end('{"id":"sora-1","status":"completed"}');
  });
  const r = await f.run(['image-video', 'move', '--input', 'input.png', '--output', 'clip.mp4', '--model', 'sora-2']);
  assert.equal(r.code, 0, r.stderr); assert.equal(f.requests[0].url, '/v1/videos'); assert.match(f.requests[0].body, /input_reference/);
  assert.equal(f.requests[2].url, '/v1/videos/sora-1/content'); assert.equal(f.requests[2].headers.authorization, 'Bearer test-only-credential');
});
test('failed task with URL is not reported as successful', async t => {
  const f = await setup(t, (req, res) => res.end(req.method === 'POST' ? '{"id":"bad-1"}' : '{"status":"failed","video_url":"https://example.invalid/clip"}'));
  const r = await f.run(['video', 'move', 'clip.mp4']); assert.equal(r.code, 1); assert.match(r.stderr, /Task failed/); assert.equal(f.requests.length, 2);
});
test('vision model override and prompt file work', async t => {
  const f = await setup(t, (_req, res) => res.end('{"choices":[{"message":{"content":"a blue sprite"}}]}'));
  await fs.writeFile(path.join(f.dir, 'prompt.txt'), 'describe sprite');
  const r = await f.run(['image-text', '--prompt-file', 'prompt.txt', '--input', 'input.png', '--model', 'vision-model']);
  assert.equal(r.code, 0, r.stderr); assert.equal(r.stdout.trim(), 'a blue sprite'); assert.equal(JSON.parse(f.requests[0].body).model, 'vision-model');
});
test('bad image extension and inapplicable options fail before payment', async t => {
  const f = await setup(t, imageResponse);
  for (const args of [['image', 'sprite', 'out.txt'], ['image', 'sprite', 'out.png', '--adapter', 'openai-video'], ['image', 'sprite', 'out.png', '--submit-only']]) {
    const r = await f.run(args); assert.equal(r.code, 1, r.stdout);
  }
  assert.equal(f.requests.length, 0);
});
test('transient GET failure retries without repeating submission', async t => {
  let polls = 0;
  const f = await setup(t, (req, res) => {
    if (req.method === 'POST') return res.end('{"id":"retry-1"}');
    if (++polls === 1) { res.statusCode = 503; return res.end('{}'); }
    res.end('{"status":"failed"}');
  });
  const r = await f.run(['video', 'move', 'out.mp4']); assert.equal(r.code, 1); assert.match(r.stderr, /Task failed/);
  assert.equal(polls, 2); assert.equal(f.requests.filter(r => r.method === 'POST').length, 1);
});
test('resume rejects a manifest for another API host before any network request', async t => {
  const f = await setup(t, imageResponse);
  await fs.writeFile(path.join(f.dir, 'task.json'), JSON.stringify({ version: 1, base: 'https://example.invalid', id: '1', adapter: 'seedance', output: path.join(f.dir, 'out.mp4') }));
  const r = await f.run(['resume', 'task.json']); assert.equal(r.code, 1); assert.match(r.stderr, /mismatch/); assert.equal(f.requests.length, 0);
});
test('invalid poll interval is rejected before submitting a paid task', async t => {
  const f = await setup(t, (_req, res) => res.end('{"id":"should-not-submit"}'));
  const r = await f.run(['video', 'move', 'out.mp4', '--poll-ms', 'invalid']);
  assert.equal(r.code, 1); assert.equal(f.requests.length, 0);
});
test('Qwen speech fallback is explicit and reports wording risk', async t => {
  const f = await setup(t, (req, res) => {
    if (req.url === '/v1/audio/speech') { res.statusCode = 403; return res.end('{}'); }
    res.end('data: {"choices":[{"delta":{"audio":{"data":"AQIDBA=="}}}]}\n\ndata: [DONE]\n');
  });
  const r = await f.run(['speech', 'hello', 'out.wav', '--fallback', 'qwen', '--json']);
  assert.equal(r.code, 0, r.stderr); assert.equal(JSON.parse(r.stdout).wordingMayChange, true); assert.equal(f.requests.length, 2);
});
test('download never receives API authorization', async t => {
  let base;
  const f = await setup(t, (req, res) => {
    if (req.method === 'POST') return res.end(JSON.stringify({ data: [{ url: base + '/file' }] }));
    res.end(png);
  }); base = f.base;
  const r = await f.run(['image', 'sprite', 'out.png']); assert.equal(r.code, 0, r.stderr); assert.equal(f.requests[1].headers.authorization, undefined);
});
