# 小塔 · QQ 机器人（NapCat + DeepSeek）

一个自用的 QQ 聊天机器人，核心目标：**像人一样聊天**，而不是"AI 助手"。

## 功能

- 人格化聊天（可自定义人设提示词）
- 多气泡回复 / 打字延迟 / 出错撤回
- 表情包：自动分类、按情绪发送、自动收藏对方发的图
- 视觉识图（GLM-4V）
- 语音合成（CosyVoice2 克隆音色）
- 长期记忆：档案 / 日记 / 摘要压缩 / 待聊提醒
- 主动消息（空闲触发、每日上限、免打扰时段）
- 联网搜索、画图、QQ 空间说说、换头像
- 手机控制（adb 白名单动作）
- 可选 WPF 控制面板

## 架构

```
QQ → NapCat (OneBot 11, WS :3000) → bot.mjs
                                     ├─ DeepSeek Chat API（对话）
                                     ├─ GLM-4V（识图）
                                     ├─ CosyVoice2（TTS，:8808）
                                     └─ 本地文件：memory/ 日记/ stickers/
```

## 快速开始

1. 安装 [NapCat](https://github.com/NapNeko/NapCatQQ)，配置 OneBot 11 反连/正向 WS 到 `ws://127.0.0.1:3000`
2. `npm i` 不需要（零依赖，Node 18+）
3. 复制 `config.example.json` 为 `config.json`，填入：
   - `deepseek.apiKey`（DeepSeek 开放平台）
   - `vision.apiKey`（智谱 GLM，可选）
   - `napcat.selfId`（机器人 QQ 号）
   - `reply.privateWhitelist`（允许私聊的 QQ）
   - `proactive.targets`（主动消息对象）
4. `node bot.mjs`

## 目录

| 文件 | 作用 |
|---|---|
| `bot.mjs` | 主程序：消息处理、人格、记忆、多气泡、主动消息 |
| `store.mjs` | 实体库：档案/事件/待聊/日记 |
| `tools.mjs` | 工具：电脑状态、配置读取、提醒 |
| `phone.mjs` | 手机控制（adb 白名单） |
| `tts/server.py` | CosyVoice2 TTS 服务 |

## 注意

- `config.json`、`memory/`、`日记/`、`bot.log`、`stickers/` 都不应提交（见 `.gitignore`）
- 表情包和音色模型涉及版权，请自备
- 仅供个人学习交流，请遵守 QQ 平台规则

## License

MIT
