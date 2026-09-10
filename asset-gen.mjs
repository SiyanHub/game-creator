#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  selectQualityModels, buildImageGenerationBody, buildVisionBody, extractChatText,
  buildSeedanceVideoBody, extractTaskId, extractVideoUrl, extractUploadedUrl,
  buildSunoMusicBody, extractSunoTaskId, extractSunoAudioUrl,
  buildSpeechBody, speechFormatFromPath, buildQwenOmniSpeechBody,
  extractQwenOmniPcm, pcm16MonoToWav, synthesizeProceduralBgmWav,
  selectImageVideoAdapter,
} from './media-inputs.mjs';
import { loadConfig, redact, positiveNumber, createHttp, preflightOutput, saveMedia, readImage, writeJsonNew } from './runtime.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let secret = '';
const flags = new Set(['dry-run', 'json', 'submit-only', 'help']);
const valueFlags = new Set(['input', 'output', 'model', 'env-file', 'prompt-file', 'adapter', 'size', 'seconds', 'ratio', 'resolution', 'role', 'voice', 'speed', 'instrumental', 'fallback', 'timeout-ms', 'poll-ms', 'poll-timeout-ms']);

export function parseArgs(args) {
  const [command, ...rest] = args;
  const options = { inputs: [] }, positionals = [];
  for (let i = 0; i < rest.length; i++) {
    const item = rest[i];
    if (!item.startsWith('--')) { positionals.push(item); continue; }
    const name = item.slice(2);
    if (flags.has(name)) options[name] = true;
    else if (valueFlags.has(name)) {
      const value = rest[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
      if (name === 'input') options.inputs.push(value); else options[name] = value;
    } else throw new Error(`Unknown option: ${item}`);
  }
  return { command, options, positionals };
}

function videoAdapter(model, explicit) {
  if (explicit) {
    if (!['seedance', 'openai-video'].includes(explicit)) throw new Error('Video --adapter must be seedance or openai-video');
    return explicit;
  }
  return selectImageVideoAdapter(model);
}

function dataImage(input) {
  if (/^https?:\/\//i.test(input)) return input;
  if (/^data:/i.test(input)) throw new Error('Use a local file or public URL, not an inline data URI');
  const { bytes, mime } = readImage(input);
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

function appendImage(form, name, input) {
  if (/^https?:|^data:/i.test(input)) throw new Error('Multipart adapters require local input images');
  const { bytes, mime } = readImage(input);
  form.append(name, new Blob([bytes], { type: mime }), path.basename(input));
}

function runtime(config, options) {
  const timeout = positiveNumber(options['timeout-ms'] || config.env.REQUEST_TIMEOUT_MS, 120000, 'timeout-ms');
  const http = createHttp({ key: config.key, timeout });
  const auth = { Authorization: `Bearer ${config.key}` };
  return {
    ...config, timeout, http,
    models: selectQualityModels(config.env),
    post: (route, body) => http(config.base + route, {
      method: 'POST', headers: body instanceof FormData ? auth : { ...auth, 'Content-Type': 'application/json' },
      body: body instanceof FormData ? body : JSON.stringify(body),
    }),
    get: route => http(config.base + route, { headers: auth }),
  };
}

async function download(rt, url, output) {
  const parsed = new URL(url);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Invalid media URL');
  // Signed media URLs receive no API Authorization header. Redirects fail closed.
  return saveMedia(await rt.http(url, {}, false), output);
}

async function imageResult(rt, payload, output) {
  const row = payload?.data?.[0] || {};
  if (row.b64_json) return saveMedia(Buffer.from(row.b64_json, 'base64'), output);
  if (row.url?.startsWith('data:')) {
    const match = row.url.match(/^data:image\/[\w.+-]+;base64,([A-Za-z0-9+/=\r\n]+)$/);
    if (!match) throw new Error('Invalid image data URL');
    return saveMedia(Buffer.from(match[1], 'base64'), output);
  }
  if (row.url) return download(rt, row.url, output);
  throw new Error('Image response contained no output');
}

function taskRoute(kind, id) {
  if (!['seedance', 'openai-video', 'suno'].includes(kind)) throw new Error('Unsupported task adapter');
  const prefix = kind === 'suno' ? '/suno/fetch/' : kind === 'seedance' ? '/v1/tasks/' : '/v1/videos/';
  return prefix + encodeURIComponent(id);
}

async function pollTask(rt, task, options) {
  if (task.version !== 1 || task.base !== rt.base || typeof task.id !== 'string' || !task.id || typeof task.output !== 'string' || !path.isAbsolute(task.output)) throw new Error('Invalid task manifest or API base mismatch');
  const route = taskRoute(task.adapter, task.id);
  preflightOutput(task.output);
  const interval = positiveNumber(options['poll-ms'], 10000, 'poll-ms', 60000);
  const deadline = Date.now() + positiveNumber(options['poll-timeout-ms'], 600000, 'poll-timeout-ms');
  while (Date.now() < deadline) {
    // Each poll has the smaller of the remaining overall budget and request deadline.
    const get = createHttp({ key: rt.key, timeout: Math.max(1, Math.min(rt.timeout, deadline - Date.now())) });
    const payload = await get(rt.base + route, { headers: { Authorization: `Bearer ${rt.key}` } });
    const data = Array.isArray(payload.data) ? payload.data[0] : payload.data;
    const status = String(payload.status || payload.state || data?.status || data?.state || '').toLowerCase();
    if (/fail|error|cancel|expire/.test(status)) throw new Error(`Task failed: ${redact(JSON.stringify(payload.error || data?.error || { status }), rt.key).slice(0, 500)}`);
    const url = task.adapter === 'suno' ? extractSunoAudioUrl(payload) : extractVideoUrl(payload);
    if (url && (!status || /complet|succe|finish/.test(status))) {
      return { ...await download(rt, url, task.output), status: 'completed', provider: 'api', model: task.model, taskId: task.id };
    }
    if (task.adapter === 'openai-video' && /complet|succe|finish/.test(status)) {
      const bytes = await rt.http(rt.base + route + '/content', { headers: { Authorization: `Bearer ${rt.key}` } }, false);
      return { ...saveMedia(bytes, task.output), status: 'completed', provider: 'api', model: task.model, taskId: task.id };
    }
    console.error(`Task ${task.id}: ${status || 'pending'}`);
    await pause(Math.min(interval, Math.max(0, deadline - Date.now())));
  }
  throw new Error('Polling timed out; use resume with the saved .task.json (do not submit again)');
}

async function submitted(rt, payload, adapter, model, output, options) {
  const id = adapter === 'suno' ? extractSunoTaskId(payload) : extractTaskId(payload);
  const url = adapter === 'suno' ? extractSunoAudioUrl(payload) : extractVideoUrl(payload);
  let task;
  if (id) {
    task = { version: 1, base: rt.base, id: String(id), adapter, model, output: path.resolve(output), createdAt: new Date().toISOString() };
    writeJsonNew(output + '.task.json', task);
    console.error(`Task saved: ${path.resolve(output + '.task.json')}`);
  }
  if (options['submit-only'] && task) return { status: 'submitted', taskId: task.id, manifest: path.resolve(output + '.task.json'), provider: 'api', model };
  if (url) return { ...await download(rt, url, output), status: 'completed', provider: 'api', model };
  if (!task) throw new Error('Submit response has no task ID or media URL; do not automatically resubmit');
  return pollTask(rt, task, options);
}

async function generate(rt, command, prompt, output, options, extras) {
  const modelKey = { image: 'image', 'image-edit': 'image', 'image-text': 'vision', video: 'video', 'image-video': 'imageVideo', music: 'music', speech: 'speech', tts: 'speech' }[command];
  const model = options.model || rt.models[modelKey];
  const provenance = { status: 'completed', provider: 'api', model };
  if (['image', 'image-edit', 'image-text'].includes(command)) {
    const refs = options.inputs.map(dataImage);
    if (command === 'image-text') {
      const payload = await rt.post('/v1/chat/completions', buildVisionBody({ model, prompt, imageRefs: refs }));
      const text = extractChatText(payload);
      if (!text) throw new Error('Vision returned no text');
      if (output) { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, text, { flag: 'wx' }); }
      return { ...provenance, ...(output ? { output: path.resolve(output) } : { text }) };
    }
    const size = options.size || extras[0] || '1024x1024';
    if (command === 'image-edit' && (options.adapter || rt.env.IMAGE_EDIT_ADAPTER) === 'openai-edits') {
      const form = new FormData();
      form.append('model', model); form.append('prompt', prompt); form.append('size', size); form.append('n', '1');
      options.inputs.forEach(input => appendImage(form, options.inputs.length === 1 ? 'image' : 'image[]', input));
      return { ...await imageResult(rt, await rt.post('/v1/images/edits', form), output), ...provenance };
    }
    return { ...await imageResult(rt, await rt.post('/v1/images/generations', buildImageGenerationBody({ model, prompt, size, imageRefs: refs })), output), ...provenance };
  }
  if (command === 'video' || command === 'image-video') {
    const adapter = videoAdapter(model, options.adapter || rt.env.VIDEO_ADAPTER);
    const seconds = options.seconds || '8';
    let body;
    if (adapter === 'seedance') {
      // Gateway protocol differs from native upstream content[] requests.
      body = { model, prompt, seconds, metadata: { duration: Number(seconds), ratio: options.ratio || 'adaptive', resolution: options.resolution || '720p' } };
      if (command === 'image-video') {
        let imageUrl = options.inputs[0];
        if (!/^https?:\/\//i.test(imageUrl)) {
          const form = new FormData(); appendImage(form, 'file', imageUrl);
          imageUrl = extractUploadedUrl(await rt.post('/fileSystem/upload', form));
          if (!imageUrl || !/^https?:\/\//i.test(imageUrl)) throw new Error('Image upload returned no public URL');
        }
        body = buildSeedanceVideoBody({ model, prompt, imageUrl, seconds, ratio: options.ratio || 'adaptive', resolution: options.resolution || '720p', role: options.role || 'first_frame' });
      }
    } else {
      body = new FormData(); body.append('model', model); body.append('prompt', prompt);
      body.append('seconds', seconds); body.append('size', options.size || '1280x720');
      if (command === 'image-video') appendImage(body, 'input_reference', options.inputs[0]);
    }
    const payload = await rt.post(adapter === 'seedance' ? '/v1/video/generations' : '/v1/videos', body);
    return submitted(rt, payload, adapter, model, output, options);
  }
  if (command === 'music') {
    const instrumental = (options.instrumental || extras[0] || 'true') === 'true';
    let payload;
    try { payload = await rt.post('/suno/submit/music', buildSunoMusicBody({ model, prompt, instrumental })); }
    catch (error) {
      if (options.fallback !== 'local' || !instrumental || ![403, 404, 429].includes(error.status)) throw error;
      console.error(`Suno unavailable (HTTP ${error.status}); explicit local instrumental fallback, not AI music`);
      return { ...saveMedia(synthesizeProceduralBgmWav({ prompt }), output), status: 'completed', provider: 'local-procedural', model: null, fallbackReason: `HTTP ${error.status}` };
    }
    return submitted(rt, payload, 'suno', model, output, options);
  }
  const responseFormat = speechFormatFromPath(output);
  const body = buildSpeechBody({ model, input: prompt, voice: options.voice || extras[0] || 'shimmer', speed: options.speed || extras[1] || '1', responseFormat });
  let bytes;
  try {
    bytes = await rt.http(rt.base + '/v1/audio/speech', { method: 'POST', headers: { Authorization: `Bearer ${rt.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, false);
  } catch (error) {
    if (options.fallback !== 'qwen' || ![403, 404, 429].includes(error.status)) throw error;
    console.error('Explicit Qwen semantic voice fallback; wording may change. Review transcript before use.');
    const fallback = buildQwenOmniSpeechBody({ model: rt.models.speechFallback, input: prompt, voice: rt.models.speechFallbackVoice });
    const sse = await rt.http(rt.base + '/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${rt.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(fallback) }, false);
    bytes = pcm16MonoToWav(extractQwenOmniPcm(sse.toString()));
    return { ...saveMedia(bytes, output), status: 'completed', provider: 'qwen-semantic-fallback', model: rt.models.speechFallback, wordingMayChange: true };
  }
  return { ...saveMedia(bytes, output), ...provenance };
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options, positionals } = parseArgs(argv);
  if (!command || command === '--help' || options.help) {
    console.log('game-creator 2.0.0 | Node >=22\nCommands: doctor, image, image-edit, image-text, video, image-video, music, speech (tts), resume\nUsage: node asset-gen.mjs image "prompt" out.png [size] [--model ID] [--dry-run]\nMedia input: --input path --output path; configuration: --env-file path\nAsync: --submit-only; resume <output.task.json>\nSee SKILL.md and README.md for protocols, fallback consent and all options.'); return;
  }
  const config = loadConfig(directory, options['env-file']); secret = config.key;
  const rt = runtime(config, options);
  if (command === 'doctor') {
    console.log(JSON.stringify({ version: '2.0.0', hasApiKey: config.hasApiKey, base: config.base, envFile: config.envFile || null, models: rt.models, imageEditAdapter: config.env.IMAGE_EDIT_ADAPTER || 'gateway-json', timeoutMs: rt.timeout, networkChecked: false }, null, 2)); return;
  }
  if (command === 'resume') {
    if (positionals.length !== 1) throw new Error('resume requires one task manifest path');
    if (!rt.key || !rt.base) throw new Error('API_KEY and API_BASE_URL are required');
    if (options['dry-run']) throw new Error('resume does not support --dry-run');
    const result = await pollTask(rt, JSON.parse(fs.readFileSync(positionals[0], 'utf8')), options);
    console.log(options.json ? JSON.stringify(result) : result.output); return;
  }
  if (!['image', 'image-edit', 'image-text', 'video', 'image-video', 'music', 'speech', 'tts'].includes(command)) throw new Error(`Unknown command: ${command}`);
  const groups = {
    adapter: ['image-edit', 'video', 'image-video'],
    size: ['image', 'image-edit', 'video', 'image-video'],
    seconds: ['video', 'image-video'], ratio: ['video', 'image-video'], resolution: ['video', 'image-video'],
    role: ['image-video'], voice: ['speech', 'tts'], speed: ['speech', 'tts'], instrumental: ['music'],
    'submit-only': ['video', 'image-video', 'music'], 'poll-ms': ['video', 'image-video', 'music'], 'poll-timeout-ms': ['video', 'image-video', 'music'],
  };
  for (const [option, modes] of Object.entries(groups)) if (options[option] !== undefined && !modes.includes(command)) throw new Error(`--${option} is not supported by ${command}`);
  const prompt = options['prompt-file'] ? fs.readFileSync(options['prompt-file'], 'utf8') : positionals.shift();
  if (!prompt?.trim()) throw new Error('Prompt is required');
  const mediaInput = ['image-edit', 'image-text', 'image-video'].includes(command);
  const output = options.output || (mediaInput ? undefined : positionals.shift());
  if (command !== 'image-text' && !output) throw new Error('Output path is required');
  const allowedExtras = ['speech', 'tts'].includes(command) ? 2 : ['image', 'music'].includes(command) ? 1 : 0;
  if (positionals.length > allowedExtras) throw new Error('Too many positional arguments');
  if (mediaInput && (!options.inputs.length || options.inputs.length > (command === 'image-video' ? 1 : 4))) throw new Error('Image inputs required: max 4 (image-video exactly 1)');
  if (!mediaInput && options.inputs.length) throw new Error('This command does not accept --input');
  for (const input of options.inputs) if (!/^https?:\/\//i.test(input)) readImage(input);
  if (output) preflightOutput(output, options.inputs);
  if (['image', 'image-edit'].includes(command) && !['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(path.extname(output).toLowerCase())) throw new Error('Image output must use a supported image extension');
  if (command === 'music' && !['.mp3', '.wav', '.flac', '.aac', '.opus'].includes(path.extname(output).toLowerCase())) throw new Error('Music output must use a supported audio extension');
  if (['video', 'image-video', 'music'].includes(command)) {
    preflightOutput(output + '.task.json');
    positiveNumber(options['poll-ms'], 10000, 'poll-ms', 60000);
    positiveNumber(options['poll-timeout-ms'], 600000, 'poll-timeout-ms');
  }
  if (['video', 'image-video'].includes(command)) {
    const model = options.model || rt.models[command === 'video' ? 'video' : 'imageVideo'];
    const adapter = videoAdapter(model, options.adapter || rt.env.VIDEO_ADAPTER);
    if (adapter === 'seedance') buildSeedanceVideoBody({ model, prompt, seconds: options.seconds || '8', ratio: options.ratio || 'adaptive', resolution: options.resolution || '720p', role: options.role || 'first_frame', imageUrl: command === 'image-video' ? 'https://example.invalid/reference' : undefined });
    else {
      if (!['4', '8', '12'].includes(options.seconds || '8')) throw new Error('OpenAI video seconds must be 4, 8, or 12');
      if (options.inputs.some(i => /^https?:/i.test(i))) throw new Error('OpenAI video requires a local image');
    }
    if (path.extname(output).toLowerCase() !== '.mp4') throw new Error('Video output must be .mp4');
  }
  if (command === 'image-edit' && !['gateway-json', 'openai-edits'].includes(options.adapter || rt.env.IMAGE_EDIT_ADAPTER || 'gateway-json')) throw new Error('Image-edit adapter must be gateway-json or openai-edits');
  if (['speech', 'tts'].includes(command)) {
    speechFormatFromPath(output);
    const speed = Number(options.speed || positionals[1] || '1');
    if (!Number.isFinite(speed) || speed < 0.25 || speed > 4) throw new Error('Speech speed must be between 0.25 and 4');
  }
  const fallback = options.fallback || 'none';
  if (!['none', ...(command === 'music' ? ['local'] : ['speech', 'tts'].includes(command) ? ['qwen'] : [])].includes(fallback)) throw new Error('Unsupported fallback for this command');
  if (fallback !== 'none' && path.extname(output).toLowerCase() !== '.wav') throw new Error('Fallback requires .wav output');
  if (command === 'music' && !['true', 'false'].includes(options.instrumental || positionals[0] || 'true')) throw new Error('instrumental must be true or false');
  if (options['dry-run']) {
    console.log(JSON.stringify({ status: 'dry-run', command, model: options.model || rt.models[{ 'image-edit': 'image', 'image-video': 'imageVideo', 'image-text': 'vision', tts: 'speech' }[command] || command], base: rt.base, output: output ? path.resolve(output) : null, adapter: options.adapter || null, inputCount: options.inputs.length, fallback, networkRequests: 0 }, null, 2)); return;
  }
  if (!rt.key || !rt.base) throw new Error('API_KEY and API_BASE_URL are required; run doctor');
  const result = await generate(rt, command, prompt, output, options, positionals);
  console.log(options.json ? JSON.stringify(result) : result.output || result.text || JSON.stringify(result));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error('ERROR:', redact(error.message, secret)); process.exitCode = 1; });
}
