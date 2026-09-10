import fs from 'node:fs/promises';
import path from 'node:path';

const IMAGE_MIME_TYPES = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

const SUNO_MODEL_VERSIONS = new Map([
  ['suno-v3', 'chirp-v3-0'],
  ['suno-v3.5', 'chirp-v3-5'],
  ['suno-v4', 'chirp-v4'],
  ['suno-v4.5', 'chirp-auk'],
  ['suno-v4.5+', 'chirp-bluejay'],
  ['suno-v5', 'chirp-crow'],
]);

export function selectQualityModels(env = {}) {
  const video = env.VIDEO_MODEL || 'doubao-seedance-2-0-260128';
  return {
    image: env.IMAGE_MODEL || 'gpt-image-2',
    vision: env.VISION_MODEL || 'gpt-5.5',
    video,
    imageVideo: env.IMAGE_VIDEO_MODEL || video,
    music: env.MUSIC_MODEL || 'suno-v4.5+',
    speech: env.SPEECH_MODEL || 'tts-1-hd',
    speechFallback: env.SPEECH_FALLBACK_MODEL || 'qwen3-omni-flash',
    speechFallbackVoice: env.SPEECH_FALLBACK_VOICE || 'Cherry',
  };
}

function toSunoModelVersion(model) {
  if ([...SUNO_MODEL_VERSIONS.values()].includes(model)) return model;
  const version = SUNO_MODEL_VERSIONS.get(model);
  if (!version) throw new Error(`unsupported MUSIC_MODEL: ${model}`);
  return version;
}

export function buildSunoMusicBody({ model, prompt, instrumental }) {
  return {
    gpt_description_prompt: prompt,
    make_instrumental: instrumental,
    mv: toSunoModelVersion(model),
  };
}

export function buildSpeechBody({ model, input, voice, responseFormat, speed }) {
  return {
    model,
    input,
    voice,
    response_format: responseFormat,
    speed: Number(speed),
  };
}

export function buildQwenOmniSpeechBody({ model, input, voice }) {
  return {
    model,
    messages: [
      {
        role: 'system',
        content: '你是游戏语音生成器。只说用户提供的台词，不解释，不扩写，不添加开场白或结尾。',
      },
      { role: 'user', content: `请只说以下台词：\n${input}` },
    ],
    modalities: ['text', 'audio'],
    audio: { voice, format: 'wav' },
    stream: true,
    stream_options: { include_usage: true },
    enable_thinking: false,
  };
}

export function extractQwenOmniPcm(sseText) {
  let encoded = '';
  const buffers = [];
  let upstreamError;
  for (const line of sseText.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      continue;
    }
    const audio = payload?.choices?.[0]?.delta?.audio?.data;
    if (typeof audio === 'string') {
      encoded += audio;
      // Padded deltas are independently encoded; concatenating base64 strings
      // would truncate decoding at the first padding marker.
      if (encoded.endsWith('=')) {
        buffers.push(Buffer.from(encoded, 'base64'));
        encoded = '';
      }
    }
    if (payload?.error) upstreamError = payload.error;
  }
  if (upstreamError) throw new Error(`Qwen stream error: ${JSON.stringify(upstreamError).slice(0, 300)}`);
  if (!encoded && !buffers.length) {
    const detail = upstreamError ? `: ${JSON.stringify(upstreamError).slice(0, 300)}` : '';
    throw new Error(`Qwen Omni stream returned no audio${detail}`);
  }
  if (encoded) buffers.push(Buffer.from(encoded, 'base64'));
  const pcm = Buffer.concat(buffers);
  if (!pcm.length || pcm.length % 2) throw new Error('Qwen Omni stream returned invalid PCM audio bytes');
  return pcm;
}

