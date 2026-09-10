# game-creator 2.0.0

保留原名的游戏多媒体 Skill：文生图、图生图、图片理解、文生视频、图生视频、语音、BGM。
Node.js 22+，无第三方运行时依赖。支持 Windows、macOS、Linux。

## 安装

把本仓库内容放进 Codex 的 `skills/game-creator/` 目录，例如 Windows 的
`%USERPROFILE%/.codex/skills/game-creator/`。已有版本请先备份代码，保留自己的 `.env`，
不要把配置文件加入 Git。重新开启一个任务，让客户端重新读取更新后的 Skill。

从该目录执行：

```sh
node asset-gen.mjs --help
node asset-gen.mjs doctor
npm test
```

将 `.env.example` 复制为私有 `.env`，在本地安全编辑器中填写 API_KEY 和 API_BASE_URL。
**不要在聊天、截图或命令参数里粘贴密钥。** 已暴露的密钥应先撤销并更换。

配置优先级：进程环境变量 > 选中的配置文件。文件选择：`--env-file` >
`GAME_CREATOR_ENV_FILE` > 当前工作目录 `.env` > Skill 目录 `.env`。明确指定但不存在的
文件会报错，不会悄悄回退。支持引号、`export`、BOM、行尾注释；不执行变量插值或命令。
API_BASE_URL 接受网关根地址或以 `/v1` 结尾的地址，禁止嵌入用户名、密码、查询参数。

## 使用

```sh
node asset-gen.mjs image "pixel art fantasy character" "outputs/character.png" --dry-run
node asset-gen.mjs image "pixel art fantasy character" "outputs/character.png" --json
node asset-gen.mjs image-edit "Keep identity, add a blue cape" --input "outputs/character.png" --output "outputs/cape.png" --model gpt-image-2
node asset-gen.mjs image-edit "Keep identity, change background" --input "source.png" --output "outputs/edit.png" --adapter openai-edits
node asset-gen.mjs image-text "Describe the character" --input "source.png"
node asset-gen.mjs video "A fantasy island at sunrise" "outputs/clip.mp4" --seconds 8 --submit-only --json
node asset-gen.mjs resume "outputs/clip.mp4.task.json" --json
node asset-gen.mjs image-video "Gently wave, fixed camera" --input "source.png" --output "outputs/motion.mp4" --seconds 8
node asset-gen.mjs speech "欢迎来到新的旅程。" "outputs/voice.wav" --voice shimmer
node asset-gen.mjs music "gentle fantasy instrumental theme" "outputs/bgm.mp3"
```

其他目录调用时，把 `asset-gen.mjs` 换成已安装脚本的绝对路径。输出相对路径以当前工作目录
为准。例子中的默认模型来自旧版配置兼容，不保证你的平台当前提供这些模型。

| 参数 | 用途 |
|---|---|
| `--model ID` | 所有生成/分析命令的一次性模型覆盖 |
| `--prompt-file PATH` | UTF-8 提示词文件，省略位置提示词 |
| `--env-file PATH` | 明确指定私有配置 |
| `--dry-run` | 校验并打印计划，不联网、不生成 |
| `--json` | 输出结构化结果，包含模型、来源、文件元信息 |
| `--input PATH` / `--output PATH` | 图像输入与输出路径；image-edit/vision 最多 4 张 |
| `--adapter gateway-json/openai-edits` | 图生图协议，默认 gateway-json |
| `--adapter seedance/openai-video` | 视频协议，未知模型必须明确指定 |
| `--size WxH` | 图片/OpenAI 视频尺寸；实际支持范围由模型决定 |
| `--seconds N` / `--ratio R` / `--resolution R` / `--role R` | 视频参数，详见协议参考 |
| `--voice NAME` / `--speed N` | 语音，速度 0.25–4 |
| `--instrumental true/false` | Suno 是否纯器乐 |
| `--timeout-ms N` | 单个 HTTP 操作含重试/响应体预算，默认 120000 |
| `--poll-ms N` / `--poll-timeout-ms N` | 轮询间隔与总预算，默认 10000 / 600000 |
| `--submit-only` | 保存异步任务后立即返回；用 resume 继续 |
| `--fallback none/local/qwen` | 默认 none；local 仅音乐、qwen 仅语音，均需要 WAV |

旧版位置参数仍兼容：image 的尺寸、music 的 `true/false`、speech 的 voice/speed。
完整约束见 [SKILL.md](SKILL.md) 和 [协议说明](references/protocols.md)。

## 本次修复 / 迁移注意

- 修复带引号配置、环境变量失效与重复 `/v1/v1`。
- 图生图 `--model` 不再被忽略，增加标准 multipart edits 选项。
- 不再把所有非 Seedance 模型都当成 OpenAI 视频协议。
- 输出先校验、不覆盖已有文件；拒绝 HTML/假图片和扩展名不符的媒体。
- HTTP 包括响应体的超时、大小限制、错误脱敏；下载不带 API 密钥。
- 异步任务落盘，可恢复查询和下载；生成 POST 不自动重试。
- 修复 Qwen Base64 分段音频截断；流内错误不再接受部分音频为成功。
- **降级改为显式选择**。本地 BGM 不是 Suno 生成；不能代替人声歌曲。
  Qwen 是额外付费的语义语音，可能改词。服务端 5xx/网络不明状态不会触发第二次生成。
- 不支持覆盖写入、自动格式转换、并发写同一路径、蒙版编辑、任意上游原生视频协议。

`doctor` 不验证余额、授权或模型在线状态。自动测试使用 localhost 模拟服务，不读取真实
密钥，不发付费请求。通过测试只能证明本地实现行为；生产通道需在获得测试预算后逐项验证。
文件容器标记校验不等于完整解码：交付素材前仍应检查尺寸、时长、画面及声音内容。

## 安全与来源

仓库不包含用户 `.env`、真实密钥、BH Test 素材或历史私有日志。不要上传它们。
测试中的凭证只是假字符串；模拟媒体只用于协议测试，不是质量验收素材。
不自动重定向 API 请求，也不向媒体 URL 转发 API 密钥；签名链接仍应视为私有资料。

本版本基于原有 game-creator 改进。设计参考
[my-image](https://github.com/less55093-collab/my-image) 的配置检查、媒体验证和 CLI 回归测试思路，
**未复制其实现代码**。该参考仓库未提供开放源码许可证，不能据此推定可复制分发。
本仓库暂未指定开放源码许可证；GitHub 托管不代表自动授予开源许可。
