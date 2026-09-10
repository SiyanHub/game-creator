# Provider adapters and multimodal workflows

These adapters describe supported request shapes, not model uptime promises.
Provider-specific endpoints require a compatible gateway. Do not use a gateway
adapter directly against a native provider with a different API.

| Mode/adapter | Submit | Input | Poll |
|---|---|---|---|
| Image | `/v1/images/generations` | JSON model, prompt, size, n=1 | synchronous |
| Edit: `gateway-json` (default) | `/v1/images/generations` | JSON image array of refs | synchronous |
| Edit: `openai-edits` | `/v1/images/edits` | multipart image/image[] | synchronous |
| Vision | `/v1/chat/completions` | text + image_url content | synchronous |
| Video: `seedance` | `/v1/video/generations` | gateway JSON prompt, images, seconds, metadata | `/v1/tasks/{id}` |
| Video: `openai-video` | `/v1/videos` | multipart; optional input_reference | `/v1/videos/{id}` |
| Suno | `/suno/submit/music` | gpt_description_prompt, make_instrumental, mv | `/suno/fetch/{id}` |
| Speech | `/v1/audio/speech` | model, input, voice, response_format, speed | synchronous |

Base URL normalization supports a gateway root (including a reverse-proxy path)
or the same URL ending in `/v1`; it does not accept full operation URLs. Upload
and Suno endpoints are relative to the gateway root, not the versioned root.

## Images

Image edit/vision: 1–4 inputs. I2V: exactly one input. Local PNG, JPEG, WebP and
GIF are checked by content markers and limited to 50 MB each. This does not prove
that every model accepts every format. Public URLs are passed to the provider;
local input validation cannot verify their remote contents.

Gateway editing encodes local images as data URIs. Standard editing accepts
local files only, with `--adapter openai-edits`. No automatic cross-protocol retry.
Masks and arbitrary provider-specific edit fields are not supported in v2.0.

Specify what should remain unchanged and what should change. Inspect character
identity and style consistency before using an edited still as a video reference.

## Video

Seedance is the configured gateway adapter, **not** the native upstream API.
Local I2V input is uploaded to `/fileSystem/upload`; the resulting public URL
is then sent to the video endpoint. Duration: 4–15 seconds. Ratio: `adaptive`,
`16:9`, `4:3`, `1:1`, `3:4`, `9:16`, `21:9`. Resolution: `480p`, `720p`, `1080p`.
Role: `first_frame` (default), or `reference_image` stored in metadata.content.

Sora-2 names default to `openai-video`. Duration: 4, 8, 12 seconds; default
`--size 1280x720`. A completed task without a URL is downloaded through the
authenticated `/v1/videos/{id}/content` endpoint. Other model names (including
Wan/Veo/Kling) require explicit `--adapter` after checking their provider docs.
Selecting an adapter does not make an unsupported model support that protocol.

The sidecar manifest stores ID, API base, adapter, model and absolute output
path; no API key, prompt, input bytes or signed media URL. Resume only manifests
you trust. Moving the manifest to another machine requires deliberate path
adjustment. The current configuration must match its API base.

GET polling has a default 600000 ms overall budget; `--poll-timeout-ms` and
`--poll-ms` override it. HTTP body reads have their own bounded deadline. A final
download has a separate request budget. Existing outputs/sidecars are never
overwritten. The manifest remains as the submission receipt after completion.

## Audio and composed workflows

Suno model aliases map to its mv values (e.g. suno-v4.5+ -> chirp-bluejay). This
requires the gateway's Suno route; it is not an Udio adapter. Use MP3 unless the
provider returns another format. A `.wav` filename never converts MP3 bytes.

Speech supports MP3, Opus/Ogg, AAC, FLAC, WAV and raw PCM. Raw PCM has no signature:
only nonempty even-byte PCM16 length is checked; its sample rate must be confirmed
from the provider. Qwen fallback wraps its PCM as 24 kHz mono WAV. Review speech
content separately, particularly with that fallback.

For image -> music, first use image-text to prepare a soundtrack brief, inspect
that text, then call music. This is two paid stages, not a native image-to-music
model. For image -> edit -> video, inspect the edited image before animating it.

## Recovery boundaries

401/403: inspect account/channel authorization; do not repeatedly resubmit.
400: inspect model protocol and parameters. 429: respect provider limits.
5xx/connection failure during POST: potentially accepted, do not blindly retry.
A failed task at 100% is still failed. A saved file with valid headers still
requires decoding and semantic inspection before asset acceptance.

HTTP redirects fail closed in this release, including media downloads. For a
redirecting CDN, obtain its final authorized media URL/provider support; do not
forward the API key to the CDN. JSON response limit is 128 MiB, binary 256 MiB.
