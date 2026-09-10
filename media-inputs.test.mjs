import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('fileToDataUri encodes a local PNG with its MIME type', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'game-creator-'));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const imagePath = path.join(tempDir, 'reference.png');
  await fs.writeFile(imagePath, Buffer.from([1, 2, 3]));

  const { fileToDataUri } = await import('./media-inputs.mjs');

  assert.equal(await fileToDataUri(imagePath), 'data:image/png;base64,AQID');
});

test('resolveImageRefs keeps URLs and encodes local image paths', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'game-creator-'));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const imagePath = path.join(tempDir, 'reference.jpg');
  await fs.writeFile(imagePath, Buffer.from([4, 5, 6]));
  const { resolveImageRefs } = await import('./media-inputs.mjs');

  const refs = await resolveImageRefs(['https://example.com/a.png', imagePath]);

  assert.deepEqual(refs, [
    'https://example.com/a.png',
    'data:image/jpeg;base64,BAUG',
  ]);
});

test('resolveImageRefs rejects more than four reference images', async () => {
  const { resolveImageRefs } = await import('./media-inputs.mjs');

  await assert.rejects(
    resolveImageRefs(['1.png', '2.png', '3.png', '4.png', '5.png']),
    /at most 4/i,
  );
});

test('buildImageGenerationBody includes references for image-to-image', async () => {
  const { buildImageGenerationBody } = await import('./media-inputs.mjs');

  assert.deepEqual(buildImageGenerationBody({
    model: 'gpt-image-2',
    prompt: 'keep the silhouette and recolor it blue',
    size: '1024x1024',
    imageRefs: ['data:image/png;base64,AQID'],
  }), {
    model: 'gpt-image-2',
    prompt: 'keep the silhouette and recolor it blue',
    n: 1,
    size: '1024x1024',
    image: ['data:image/png;base64,AQID'],
  });
});

test('buildVisionBody sends text and every image in one user message', async () => {
  const { buildVisionBody } = await import('./media-inputs.mjs');

  const body = buildVisionBody({
    model: 'gpt-5.5',
    prompt: 'Describe this sprite.',
    imageRefs: ['https://example.com/a.png', 'data:image/png;base64,AQID'],
  });

  assert.deepEqual(body.messages[0].content, [
    { type: 'text', text: 'Describe this sprite.' },
    { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
  ]);
});

test('buildImageVideoForm creates the documented input_reference multipart body', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'game-creator-'));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const imagePath = path.join(tempDir, 'first-frame.webp');
  await fs.writeFile(imagePath, Buffer.from([7, 8, 9]));
  const { buildImageVideoForm } = await import('./media-inputs.mjs');

  const form = await buildImageVideoForm({
    model: 'sora-2',
    prompt: 'The slime bounces once.',
    imagePath,
    size: '1280x720',
    seconds: '8',
  });

  assert.equal(form.get('model'), 'sora-2');
  assert.equal(form.get('prompt'), 'The slime bounces once.');
  assert.equal(form.get('size'), '1280x720');
  assert.equal(form.get('seconds'), '8');
  assert.equal(form.get('input_reference').type, 'image/webp');
  assert.deepEqual(
    Buffer.from(await form.get('input_reference').arrayBuffer()),
    Buffer.from([7, 8, 9]),
  );
});

test('buildUploadForm creates the documented file multipart body', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'game-creator-'));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const imagePath = path.join(tempDir, 'upload.png');
  await fs.writeFile(imagePath, Buffer.from([10, 11, 12]));
  const { buildUploadForm } = await import('./media-inputs.mjs');

  const form = await buildUploadForm(imagePath);

  assert.equal(form.get('file').type, 'image/png');
  assert.deepEqual(
    Buffer.from(await form.get('file').arrayBuffer()),
    Buffer.from([10, 11, 12]),
  );
});