export function pcm16MonoToWav(pcm, sampleRate = 24000) {
  if (!Buffer.isBuffer(pcm) || !pcm.length) throw new Error('PCM audio must be a non-empty Buffer');
  const channels = 1;
  const bitsPerSample = 16;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28);
  header.writeUInt16LE(channels * bitsPerSample / 8, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function shouldUseSpeechFallback(status) {
  return status === 403 || status === 404 || status === 429 || status >= 500;
}

export function isRetryableSpeechFallback(status) {
  return status === undefined || isRetryableMediaStatus(status);
}

export function shouldUseMusicFallback(status) {
  return status === 403 || status === 404 || status === 429 || status >= 500;
}

function textHash(text) {
  let hash = 2166136261;
  for (const character of text) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function midiToFrequency(note) {
  return 440 * (2 ** ((note - 69) / 12));
}

function deterministicNoise(index, seed) {
  const value = Math.sin((index + seed) * 12.9898) * 43758.5453;
  return (value - Math.floor(value)) * 2 - 1;
}

function clampSample(value) {
  return Math.max(-1, Math.min(1, value));
}

export function synthesizeProceduralBgmWav({ prompt, bars = 8, sampleRate = 44100 }) {
  const hash = textHash(prompt);
  const calm = /calm|ambient|dream|gentle|soft|宁静|温柔|梦幻|舒缓/i.test(prompt);
  const intense = /boss|battle|intense|combat|urgent|战斗|紧张|激烈|首领/i.test(prompt);
  const bpm = calm ? 92 : (intense ? 136 : 112);
  const beatDuration = 60 / bpm;
  const barDuration = beatDuration * 4;
  const duration = bars * barDuration;
  const frames = Math.ceil(duration * sampleRate);
  const channels = 2;
  const bitsPerSample = 16;
  const data = Buffer.alloc(frames * channels * (bitsPerSample / 8));
  const keyMidi = 48 + (hash % 5);
  const chordRoots = [0, 7, 9, 5];
  const chordQualities = [4, 4, 3, 4];
  const pentatonic = [0, 2, 4, 7, 9];
  const arpPattern = [0, 1, 2, 1, 3, 2, 1, 2];

  for (let frame = 0; frame < frames; frame += 1) {
    const time = frame / sampleRate;
    const bar = Math.min(bars - 1, Math.floor(time / barDuration));
    const barTime = time - bar * barDuration;
    const progressionIndex = bar % chordRoots.length;
    const rootMidi = keyMidi + chordRoots[progressionIndex];
    const third = chordQualities[progressionIndex];
    const chordNotes = [0, third, 7];
    const barAttack = Math.min(1, barTime / 0.08);
    const barRelease = Math.min(1, (barDuration - barTime) / 0.14);
    const chordEnvelope = Math.max(0, Math.min(barAttack, barRelease));
    let padLeft = 0;
    let padRight = 0;
    for (const interval of chordNotes) {
      const frequency = midiToFrequency(rootMidi + interval);
      padLeft += Math.sin(2 * Math.PI * frequency * time)
        + 0.22 * Math.sin(2 * Math.PI * frequency * 2 * time);
      padRight += Math.sin(2 * Math.PI * frequency * 1.002 * time + 0.17)
        + 0.22 * Math.sin(2 * Math.PI * frequency * 1.998 * time + 0.31);
    }
    padLeft *= 0.045 * chordEnvelope;
    padRight *= 0.045 * chordEnvelope;

    const beatInBar = Math.min(3, Math.floor(barTime / beatDuration));
    const beatPosition = barTime - beatInBar * beatDuration;
    const bassFrequency = midiToFrequency(rootMidi - 12);
    const bassEnvelope = Math.exp(-beatPosition * 4.5 / beatDuration);
    const bass = 0.13 * bassEnvelope * (
      Math.sin(2 * Math.PI * bassFrequency * time)
      + 0.18 * Math.sin(2 * Math.PI * bassFrequency * 2 * time)
    );

    const halfBeat = beatDuration / 2;
    const arpStep = Math.min(7, Math.floor(barTime / halfBeat));
    const arpPosition = barTime - arpStep * halfBeat;
    const arpIntervals = [0, third, 7, 12];
    const arpFrequency = midiToFrequency(rootMidi + 12 + arpIntervals[arpPattern[arpStep]]);
    const arpEnvelope = Math.exp(-arpPosition * 8 / halfBeat);
    const bell = 0.105 * arpEnvelope * (
      Math.sin(2 * Math.PI * arpFrequency * time)
      + 0.34 * Math.sin(2 * Math.PI * arpFrequency * 2.01 * time)
      + 0.13 * Math.sin(2 * Math.PI * arpFrequency * 3.97 * time)
    );
    const arpPan = arpStep % 2 === 0 ? 0.72 : 0.28;

    const globalBeat = Math.floor(time / beatDuration);
    const melodyIndex = (globalBeat + ((hash >>> (globalBeat % 16)) & 3)) % pentatonic.length;
    const melodyOctave = ((hash >>> ((globalBeat + 5) % 16)) & 1) * 12;
    const melodyFrequency = midiToFrequency(keyMidi + 12 + pentatonic[melodyIndex] + melodyOctave);
    const melodyEnvelope = Math.sin(Math.PI * Math.min(1, beatPosition / (beatDuration * 0.92)));
    const melody = 0.075 * Math.max(0, melodyEnvelope) * (
      Math.sin(2 * Math.PI * melodyFrequency * time)
      + 0.16 * Math.sin(2 * Math.PI * melodyFrequency * 2 * time)
    );

    const noise = deterministicNoise(frame, hash);
    const kickActive = beatInBar === 0 || beatInBar === 2;
    const kickFrequency = 72 - 30 * Math.min(1, beatPosition / beatDuration);
    const kick = kickActive
      ? 0.17 * Math.exp(-beatPosition * 16 / beatDuration)
        * Math.sin(2 * Math.PI * kickFrequency * beatPosition)
      : 0;
    const snare = (beatInBar === 1 || beatInBar === 3)
      ? 0.055 * noise * Math.exp(-beatPosition * 22 / beatDuration)
      : 0;
    const hatPosition = barTime % halfBeat;
    const hat = 0.018 * noise * Math.exp(-hatPosition * 45 / halfBeat);
    const drums = kick + snare + hat;

    const edgeFadeSeconds = Math.min(0.02, duration / 8);
    const edgeGain = Math.min(1, time / edgeFadeSeconds, (duration - time) / edgeFadeSeconds);
    const left = clampSample((padLeft + bass + bell * (1 - arpPan) + melody * 0.58 + drums) * edgeGain);
    const right = clampSample((padRight + bass + bell * arpPan + melody * 0.78 + drums) * edgeGain);
    data.writeInt16LE(Math.round(left * 32767), frame * 4);
    data.writeInt16LE(Math.round(right * 32767), frame * 4 + 2);
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28);
  header.writeUInt16LE(channels * bitsPerSample / 8, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export function speechFormatFromPath(outPath) {
  const format = path.extname(outPath).slice(1).toLowerCase();
  if (!new Set(['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm']).has(format)) {
    throw new Error('speech output must use a supported audio extension: mp3, opus, aac, flac, wav, or pcm');
  }
  return format;
}

export function isRetryableMediaStatus(status) {
  return status === 429 || status >= 500;
}

export async function retryTransientOperation(operation, {
  delays = [2000, 5000],
  onRetry,
} = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      const retryable = error?.status === undefined || isRetryableMediaStatus(error.status);
      if (!retryable || attempt >= delays.length) throw error;
      onRetry?.(error, attempt + 1, delays[attempt]);
      if (delays[attempt] > 0) {
        await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      }
    }
  }
}

export async function fileToDataUri(filePath) {
  const mimeType = imageMimeType(filePath);
  const data = await fs.readFile(filePath);
  return `data:${mimeType};base64,${data.toString('base64')}`;
}

function imageMimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const mimeType = IMAGE_MIME_TYPES[extension];
  if (!mimeType) throw new Error(`unsupported image type: ${path.extname(filePath) || '(none)'}`);
  return mimeType;
}

export async function resolveImageRefs(inputs) {
  if (inputs.length > 4) throw new Error('image input accepts at most 4 reference images');
  return Promise.all(inputs.map((input) => {
    if (/^https?:\/\//i.test(input) || /^data:image\//i.test(input)) return input;
    return fileToDataUri(input);
  }));
}

export function buildImageGenerationBody({ model, prompt, size, imageRefs = [] }) {
  const body = { model, prompt, n: 1, size };
  if (imageRefs.length) body.image = imageRefs;
  return body;
}

export function buildVisionBody({ model, prompt, imageRefs }) {
  return {
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        ...imageRefs.map((url) => ({ type: 'image_url', image_url: { url } })),
      ],
    }],
  };
}

