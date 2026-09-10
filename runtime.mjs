import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function parseEnv(raw) {
  const values = {};
  for (const line of raw.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][\w]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if (value.startsWith('"') || value.startsWith("'")) {
      const end = value.indexOf(value[0], 1);
      if (end < 0) throw new Error(`Unclosed quote in configuration: ${match[1]}`);
      value = value.slice(1, end);
    } else value = value.replace(/\s+#.*$/, '').trim();
    values[match[1]] = value;
  }
  return values;
}

export function normalizeBase(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('API_BASE_URL must be an absolute HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('API_BASE_URL must use HTTP(S), without credentials, query, or fragment');
  }
  return url.href.replace(/\/+$/, '').replace(/\/v1$/, '');
}

export function loadConfig(directory, explicit, processEnv = process.env) {
  const chosen = explicit || processEnv.GAME_CREATOR_ENV_FILE;
  const candidates = chosen ? [path.resolve(chosen)] : [path.resolve('.env'), path.join(directory, '.env')];
  const envFile = candidates.find(file => fs.existsSync(file));
  if (chosen && !envFile) throw new Error('Explicit configuration file does not exist');
  const values = envFile ? parseEnv(fs.readFileSync(envFile, 'utf8')) : {};
  const env = { ...values, ...processEnv };
  const key = env.API_KEY || '';
  const base = env.API_BASE_URL ? normalizeBase(env.API_BASE_URL) : '';
  return { env, key, base, envFile, hasApiKey: !!key };
}

export function redact(value, key = '') {
  let text = String(value);
  if (key) for (const secret of [key, encodeURIComponent(key), JSON.stringify(key).slice(1, -1)]) text = text.split(secret).join('[REDACTED]');
  return text.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/([?&](?:token|key|api_key|signature|sig)=)[^\s&"']+/gi, '$1[REDACTED]')
    .replace(/data:[^\s"']+/gi, '[DATA OMITTED]');
}

export function positiveNumber(value, fallback, name, maximum = 3600000) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < 1 || number > maximum) throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  return number;
}

// Deadline covers headers AND body. Generation POSTs are never retried.
export function createHttp({ key, timeout = 120000 }) {
  async function once(url, init, json, remaining) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Request timed out')), remaining);
    try {
      const response = await fetch(url, { ...init, redirect: 'error', signal: controller.signal });
      const limit = json ? 128 * 1024 * 1024 : 256 * 1024 * 1024;
      if (Number(response.headers.get('content-length')) > limit) {
        await response.body?.cancel(); throw new Error('Response exceeds size limit');
      }
      const chunks = []; let total = 0;
      if (response.body) for await (const chunk of response.body) {
        total += chunk.length;
        if (total > limit) throw new Error('Response exceeds size limit');
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks, total);
      if (!response.ok) {
        let detail = '';
        try { const body = JSON.parse(bytes.toString()); detail = JSON.stringify(body.error || body.message || body); } catch { detail = 'Non-JSON error response'; }
        const error = new Error(`HTTP ${response.status}: ${redact(detail, key).slice(0, 700)}`);
        error.status = response.status; throw error;
      }
      if (!json) return bytes;
      try { return JSON.parse(bytes.toString()); } catch { throw new Error('Expected JSON; provider returned another format'); }
    } catch (error) {
      if (controller.signal.aborted) throw new Error('Request timed out; do not resubmit an ambiguous paid POST automatically');
      throw error;
    } finally { clearTimeout(timer); }
  }
  return async (url, init = {}, json = true) => {
    const attempts = !init.method || init.method === 'GET' ? 3 : 1;
    const deadline = Date.now() + timeout;
    for (let i = 0; i < attempts; i++) {
      if (Date.now() >= deadline) throw new Error('Request timed out');
      try { return await once(url, init, json, deadline - Date.now()); } catch (error) {
        if (i + 1 === attempts || !(error.status === 429 || error.status >= 500 || error instanceof TypeError)) throw error;
        await new Promise(resolve => setTimeout(resolve, Math.min(200 * (i + 1), Math.max(0, deadline - Date.now()))));
      }
    }
  };
}

export function mediaType(bytes) {
  if (bytes.length < 12) return undefined;
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && bytes.length >= 45
    && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) && bytes.readUInt32BE(20)
    && bytes.subarray(-8, -4).toString() === 'IEND') return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217) return 'jpg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.readUInt32LE(4) + 8 === bytes.length) {
    if (bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
    if (bytes.toString('ascii', 8, 12) === 'WAVE' && bytes.length > 44) return 'wav';
  }
  if (/^GIF8[79]a/.test(bytes.toString('ascii', 0, 6)) && bytes.at(-1) === 59) return 'gif';
  if (bytes.toString('ascii', 4, 8) === 'ftyp' && bytes.readUInt32BE(0) <= bytes.length) return 'mp4';
  if (bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 255 && (bytes[1] & 0xe6) === 0xe2)) return 'mp3';
  if (bytes.toString('ascii', 0, 4) === 'fLaC') return 'flac';
  if (bytes.toString('ascii', 0, 4) === 'OggS') return 'opus';
  if (bytes[0] === 255 && (bytes[1] & 0xf6) === 0xf0) return 'aac';
}

export function preflightOutput(output, inputs = []) {
  const absolute = path.resolve(output);
  if (fs.existsSync(absolute)) throw new Error('Output already exists; choose a new path (no overwrite)');
  for (const input of inputs) if (path.resolve(input).toLowerCase() === absolute.toLowerCase()) throw new Error('Output must differ from input');
  let ancestor = path.dirname(absolute);
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  if (!fs.statSync(ancestor).isDirectory()) throw new Error('Output parent is not a directory');
  fs.accessSync(ancestor, fs.constants.W_OK);
  return absolute;
}

export function saveMedia(bytes, output) {
  const extension = path.extname(output).slice(1).toLowerCase().replace(/^jpeg$/, 'jpg');
  const format = extension === 'pcm' && bytes.length > 0 && bytes.length % 2 === 0 ? 'pcm' : mediaType(bytes);
  if (!format) throw new Error('Invalid or unsupported media payload; nothing saved');
  if (format !== extension) throw new Error(`Output format mismatch: received ${format}, requested .${extension}; use the actual format`);
  preflightOutput(output);
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(output, bytes, { flag: 'wx' });
  return { output: path.resolve(output), bytes: bytes.length, format, sha256: createHash('sha256').update(bytes).digest('hex'), validation: 'container-signature (decode/visual review still required)' };
}

export function readImage(input) {
  if (fs.statSync(input).size > 50 * 1024 * 1024) throw new Error('Input image exceeds 50 MB');
  const bytes = fs.readFileSync(input); const format = mediaType(bytes);
  if (!['png', 'jpg', 'webp', 'gif'].includes(format)) throw new Error('Invalid or unsupported input image');
  return { bytes, mime: `image/${format === 'jpg' ? 'jpeg' : format}` };
}

export function writeJsonNew(file, data) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
}