test('parseNamedOptions accepts repeated inputs and typed output options', async () => {
  const { parseNamedOptions } = await import('./media-inputs.mjs');

  assert.deepEqual(parseNamedOptions([
    '--input', 'a.png',
    '--input', 'b.png',
    '--output', 'edited.png',
    '--size', '1024x1024',
    '--seconds', '8',
    '--ratio', 'adaptive',
    '--resolution', '720p',
    '--role', 'first_frame',
    '--model', 'sora-2',
  ]), {
    inputs: ['a.png', 'b.png'],
    output: 'edited.png',
    size: '1024x1024',
    seconds: '8',
    ratio: 'adaptive',
    resolution: '720p',
    role: 'first_frame',
    model: 'sora-2',
  });
});

test('buildSeedanceVideoBody uses a first-frame image with bounded video options', async () => {
  const { buildSeedanceVideoBody } = await import('./media-inputs.mjs');

  assert.deepEqual(buildSeedanceVideoBody({
    model: 'doubao-seedance-2-0-260128',
    prompt: 'The slime bounces once.',
    imageUrl: 'https://example.com/slime.png',
    seconds: '8',
    ratio: 'adaptive',
    resolution: '720p',
    role: 'first_frame',
  }), {
    model: 'doubao-seedance-2-0-260128',
    prompt: 'The slime bounces once.',
    images: ['https://example.com/slime.png'],
    seconds: '8',
    metadata: {
      duration: 8,
      ratio: 'adaptive',
      resolution: '720p',
    },
  });
});

test('buildSeedanceVideoBody creates text-to-video content with synchronized audio', async () => {
  const { buildSeedanceVideoBody } = await import('./media-inputs.mjs');

  assert.deepEqual(buildSeedanceVideoBody({
    model: 'doubao-seedance-2-0-260128',
    prompt: 'Robin sings on a luminous stage.',
    seconds: '8',
    ratio: '16:9',
    resolution: '720p',
    generateAudio: true,
  }), {
    model: 'doubao-seedance-2-0-260128',
    content: [
      { type: 'text', text: 'Robin sings on a luminous stage.' },
    ],
    duration: 8,
    ratio: '16:9',
    resolution: '720p',
    generate_audio: true,
  });
});

test('buildSeedanceVideoBody preserves reference-image semantics through unified metadata', async () => {
  const { buildSeedanceVideoBody } = await import('./media-inputs.mjs');

  assert.deepEqual(buildSeedanceVideoBody({
    model: 'doubao-seedance-2-0-260128',
    prompt: 'Compose a new shot with the same singer.',
    imageUrl: 'https://example.com/robin.png',
    seconds: '5',
    ratio: '16:9',
    resolution: '720p',
    role: 'reference_image',
    generateAudio: true,
  }), {
    model: 'doubao-seedance-2-0-260128',
    prompt: 'Compose a new shot with the same singer.',
    images: ['https://example.com/robin.png'],
    seconds: '5',
    metadata: {
      duration: 5,
      ratio: '16:9',
      resolution: '720p',
      generate_audio: true,
      content: [{
        type: 'image_url',
        image_url: { url: 'https://example.com/robin.png' },
        role: 'reference_image',
      }],
    },
  });
});

test('buildSeedanceVideoBody rejects unsupported Seedance 2 duration', async () => {
  const { buildSeedanceVideoBody } = await import('./media-inputs.mjs');

  assert.throws(() => buildSeedanceVideoBody({
    model: 'doubao-seedance-2-0-260128',
    prompt: 'Move.',
    imageUrl: 'https://example.com/slime.png',
    seconds: '3',
    ratio: 'adaptive',
    resolution: '720p',
    role: 'first_frame',
  }), /between 4 and 15/i);
});