export async function buildImageVideoForm({ model, prompt, imagePath, size, seconds }) {
  const form = new FormData();
  form.append('model', model);
  form.append('prompt', prompt);
  form.append('size', size);
  form.append('seconds', String(seconds));
  await appendImageFile(form, 'input_reference', imagePath);
  return form;
}

export async function buildUploadForm(imagePath) {
  const form = new FormData();
  await appendImageFile(form, 'file', imagePath);
  return form;
}

async function appendImageFile(form, fieldName, imagePath) {
  const data = await fs.readFile(imagePath);
  form.append(fieldName, new Blob([data], { type: imageMimeType(imagePath) }), path.basename(imagePath));
}

export function buildSeedanceVideoBody({
  model,
  prompt,
  imageUrl,
  seconds,
  ratio,
  resolution,
  role,
  generateAudio,
}) {
  const duration = Number(seconds);
  if (!Number.isInteger(duration) || duration < 4 || duration > 15) {
    throw new Error('Seedance 2 duration must be an integer between 4 and 15 seconds');
  }
  if (imageUrl && !new Set(['first_frame', 'reference_image']).has(role)) {
    throw new Error('Seedance image role must be first_frame or reference_image');
  }
  if (!new Set(['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive']).has(ratio)) {
    throw new Error('unsupported Seedance ratio');
  }
  if (!new Set(['480p', '720p', '1080p']).has(resolution)) {
    throw new Error('unsupported Seedance resolution');
  }
  if (imageUrl) {
    const metadata = {
      duration,
      ratio,
      resolution,
    };
    if (generateAudio !== undefined) metadata.generate_audio = generateAudio;
    if (role === 'reference_image') {
      metadata.content = [{
        type: 'image_url',
        image_url: { url: imageUrl },
        role,
      }];
    }
    return {
      model,
      prompt,
      images: [imageUrl],
      seconds: String(duration),
      metadata,
    };
  }
  const body = {
    model,
    content: [{ type: 'text', text: prompt }],
    duration,
    ratio,
    resolution,
  };
  if (imageUrl) body.content.push({ type: 'image_url', image_url: { url: imageUrl }, role });
  if (generateAudio !== undefined) body.generate_audio = generateAudio;
  return body;
}

