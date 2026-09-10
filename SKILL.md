---
name: game-creator
description: Generate game artwork, reference-image edits, image analysis, text-to-video, image-to-video, speech and background music through configured media APIs. Use when the user asks for sprites, icons, character art, trailers, narration, soundtrack assets or debugging this media workflow. Supports explicit gateway adapters and opt-in local BGM or semantic speech fallbacks.
---

# game-creator

Use `asset-gen.mjs` beside this file. Resolve its absolute path from the installed
skill directory; examples below assume that directory is the current directory.
Requires Node.js 22+. No npm dependencies. Keep the name `game-creator`.

## Before generation

1. Resolve subject/style, input files, intended mode and output folder. Respect
   the user's folder choice; put generated tests and reports in `BH Test` when
   requested. Preserve reference media and use a new filename for each output.
2. Run `node asset-gen.mjs doctor`. It is a **local configuration check**, not
   a live provider availability check. Never read or print a user's key just
   to diagnose a request. Ask for replacement credentials through secure input
   if needed; do not reuse exposed keys.
3. Use `--dry-run` for the intended command to validate configuration and local
   inputs without a paid call. API_KEY and API_BASE_URL are configured through
   process environment or a private `.env`; see README for precedence.
4. Verify the provider's protocol when changing video models. A catalog entry
   does not prove I2V support. Unknown models fail before upload unless an
   adapter is explicitly selected. Do not trial many paid models automatically.
5. Tell the user when a proposed workflow adds paid calls, local image uploads,
   or an approximate fallback. Obtain scope for large batches. Use this helper
   when the user specifically requests this skill/API workflow; honor higher
   priority tool-selection instructions for ordinary image requests.

## Commands

```sh
node asset-gen.mjs image "top-down pixel art slime, transparent background" "outputs/slime.png"
node asset-gen.mjs image-edit "Keep the silhouette; recolor icy blue" --input "source.png" --output "outputs/blue.png"
node asset-gen.mjs image-text "Describe the palette and silhouette" --input "source.png" --output "outputs/analysis.txt"
node asset-gen.mjs video "A gentle camera orbit around a fantasy island" "outputs/island.mp4" --seconds 8
node asset-gen.mjs image-video "Hair and ribbons move in the breeze" --input "source.png" --output "outputs/animation.mp4" --seconds 8
node asset-gen.mjs speech "Welcome, traveler." "outputs/voice.wav" --voice shimmer
node asset-gen.mjs music "A calm instrumental fantasy theme" "outputs/theme.mp3"
```

Common flags: `--model ID`, `--env-file PATH`, `--prompt-file PATH`, `--json`,
`--dry-run`, `--timeout-ms 120000`. With `--prompt-file`, omit positional prompt.
Every generation/analysis mode honors `--model`. Legacy positional image size,
music `true|false`, speech voice/speed remain supported.

Read [references/protocols.md](references/protocols.md) for image-input modes,
video adapters, polling and composed workflows before using them. See
[README.md](README.md) for installation, all flags and migration notes.

## Async tasks and recovery

For video or Suno, `--submit-only --json` saves `<output>.task.json` as soon as
the server supplies an ID. Resume using the **same private configuration**:

```sh
node asset-gen.mjs resume "outputs/animation.mp4.task.json" --json
```

Without `--submit-only`, polling runs automatically with a 10-minute default
deadline. A queued/submitted status is not a completed media file. On timeout or
download failure, use the saved manifest. A submit timeout without an ID is
ambiguous: check the provider dashboard before considering another submission.
The CLI never retries generation POSTs; GET requests retry transient failures.
Do not run concurrent jobs targeting the same output or manifest path.

## Fallbacks require an explicit choice

- Suno unavailable: `music ... output.wav --fallback local` permits procedural
  **instrumental** BGM after HTTP 403/404/429. This is local synthesis, not Suno
  or another AI music model. Never substitute it for vocals.
- Speech unavailable: `speech ... output.wav --fallback qwen` permits a second
  paid request through Qwen Omni after HTTP 403/404/429. Its semantic speech may
  change wording: inspect transcription before accepting exact dialogue.
- Default is no fallback. HTTP 5xx or network ambiguity is not permission to
  start a second generation. Report the failure and remaining recovery path.

## Verification and reporting

The CLI checks signatures/container markers, nonempty data, output extension,
size limits and exclusive creation. It does **not** fully decode images/audio/
video. After generation, inspect images, decode/play audio/video with available
tools, and verify duration/dimensions/content against the brief. Do not label a
file with a mismatched extension as success or claim provider recovery from
offline test results.

Return output paths, selected model, whether a fallback was used, and any
unfinished/failed modes. `--json` includes provenance, byte count, SHA-256 and
validation scope. Local procedural music and semantic speech must be identified
as such. Never publish `.env`, credentials, private task manifests or raw
provider responses. Keep user media outside the skill source repository.