test('buildSeedanceVideoBody rejects unsupported enum options', async () => {
  const { buildSeedanceVideoBody } = await import('./media-inputs.mjs');
  const valid = {
    model: 'doubao-seedance-2-0-260128',
    prompt: 'Move.',
    imageUrl: 'https://example.com/slime.png',
    seconds: '8',
    ratio: 'adaptive',
    resolution: '720p',
    role: 'first_frame',
  };

  assert.throws(() => buildSeedanceVideoBody({ ...valid, role: 'thumbnail' }), /role/i);
  assert.throws(() => buildSeedanceVideoBody({ ...valid, ratio: '2:3' }), /ratio/i);
  assert.throws(() => buildSeedanceVideoBody({ ...valid, resolution: '4k' }), /resolution/i);
});

test('response extractors accept documented and nested gateway response shapes', async () => {
  const {
    extractChatText,
    extractTaskId,
    extractUploadedUrl,
    extractVideoUrl,
  } = await import('./media-inputs.mjs');

  assert.equal(extractUploadedUrl({ data: { url: 'https://cdn.example.com/input.png' } }), 'https://cdn.example.com/input.png');
  assert.equal(extractUploadedUrl({ data: 'https://cdn.example.com/input-2.png' }), 'https://cdn.example.com/input-2.png');
  assert.equal(extractChatText({ choices: [{ message: { content: 'A blue slime.' } }] }), 'A blue slime.');
  assert.equal(extractTaskId({ data: { task_id: 'task-123' } }), 'task-123');
  assert.equal(extractVideoUrl({ content: { video_url: 'https://cdn.example.com/out.mp4' } }), 'https://cdn.example.com/out.mp4');
});

test('selectImageVideoAdapter routes Seedance separately from OpenAI-style video models', async () => {
  const { selectImageVideoAdapter } = await import('./media-inputs.mjs');

  assert.equal(selectImageVideoAdapter('doubao-seedance-2-0-260128'), 'seedance');
  assert.equal(selectImageVideoAdapter('sora-2'), 'openai-video');
  assert.throws(() => selectImageVideoAdapter('veo3'), /adapter/);
});

test('selectMediaApiPaths uses the gateway-compatible video, Suno, and speech routes', async () => {
  const { selectMediaApiPaths } = await import('./media-inputs.mjs');

  assert.deepEqual(selectMediaApiPaths({}), {
    videoSubmit: '/v1/video/generations',
    videoTask: '/v1/tasks/{id}',
    sunoSubmit: '/suno/submit/music',
    sunoTask: '/suno/fetch/{id}',
    speech: '/v1/audio/speech',
    speechFallback: '/v1/chat/completions',
  });
});

test('selectQualityModels prefers explicit quality models and quality-first fallbacks', async () => {
  const { selectQualityModels } = await import('./media-inputs.mjs');

  assert.deepEqual(selectQualityModels({
    IMAGE_MODEL: 'custom-image',
    VISION_MODEL: 'custom-vision',
    VIDEO_MODEL: 'custom-video',
    IMAGE_VIDEO_MODEL: 'custom-image-video',
    MUSIC_MODEL: 'custom-music',
    SPEECH_MODEL: 'custom-speech',
    SPEECH_FALLBACK_MODEL: 'custom-speech-fallback',
    SPEECH_FALLBACK_VOICE: 'custom-fallback-voice',
  }), {
    image: 'custom-image',
    vision: 'custom-vision',
    video: 'custom-video',
    imageVideo: 'custom-image-video',
    music: 'custom-music',
    speech: 'custom-speech',
    speechFallback: 'custom-speech-fallback',
    speechFallbackVoice: 'custom-fallback-voice',
  });

  assert.deepEqual(selectQualityModels({}), {
    image: 'gpt-image-2',
    vision: 'gpt-5.5',
    video: 'doubao-seedance-2-0-260128',
    imageVideo: 'doubao-seedance-2-0-260128',
    music: 'suno-v4.5+',
    speech: 'tts-1-hd',
    speechFallback: 'qwen3-omni-flash',
    speechFallbackVoice: 'Cherry',
  });
});