export function extractUploadedUrl(payload) {
  return payload?.url
    || payload?.file_url
    || (typeof payload?.data === 'string' ? payload.data : undefined)
    || payload?.data?.url
    || payload?.data?.file_url
    || payload?.result?.url;
}

export function extractChatText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => part?.text || '').filter(Boolean).join('\n');
  }
  return undefined;
}

export function extractTaskId(payload) {
  return payload?.id
    || payload?.task_id
    || payload?.data?.id
    || payload?.data?.task_id
    || payload?.result?.id;
}

export function extractVideoUrl(payload) {
  return payload?.result_url
    || payload?.video_url
    || payload?.url
    || payload?.content?.video_url
    || payload?.data?.video_url
    || payload?.result?.video_url
    || payload?.result?.data?.content?.video_url;
}

export function extractSunoTaskId(payload) {
  if (typeof payload?.data === 'string') return payload.data;
  return payload?.data?.task_id || payload?.task_id;
}

export function extractSunoAudioUrl(payload) {
  const task = Array.isArray(payload?.data) ? payload.data[0] : payload?.data;
  const items = task?.data;
  if (!Array.isArray(items)) return undefined;
  return items.find((item) => item?.audio_url)?.audio_url;
}

export function selectImageVideoAdapter(model) {
  if (/seedance/i.test(model)) return 'seedance';
  if (/^sora-2(?:-|$)/i.test(model)) return 'openai-video';
  throw new Error('Unknown video model adapter; verify protocol and select an explicit adapter');
}

export function selectMediaApiPaths() {
  return {
    videoSubmit: '/v1/video/generations',
    videoTask: '/v1/tasks/{id}',
    sunoSubmit: '/suno/submit/music',
    sunoTask: '/suno/fetch/{id}',
    speech: '/v1/audio/speech',
    speechFallback: '/v1/chat/completions',
  };
}

export function parseNamedOptions(args) {
  const options = { inputs: [] };
  const valueOptions = new Set([
    '--input',
    '--model',
    '--output',
    '--ratio',
    '--resolution',
    '--role',
    '--seconds',
    '--size',
  ]);
  for (let i = 0; i < args.length; i += 1) {
    const option = args[i];
    if (!valueOptions.has(option)) throw new Error(`unknown option: ${option}`);
    const value = args[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${option}`);
    i += 1;
    if (option === '--input') options.inputs.push(value);
    else options[option.slice(2)] = value;
  }
  return options;
}
