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

---

## 使用许可

本项目采用 **MIT License**（见 [LICENSE](LICENSE)），可自由使用、修改、分发，但需保留版权声明。

## 免责声明

- 本项目仅供**个人学习与技术交流**，不构成任何形式的产品或服务承诺。
- 使用者应自行遵守 **QQ 平台规则、NapCat 项目条款、DeepSeek / 智谱等 API 服务条款**。因使用本项目导致的账号限流、封禁、验证或任何平台处罚，作者不承担责任。
- 本项目会读取并处理聊天内容、生成拟人化回复；请勿用于**骚扰、诈骗、批量营销、冒充他人、违法违规**等场景。
- 模型输出的内容由第三方大模型生成，**不代表作者立场**；使用者应对机器人产生的言论负责。
- 语音克隆、表情包、立绘等素材可能涉及第三方版权，仓库不包含这些素材，请自行确保合法来源。
- 项目按「现状」提供，不保证功能完整、稳定或适用于任何特定用途；使用风险由使用者自行承担。
- 如用于公开群聊或他人可交互的场景，请提前告知参与者机器人身份，并做好内容审核。

## 致谢

- [NapCat](https://github.com/NapNeko/NapCatQQ) —— QQ 协议实现
- DeepSeek / 智谱 GLM / CosyVoice2 —— 对话、识图与语音能力