test('buildSpeechBody creates a standard OpenAI-compatible text-to-speech request', async () => {
  const { buildSpeechBody } = await import('./media-inputs.mjs');

  assert.deepEqual(buildSpeechBody({
    model: 'tts-1-hd',
    input: '愿歌声照亮每一颗孤独的星。',
    voice: 'shimmer',
    responseFormat: 'mp3',
    speed: '0.95',
  }), {
    model: 'tts-1-hd',
    input: '愿歌声照亮每一颗孤独的星。',
    voice: 'shimmer',
    response_format: 'mp3',
    speed: 0.95,
  });
});

test('buildQwenOmniSpeechBody creates the required streaming audio request', async () => {
  const { buildQwenOmniSpeechBody } = await import('./media-inputs.mjs');

  assert.deepEqual(buildQwenOmniSpeechBody({
    model: 'qwen3-omni-flash',
    input: '愿歌声陪你抵达群星。',
    voice: 'Cherry',
  }), {
    model: 'qwen3-omni-flash',
    messages: [
      {
        role: 'system',
        content: '你是游戏语音生成器。只说用户提供的台词，不解释，不扩写，不添加开场白或结尾。',
      },
      { role: 'user', content: '请只说以下台词：\n愿歌声陪你抵达群星。' },
    ],
    modalities: ['text', 'audio'],
    audio: { voice: 'Cherry', format: 'wav' },
    stream: true,
    stream_options: { include_usage: true },
    enable_thinking: false,
  });
});

test('extractQwenOmniPcm joins audio deltas from an SSE response', async () => {
  const { extractQwenOmniPcm } = await import('./media-inputs.mjs');
  const sse = [
    `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: Buffer.from([1, 2, 3]).toString('base64') } } }] })}`,
    '',
    `data: ${JSON.stringify({ choices: [{ delta: { content: '台词' } }] })}`,
    '',
    `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: Buffer.from([4, 5, 6]).toString('base64') } } }] })}`,
    '',
    'data: [DONE]',
  ].join('\n');

  assert.deepEqual(extractQwenOmniPcm(sse), Buffer.from([1, 2, 3, 4, 5, 6]));
  assert.throws(() => extractQwenOmniPcm('data: [DONE]\n'), /no audio/i);
});

test('pcm16MonoToWav wraps 24 kHz PCM in a valid RIFF/WAVE container', async () => {
  const { pcm16MonoToWav } = await import('./media-inputs.mjs');
  const pcm = Buffer.from([1, 2, 3, 4]);
  const wav = pcm16MonoToWav(pcm);

  assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
  assert.equal(wav.subarray(8, 12).toString(), 'WAVE');
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.deepEqual(wav.subarray(44), pcm);
});

test('shouldUseSpeechFallback distinguishes provider failures from bad user requests', async () => {
  const { shouldUseSpeechFallback } = await import('./media-inputs.mjs');

  assert.equal(shouldUseSpeechFallback(403), true);
  assert.equal(shouldUseSpeechFallback(404), true);
  assert.equal(shouldUseSpeechFallback(429), true);
  assert.equal(shouldUseSpeechFallback(503), true);
  assert.equal(shouldUseSpeechFallback(400), false);
  assert.equal(shouldUseSpeechFallback(401), false);
});

test('isRetryableSpeechFallback retries connection failures and temporary HTTP failures', async () => {
  const { isRetryableSpeechFallback } = await import('./media-inputs.mjs');

  assert.equal(isRetryableSpeechFallback(undefined), true);
  assert.equal(isRetryableSpeechFallback(429), true);
  assert.equal(isRetryableSpeechFallback(502), true);
  assert.equal(isRetryableSpeechFallback(400), false);
  assert.equal(isRetryableSpeechFallback(401), false);
});

test('shouldUseMusicFallback accepts provider/configuration failures but not invalid prompts', async () => {
  const { shouldUseMusicFallback } = await import('./media-inputs.mjs');

  assert.equal(shouldUseMusicFallback(403), true);
  assert.equal(shouldUseMusicFallback(404), true);
  assert.equal(shouldUseMusicFallback(429), true);
  assert.equal(shouldUseMusicFallback(502), true);
  assert.equal(shouldUseMusicFallback(400), false);
  assert.equal(shouldUseMusicFallback(401), false);
});

test('synthesizeProceduralBgmWav creates deterministic non-silent stereo PCM music', async () => {
  const { synthesizeProceduralBgmWav } = await import('./media-inputs.mjs');
  const options = {
    prompt: 'luminous hopeful cosmic pop with bells',
    bars: 1,
    sampleRate: 8000,
  };
  const first = synthesizeProceduralBgmWav(options);
  const second = synthesizeProceduralBgmWav(options);

  assert.deepEqual(first, second);
  assert.equal(first.subarray(0, 4).toString(), 'RIFF');
  assert.equal(first.subarray(8, 12).toString(), 'WAVE');
  assert.equal(first.readUInt16LE(22), 2);
  assert.equal(first.readUInt32LE(24), 8000);
  assert.equal(first.readUInt16LE(34), 16);
  assert.ok(first.readUInt32LE(40) > 8000 * 4);
  assert.ok(first.subarray(44).some((value) => value !== 0));
});

test('speechFormatFromPath derives supported response formats from output filenames', async () => {
  const { speechFormatFromPath } = await import('./media-inputs.mjs');

  assert.equal(speechFormatFromPath('voice.mp3'), 'mp3');
  assert.equal(speechFormatFromPath('voice.wav'), 'wav');
  assert.throws(() => speechFormatFromPath('voice.txt'), /supported audio extension/i);
});

test('isRetryableMediaStatus retries temporary saturation but not configuration errors', async () => {
  const { isRetryableMediaStatus } = await import('./media-inputs.mjs');

  assert.equal(isRetryableMediaStatus(429), true);
  assert.equal(isRetryableMediaStatus(503), true);
  assert.equal(isRetryableMediaStatus(403), false);
  assert.equal(isRetryableMediaStatus(400), false);
});

test('retryTransientOperation recovers from two connection failures without resubmitting work', async () => {
  const { retryTransientOperation } = await import('./media-inputs.mjs');
  let attempts = 0;

  const result = await retryTransientOperation(async () => {
    attempts += 1;
    if (attempts < 3) {
      const error = new Error('fetch failed');
      error.cause = { code: 'UND_ERR_CONNECT_TIMEOUT' };
      throw error;
    }
    return 'downloaded';
  }, { delays: [0, 0] });

  assert.equal(result, 'downloaded');
  assert.equal(attempts, 3);
});

test('buildSunoMusicBody maps the configured quality model to the provider mv enum', async () => {
  const { buildSunoMusicBody } = await import('./media-inputs.mjs');

  assert.deepEqual(buildSunoMusicBody({
    model: 'suno-v4.5+',
    prompt: 'A tense looping boss theme.',
    instrumental: true,
  }), {
    gpt_description_prompt: 'A tense looping boss theme.',
    make_instrumental: true,
    mv: 'chirp-bluejay',
  });
  assert.throws(
    () => buildSunoMusicBody({ model: 'unknown-music', prompt: 'x', instrumental: false }),
    /unsupported MUSIC_MODEL/i,
  );
});

test('Suno response helpers read New API task IDs and successful audio items', async () => {
  const { extractSunoAudioUrl, extractSunoTaskId } = await import('./media-inputs.mjs');

  assert.equal(extractSunoTaskId({ code: 'success', data: 'task-123' }), 'task-123');
  assert.equal(extractSunoAudioUrl({
    data: {
      status: 'SUCCESS',
      data: [
        { status: 'failed' },
        { status: 'complete', audio_url: 'https://cdn.example.com/song.mp3' },
      ],
    },
  }), 'https://cdn.example.com/song.mp3');
});
