// C:\QQBot\bot.mjs —— NapCat (OneBot 11) + DeepSeek 聊天机器人
// 特性：人设对话 / 括号体动作 / 主动发表情包 / 多气泡连发 / 私聊白名单 / 余额告警
// 零依赖：只用 Node 内置 https / 全局 WebSocket（Node 22+）

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import crypto from "node:crypto";
import { createStore } from "./store.mjs";
import { createTools } from "./tools.mjs";
import { createPhone } from "./phone.mjs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------- 运行时开关（面板可实时切换，无需重启） ----------------
const store = createStore(HERE);
const tools = createTools(HERE);
const phone = createPhone(() => cfg, () => runtimeState().phone !== false && cfg.phone?.enable !== false);

const STATE_PATH = path.join(HERE, "state.json");
let stateCache = { mtime: 0, data: { enable: true, proactive: true, voice: true, search: true } };
function runtimeState() {
  try {
    const st = fs.statSync(STATE_PATH);
    if (st.mtimeMs !== stateCache.mtime) {
      const raw = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
      stateCache = { mtime: st.mtimeMs, data: { ...stateCache.data, ...raw } };
    }
  } catch {}
  return stateCache.data;
}

// ---------------- 配置 ----------------
const cfg = JSON.parse(fs.readFileSync(path.join(HERE, "config.json"), "utf8"));
const API_KEY = process.env.DEEPSEEK_API_KEY || cfg.deepseek.apiKey;
if (!API_KEY || !API_KEY.startsWith("sk-")) {
  console.error("缺少 DeepSeek API Key");
  process.exit(1);
}

// ---------------- 单实例保护 ----------------
const pidFile = path.join(HERE, "bot.pid");
try {
  if (fs.existsSync(pidFile)) {
    const old = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
    if (old && old !== process.pid) {
      try { process.kill(old, 0); console.error(`已有实例运行 (PID ${old})，退出`); process.exit(0); } catch {}
    }
  }
} catch {}
try { fs.writeFileSync(pidFile, String(process.pid)); } catch {}

const logFile = path.join(HERE, "bot.log");
// 连续同类日志抑制（避免断线时刷屏）
const _throttle = new Map();
function logThrottled(key, msg, everyMs = 60000) {
  const now = Date.now();
  const last = _throttle.get(key) || 0;
  if (now - last < everyMs) return;
  _throttle.set(key, now);
  log(msg);
}

function log(...args) {
  const line = `[${new Date().toISOString()}] ` + args.map(String).join(" ");
  console.log(line);
  try { fs.appendFileSync(logFile, line + "\n"); } catch {}
}

// ---------------- 报警器 ----------------
const errStats = new Map();
const FALLBACK_LINE =
  "唔……我好像没力气了，是不是口粮（余额）用完了呀？去面板看看嘛，充上我就能继续陪你。";

function classifyErr(msg) {
  const s = String(msg || "");
  if (/402|insufficient|balance|quota|余额/i.test(s)) return "余额不足";
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket|timeout|网络/i.test(s)) return "网络异常";
  if (/400|401|403|404/i.test(s)) return "接口错误";
  return "其他错误";
}

/** 记录一次错误；同类连续 3 次 → 主动发 QQ 告警 */
function reportError(scope, e) {
  const raw = String(e?.message || e || "未知");
  const type = classifyErr(raw);
  const s = errStats.get(type) || { count: 0, alertedAt: 0 };
  s.count++;
  s.lastMsg = raw;
  errStats.set(type, s);
  log(`⚠️ [${scope}] ${type}: ${raw.slice(0, 120)}`);
  if (s.count >= 3 && Date.now() - (s.alertedAt || 0) > 30 * 60000) {
    s.alertedAt = Date.now();
    s.count = 0;
    const admin = (cfg.reply?.privateWhitelist || [])[0];
    if (admin) {
      callApi("send_private_msg", {
        user_id: admin,
        message:
          `🔧 小塔报警：${type} 连续 3 次\n` +
          `最近一次：${raw.slice(0, 100)}\n` +
          `时间：${nowText()}\n` +
          `（同类报错 30 分钟内只提醒一次）`,
      }).catch(() => {});
      log(`🔧 已发送报警：${type}`);
    }
  }
}

/** 启动时轮转日志：超过 2MB 就改名，只保留 3 份 */
function rotateLog() {
  try {
    if (!fs.existsSync(logFile)) return;
    const size = fs.statSync(logFile).size;
    if (size < 2 * 1024 * 1024) return;
    for (let i = 3; i >= 1; i--) {
      const from = i === 1 ? logFile : logFile + "." + (i - 1);
      const to = logFile + "." + i;
      if (fs.existsSync(from)) {
        if (fs.existsSync(to)) fs.unlinkSync(to);
        fs.renameSync(from, to);
      }
    }
    fs.writeFileSync(logFile, "");
  } catch {}
}

// ---------------- 表情包 ----------------
const STICKER_DIR = path.join(HERE, "stickers");
const stickerMap = new Map(); // emotion -> [file paths]

function loadStickers() {
  stickerMap.clear();
  if (!fs.existsSync(STICKER_DIR)) return;
  for (const d of fs.readdirSync(STICKER_DIR, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    if (d.name.startsWith("_")) continue; // 跳过 _trash / _inbox 等内部目录
    const dirPath = path.join(STICKER_DIR, d.name);
    const files = fs
      .readdirSync(dirPath)
      .filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f))
      .map((f) => path.join(dirPath, f));
    if (files.length) stickerMap.set(d.name.toLowerCase(), files);
  }
}

// 某一类没有图时，按这个顺序找替代，避免发错或不发
const STICKER_FALLBACK = {
  shy: ["happy", "smug"],
  sad: ["speechless", "confused"],
  speechless: ["confused", "sad"],
  smug: ["happy", "confused"],
  happy: ["smug", "confused"],
  angry: ["smug", "confused"],
  confused: ["speechless", "smug"],
};

function pickSticker(emotion) {
  const key = (emotion || "").toLowerCase();
  let list = stickerMap.get(key);
  if (!list || !list.length) {
    for (const alt of STICKER_FALLBACK[key] || []) {
      list = stickerMap.get(alt);
      if (list && list.length) break;
    }
  }
  if (!list || !list.length) {
    const all = [...stickerMap.values()].filter((a) => a.length);
    if (!all.length) return null;
    list = all[Math.floor(Math.random() * all.length)];
  }
  return list[Math.floor(Math.random() * list.length)];
}

// ---------------- DeepSeek ----------------
function deepseekRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = { Authorization: "Bearer " + API_KEY, Accept: "application/json" };
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    const req = https.request({ hostname: "api.deepseek.com", path: apiPath, method, headers }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`DeepSeek HTTP ${res.statusCode}: ${d.slice(0, 300)}`));
        try { resolve(JSON.parse(d)); } catch { reject(new Error("解析失败: " + d.slice(0, 200))); }
      });
    });
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("DeepSeek 超时")); });
    if (payload) req.write(payload);
    req.end();
  });
}

async function askDeepSeek(messages) {
  const j = await deepseekRequest("POST", "/chat/completions", {
    model: cfg.deepseek.model,
    messages,
    temperature: cfg.deepseek.temperature,
    max_tokens: cfg.deepseek.maxTokens,
  });
  return (j.choices?.[0]?.message?.content || "").trim();
}

async function getBalance() {
  const j = await deepseekRequest("GET", "/user/balance");
  const cny = (j.balance_infos || []).find((b) => b.currency === "CNY") || (j.balance_infos || [])[0];
  if (!cny) return null;
  return {
    available: j.is_available,
    total: parseFloat(cny.total_balance),
    currency: cny.currency,
  };
}

// ---------------- 视觉识别（GLM-4V-Flash） ----------------
function httpsJson(method, hostname, pathStr, headers, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const h = { ...headers };
    if (payload) {
      h["Content-Type"] = "application/json";
      h["Content-Length"] = Buffer.byteLength(payload);
    }
    const req = https.request({ hostname, path: pathStr, method, headers: h }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${d.slice(0, 300)}`));
        try { resolve(JSON.parse(d)); } catch { reject(new Error("解析失败: " + d.slice(0, 200))); }
      });
    });
    req.on("error", reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error("请求超时")); });
    if (payload) req.write(payload);
    req.end();
  });
}

const visionCache = new Map();

/** 下载图片为 Buffer */
function fetchBuffer(url, depth = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && depth < 5) {
        res.resume();
        return resolve(fetchBuffer(new URL(res.headers.location, url).toString(), depth + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error("http " + res.statusCode)); }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject);
  });
}

/** 调一次 GLM 视觉模型，返回描述文本 */
async function callGlmVision(imageRef, v) {
  const j = await httpsJson(
    "POST",
    "open.bigmodel.cn",
    "/api/paas/v4/chat/completions",
    { Authorization: "Bearer " + v.apiKey },
    {
      model: v.model || "glm-4v-flash",
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: imageRef } },
            {
              type: "text",
              text:
                v.prompt ||
                "这是一张聊天里发的图片/表情包。请用一句中文客观描述：画面主体是什么 + 图上文字（原样引用，没有就说无）+ 表达的情绪或梗。不要评论，40字以内。",
            },
          ],
        },
      ],
    },
  );
  let out = j.choices?.[0]?.message?.content;
  if (Array.isArray(out)) out = out.map((p) => p.text || "").join("");
  return String(out || "").trim().replace(/\s+/g, " ");
}

/** 根据文件头判断真实图片格式 */
function imageKind(buf) {
  if (!buf || buf.length < 12) return "unknown";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
  if (buf[0] === 0x89 && buf[1] === 0x50) return "png";
  if (buf[0] === 0x47 && buf[1] === 0x49) return "gif";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  return "unknown";
}

/** GIF/WebP 取第一帧转 PNG（GLM-4V 不认 GIF/WebP） */
function toPngBuffer(buf, kind) {
  return new Promise((resolve, reject) => {
    const ff = cfg.vision?.ffmpegPath;
    if (!ff || !fs.existsSync(ff)) return reject(new Error("缺少 ffmpeg: " + ff));
    const dir = path.join(HERE, "_vision");
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    const stamp = Date.now() + "_" + Math.floor(Math.random() * 100000);
    const inp = path.join(dir, `i_${stamp}.${kind}`);
    const outp = path.join(dir, `o_${stamp}.png`);
    try { fs.writeFileSync(inp, buf); } catch (e) { return reject(e); }
    execFile(ff, ["-y", "-i", inp, "-frames:v", "1", outp], { timeout: 20000, windowsHide: true }, (err) => {
      try { fs.unlinkSync(inp); } catch {}
      if (err) return reject(new Error("ffmpeg 转码失败"));
      try {
        const b = fs.readFileSync(outp);
        fs.unlinkSync(outp);
        resolve(b);
      } catch (e) { reject(e); }
    });
  });
}

async function describeImage(imgSeg) {
  const v = cfg.vision || {};
  if (!v.enable || !v.apiKey) return null;

  let ref = null;
  for (const cand of [imgSeg.url, imgSeg.file]) {
    if (typeof cand === "string" && /^https?:\/\//.test(cand)) { ref = cand; break; }
  }
  if (!ref) {
    log("⚠️ 图片没有可访问 URL，跳过识别");
    return null;
  }

  if (visionCache.has(ref)) return visionCache.get(ref);

  let out = null;
  let lastErr = "";

  // 方案 1：直接把 QQ 图片链接交给模型
  try {
    out = await callGlmVision(ref, v);
  } catch (e) {
    lastErr = e.message;
    log(`⚠️ 直链识图失败，改为下载后重试: ${e.message}`);
  }

  // 方案 2：下载到本地，必要时转码，再送 base64
  if (!out) {
    try {
      const buf = await fetchBuffer(ref);
      if (buf && buf.length > 0) {
        if (buf.length > 8 * 1024 * 1024) throw new Error("图片过大 " + Math.round(buf.length / 1024) + "KB");
        const kind = imageKind(buf);
        let sendBuf = buf;
        if (kind === "gif" || kind === "webp") {
          try {
            sendBuf = await toPngBuffer(buf, kind);
            log(`🔄 已转码 ${kind} → png (${Math.round(buf.length / 1024)}KB → ${Math.round(sendBuf.length / 1024)}KB)`);
          } catch (e) {
            log(`⚠️ 转码失败，按原格式尝试: ${e.message}`);
          }
        }
        out = await callGlmVision(sendBuf.toString("base64"), v);
      }
    } catch (e) {
      lastErr = e.message;
      log(`⚠️ 下载识图失败: ${e.message}`);
    }
  }

  if (!out) {
    log(`⚠️ 识图最终失败: ${lastErr}`);
    return null;
  }

  visionCache.set(ref, out);
  if (visionCache.size > 200) visionCache.delete(visionCache.keys().next().value);
  log(`👁️ 识图结果: ${out}`);
  return out;
}

// ---------------- 自动收藏表情包 ----------------
const STICKER_CATS = ["happy", "angry", "shy", "confused", "sad", "smug", "speechless"];
const collectedHashes = new Set();

function loadCollectedHashes() {
  try {
    for (const cat of [...STICKER_CATS, "_inbox"]) {
      const dir = path.join(STICKER_DIR, cat);
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        const m = f.match(/^auto_([0-9a-f]{16})/);
        if (m) collectedHashes.add(m[1]);
      }
    }
  } catch {}
}

/** 用 ffprobe 读图片尺寸（拿不到就返回 null） */
function probeSize(filePath) {
  return new Promise((resolve) => {
    const ff = cfg.vision?.ffmpegPath || "ffprobe";
    const ffprobe = ff.replace(/ffmpeg(\.exe)?$/i, (m) => m.replace(/ffmpeg/i, "ffprobe"));
    execFile(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
      "-of", "csv=p=0", filePath], { timeout: 8000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const m = String(stdout).trim().match(/(\d+)\D+(\d+)/);
      if (!m) return resolve(null);
      resolve({ w: Number(m[1]), h: Number(m[2]) });
    });
  });
}

async function classifyStickerEmotion(filePath) {
  try {
    // 先按尺寸粗筛：手机竖屏截图（很高很窄）或超宽大图，直接跳过
    const size = await probeSize(filePath);
    if (size && size.w && size.h) {
      const ratio = size.h / size.w;
      if (ratio > 1.5 && size.w < 1200) {
        log(`⏭️ 尺寸像手机截图(${size.w}x${size.h})，不收藏`);
        return "SKIP";
      }
      if (size.w > 1500 || size.h > 1500) {
        log(`⏭️ 图片过大(${size.w}x${size.h})，不像表情包，不收藏`);
        return "SKIP";
      }
    }

    const buf = fs.readFileSync(filePath);
    const v = { ...(cfg.vision || {}) };
    v.prompt =
      "判断这张图能不能当聊天表情包用。严格按下面规则：\n" +
      "【不是表情包，输出 SKIP】\n" +
      "- 手机/电脑截图、聊天记录、网页、报错信息、代码、文档\n" +
      "- 实拍照片：人像、自拍、桌面、房间、风景、宠物照\n" +
      "- 纯色背景配大段文字的通知、广告\n" +
      "【是表情包，输出情绪词】\n" +
      "- 有明确夸张表情或配了一句吐槽/梗文字的图\n" +
      "只输出一个词，不要解释：SKIP 或 happy/angry/shy/confused/sad/smug/speechless";
    const out = await callGlmVision(buf.toString("base64"), v);
    const raw = String(out || "").toLowerCase();
    if (/skip|none|不是表情包|照片|截图|界面|文档/.test(raw)) return "SKIP";
    const word = raw.replace(/[^a-z]/g, "");
    return STICKER_CATS.includes(word) ? word : null;
  } catch {
    return null;
  }
}

async function collectSticker(imgSeg, desc) {
  const ref = imgSeg?.url || imgSeg?.file;
  if (typeof ref !== "string" || !/^https?:\/\//.test(ref)) return null;
  const buf = await fetchBuffer(ref);
  if (!buf || buf.length < 1024) return null;

  const hash = crypto.createHash("sha1").update(buf).digest("hex").slice(0, 16);
  if (collectedHashes.has(hash)) return null;
  collectedHashes.add(hash);

  const kind = imageKind(buf);
  const ext = kind === "unknown" ? "png" : kind;
  const name = `auto_${hash}.${ext}`;
  const inbox = path.join(STICKER_DIR, "_inbox");
  fs.mkdirSync(inbox, { recursive: true });
  const tmpPath = path.join(inbox, name);
  fs.writeFileSync(tmpPath, buf);

  const cat = await classifyStickerEmotion(tmpPath);
  if (cat === "SKIP") {
    try { fs.unlinkSync(tmpPath); } catch {}
    collectedHashes.delete(hash);
    return null;
  }
  if (cat) {
    const dest = path.join(STICKER_DIR, cat, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(tmpPath, dest);
    if (!stickerMap.has(cat)) stickerMap.set(cat, []);
    stickerMap.get(cat).push(dest);
    log(`🎁 收藏表情包 → ${cat}  ${Math.round(buf.length / 1024)}KB  ${(desc || "").slice(0, 30)}`);
    return dest;
  }
  log(`🎁 收藏表情包 → _inbox（情绪没判断出来）  ${Math.round(buf.length / 1024)}KB`);
  return null;
}

// ---------------- QQ 空间 / 画图 / 头像 / 语音识别 ----------------
async function transcribeVoice(messageId) {
  try {
    const r = await callApi("fetch_ptt_text", { message_id: messageId });
    const t = r?.data?.text;
    return t ? String(t).trim() : null;
  } catch (e) {
    log("⚠️ 语音转文字失败: " + e.message);
    return null;
  }
}

async function sendQzone(content, ugcRight = 1) {
  const r = await callApi("send_qzone_msg", { content: String(content).slice(0, 1000), ugcRight });
  log(`📝 发说说 → ${r?.status ?? "失败"} ${r?.message || ""}`);
  return r;
}

async function generateImage(prompt) {
  const k = cfg.vision?.apiKey;
  if (!k) throw new Error("缺少智谱 Key");
  const j = await httpsJson(
    "POST", "open.bigmodel.cn", "/api/paas/v4/images/generations",
    { Authorization: "Bearer " + k },
    { model: cfg.image?.model || "cogview-3-flash", prompt: String(prompt).slice(0, 500), size: cfg.image?.size || "1024x1024" },
  );
  const url = j.data?.[0]?.url;
  if (!url) throw new Error("没拿到图片 URL");
  const buf = await fetchBuffer(url);
  if (!buf || !buf.length) throw new Error("下载图片失败");
  const dir = path.join(HERE, "_img");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `img_${Date.now()}.png`);
  fs.writeFileSync(file, buf);
  log(`🎨 画图完成 ${Math.round(buf.length / 1024)}KB`);
  return file;
}

async function setQqAvatar(file) {
  const b64 = fs.readFileSync(file).toString("base64");
  const r = await callApi("set_qq_avatar", { file: "base64://" + b64 });
  log(`🖼️ 换头像 → ${r?.status ?? "失败"}`);
  return r;
}

// ---------------- 联网搜索（智谱 web_search，glm-4-flash 免费） ----------------
async function webSearch(query) {
  const s = cfg.search || {};
  if (s.enable === false) return null;
  if (runtimeState().search === false) return null;
  const key = cfg.vision?.apiKey;
  if (!key) return null;
  try {
    const j = await httpsJson(
      "POST",
      "open.bigmodel.cn",
      "/api/paas/v4/chat/completions",
      { Authorization: "Bearer " + key },
      {
        model: s.model || "glm-4-flash",
        messages: [{ role: "user", content: query }],
        tools: [{ type: "web_search", web_search: { enable: true } }],
      },
    );
    let out = j.choices?.[0]?.message?.content;
    if (Array.isArray(out)) out = out.map((p) => p.text || "").join("");
    return String(out || "").trim() || null;
  } catch (e) {
    log("⚠️ 联网搜索失败: " + e.message);
    return null;
  }
}

// ---------------- 日记 ----------------
const DIARY_DIR = path.join(HERE, "日记");
const DIARY_FILE = path.join(DIARY_DIR, "小塔日记.md");

function diaryStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function appendDiary(text, d = new Date()) {
  try {
    fs.mkdirSync(DIARY_DIR, { recursive: true });
    const head = fs.existsSync(DIARY_FILE) ? "" : "# 小塔日记\n\n";
    fs.appendFileSync(DIARY_FILE, `${head}## ${diaryStamp(d)}\n${String(text).trim()}\n\n`, "utf8");
    log(`📔 写入日记：${String(text).slice(0, 30)}`);
    return true;
  } catch (e) {
    log("⚠️ 写日记失败: " + e.message);
    return false;
  }
}

let diaryRetryAt = 0;
let diaryAttempts = 0;
let diaryLastTry = 0;

function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 文件里是否已有这一天的日记（重启也不会重复写） */
function diaryHasDay(day) {
  try {
    return fs.readFileSync(DIARY_FILE, "utf8").includes(`## ${day}`);
  } catch {
    return false;
  }
}

/** 统计某天机器人跟 NapCat 断开的次数（从日志里数） */
function dayDisconnects(day) {
  try {
    const txt = fs.readFileSync(logFile, "utf8");
    const re = new RegExp(`^\\[${day}T[^\\]]*\\].*(与 NapCat 断开|WS 错误)`, "gm");
    const n = (txt.match(re) || []).length;
    return n;
  } catch { return 0; }
}

async function maybeWriteDiary() {
  const now = new Date();
  const h = now.getHours();

  // 23 点后写当天；次日 0-8 点补写前一天（补漏）
  let targetDate;
  if (h >= 23) targetDate = now;
  else if (h < 8) targetDate = new Date(now.getTime() - 86400000);
  else return;

  const day = dayKey(targetDate);
  if (diaryHasDay(day)) return;                     // 文件里已有，跳过
  if (Date.now() < diaryRetryAt) return;            // 退避中
  if (Date.now() - diaryLastTry < 60000) return;    // 每分钟最多试一次
  diaryLastTry = Date.now();

  const target = (cfg.reply?.privateWhitelist || [])[0];
  if (!target) return;
  const key = `p:${target}`;
  const all = sessions.get(key) || [];

  // 优先取"那一天"的对话；这天没聊也照写（写"安静的一天"）
  const dayMsgs = all.filter((m) => m.t && dayKey(new Date(m.t)) === day);
  const sparse = dayMsgs.length < 2;
  const hist = sparse ? all.slice(-12) : dayMsgs;

  try {
    const dc = dayDisconnects(day);
    const body = hist.map((x) => (x.role === "user" ? "对方：" : "我：") + stripTimeTag(x.content)).join("\n");
    const summary = summaries.get(key) || "";
    const text = await askDeepSeek([
      { role: "system", content: cfg.persona.systemPrompt + "\n\n你要写这一天（" + day + "）的日记。只写日记正文。" },
      {
        role: "user",
        content:
          (summary ? `【更早的摘要】\n${summary}\n\n` : "") +
          `【${day} 的对话】\n${sparse ? "（这一天他几乎没来找我）" : body}\n\n` +
          (sparse
            ? `今天几乎没怎么说话。请写一篇 100~150 字的日记，写你一个人待着的心情——守着屏幕、等消息、自己找点事做。` +
              `不要编造任何具体事件（他没说过的事不要写）。` +
              (dc > 0 ? `今天断线了 ${dc} 次，可以顺口提一句"网不太稳"。` : "")
            : `请写一篇 100~200 字的日记，第一人称，用你自己的口吻，写这一天真实的感受和具体细节。`) +
          `不要列点、不要标题、不要写成报告。`,
      },
    ]);
    if (!text) throw new Error("模型返回空");
    appendDiary(text.trim(), targetDate);
    diaryAttempts = 0;
    diaryRetryAt = 0;
  } catch (e) {
    diaryAttempts++;
    diaryRetryAt = Date.now() + 5 * 60000;
    if (diaryAttempts >= 6) {
      log(`⚠️ ${day} 日记失败（已试 ${diaryAttempts} 次，等下次补写）: ${e.message}`);
      diaryAttempts = 0;
    } else {
      log(`⚠️ ${day} 日记失败（第 ${diaryAttempts} 次，5 分钟后重试）: ${e.message}`);
    }
  }
}
// ---------------- 会话记忆 ----------------
const sessions = new Map();
const summaries = new Map(); // key -> 历史摘要
let lastActivity = Date.now(); // 最后一次收到消息的时间，用于主动消息判断
const sessionKey = (ev) =>
  ev.message_type === "group" ? `g:${ev.group_id}:${ev.user_id}` : `p:${ev.user_id}`;

// 落盘记忆：C:\QQBot\memory\*.json，重启不丢
const MEM_DIR = path.join(HERE, "memory");
const memFile = (key) => path.join(MEM_DIR, key.replace(/[:/\\]/g, "_") + ".json");

function loadSessions() {
  if (cfg.memory?.persist === false) return 0;
  try { fs.mkdirSync(MEM_DIR, { recursive: true }); } catch {}
  let n = 0;
  try {
    for (const f of fs.readdirSync(MEM_DIR)) {
      if (!f.endsWith(".json")) continue;
      try {
        let j = null;
        try { j = JSON.parse(fs.readFileSync(path.join(MEM_DIR, f), "utf8")); }
        catch {
          try { j = JSON.parse(fs.readFileSync(path.join(MEM_DIR, f) + ".bak", "utf8")); log(`♻️ ${f} 损坏，已从 .bak 恢复`); } catch {}
        }
        if (j && j.key && Array.isArray(j.hist)) {
          // 迁移：清掉历史里累积的时间戳
          const cleaned = j.hist.map((m) => ({
            role: m.role,
            content: stripTimeTag(String(m.content || "")),
            t: m.t,
          }));
          sessions.set(j.key, cleaned);
          if (j.summary) summaries.set(j.key, j.summary);
          n++;
        }
      } catch {}
    }
  } catch {}
  return n;
}

function saveSession(key) {
  if (cfg.memory?.persist === false) return;
  try {
    fs.mkdirSync(MEM_DIR, { recursive: true });
    const hist = sessions.get(key) || [];
    const summary = summaries.get(key) || "";
    // 原子写 + 保留上一版
    const f = memFile(key);
    const tmp = f + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ key, summary, hist, updated: Date.now() }), "utf8");
    try { if (fs.existsSync(f)) fs.copyFileSync(f, f + ".bak"); } catch {}
    fs.renameSync(tmp, f);
  } catch {}
}

/** 超过阈值时把旧对话压成摘要，保留最近若干轮 */
const summarizing = new Set();
async function maybeSummarize(key) {
  const m = cfg.memory || {};
  if (m.summarize === false) return;
  if (summarizing.has(key)) return;
  const hist = sessions.get(key) || [];
  const limit = Number(m.maxTurns ?? 60) * 2;
  const keep = Number(m.summaryKeepTurns ?? 20) * 2;
  if (hist.length <= limit) return;

  summarizing.add(key);
  try {
    const cut = hist.length - keep;
    const old = hist.slice(0, cut);
    const rest = hist.slice(cut);
    const prev = summaries.get(key) || "";
    const body = old.map((x) => (x.role === "user" ? "对方：" : "我：") + x.content).join("\n");
    const prompt =
      `把下面的聊天记录压缩成简洁中文摘要，保留：对方的关键信息（称呼、喜好、忌讳、约定过的事）、聊过的话题、我的态度变化。` +
      `不要编造，不超过 300 字。\n\n` +
      (prev ? `【已有摘要】\n${prev}\n\n` : "") +
      `【新增记录】\n${body}`;
    const s = await askDeepSeek([
      { role: "system", content: "你是聊天记录压缩器，只输出摘要正文，不要解释、不要加标题。" },
      { role: "user", content: prompt },
    ]);
    if (s) {
      summaries.set(key, s.trim());
      sessions.set(key, rest);
      saveSession(key);
      log(`🗜️ 会话摘要已更新（压缩 ${old.length} 条，保留 ${rest.length} 条）`);
    }
  } catch (e) {
    log("⚠️ 会话摘要失败: " + e.message);
  } finally {
    summarizing.delete(key);
  }
}

/** 自我状态：让她知道自己有什么能力、缺什么 */
let ttsOnline = false;
let lastKnownBalance = null;

function probeTts() {
  const port = Number(cfg.voice?.localPort ?? 8808);
  if (cfg.voice?.engine !== "local") { ttsOnline = true; return; }
  const sock = new net.Socket();
  const done = (ok) => { ttsOnline = ok; try { sock.destroy(); } catch {} };
  sock.setTimeout(800);
  sock.once("connect", () => done(true));
  sock.once("timeout", () => done(false));
  sock.once("error", () => done(false));
  try { sock.connect(port, "127.0.0.1"); } catch { ttsOnline = false; }
}

function runtimeStatusText() {
  let stickerTotal = 0;
  const parts = [];
  for (const [cat, arr] of stickerMap) {
    if (arr.length) { stickerTotal += arr.length; parts.push(`${cat} ${arr.length}`); }
  }
  const st = runtimeState();
  const bal = lastKnownBalance != null ? `¥${lastKnownBalance.toFixed(2)}` : "未知";
  const voice =
    cfg.voice?.engine === "local"
      ? (ttsOnline ? "可用（克隆音色）" : "服务离线，暂时发不出语音")
      : "可用（系统音色）";
  return (
    `\n\n【你的运行状态】\n` +
    `- 表情包库存：${stickerTotal} 张${parts.length ? "（" + parts.join("，") + "）" : "（已空）"}\n` +
    `- 语音：${voice}\n` +
    `- 识图：${cfg.vision?.enable !== false ? "可用，能看清图片细节" : "不可用"}\n` +
    `- 画图：${cfg.vision?.apiKey ? "可用" : "不可用"}\n` +
    `- 联网搜索：${st.search === false ? "被关掉了" : "可用"}\n` +
    `- 发说说 / 换头像：可用\n` +
    `- 余额：${bal}\n` +
    `- 某项不可用时，直接说做不了、让对方去面板打开，不要假装能做。`
  );
}

function nowText() {
  const d = new Date();
  const week = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} 星期${week}`;
}

/** 把时间戳格式化成 [HH:MM] 或 [MM-DD HH:MM]，只给模型看 */
function timeTag(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay
    ? `[${p(d.getHours())}:${p(d.getMinutes())}] `
    : `[${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}] `;
}

function buildMessages(key, userText) {
  const hist = sessions.get(key) || [];
  hist.push({ role: "user", content: userText, t: Date.now() });
  // 开启摘要时不硬截断，交给 maybeSummarize 处理
  if (cfg.memory?.summarize === false) {
    while (hist.length > cfg.memory.maxTurns * 2) hist.shift();
  }
  sessions.set(key, hist);
  saveSession(key);
  const summary = summaries.get(key) || "";
  const sys =
    cfg.persona.systemPrompt +
    (summary ? `\n\n【过往对话摘要】\n${summary}` : "") +
    runtimeStatusText() +
    store.factsText() +
    store.eventsText(8) +
    store.todoText() +
    `\n\n【当前时间】${nowText()}（以这个为准，不要说自己不知道时间）`;
  // 历史消息在后台加时间前缀，QQ 里看不到
  const histWithTime = hist.map((m) => ({ role: m.role, content: timeTag(m.t) + stripTimeTag(m.content) }));
  return [{ role: "system", content: sys }, ...histWithTime];
}

// 自动从对话里提取"关于他"的事实，补进事实库（每 8 分钟最多一次）
let lastFactExtract = 0;
async function maybeExtractFacts(key) {
  const hist = sessions.get(key) || [];
  if (hist.length < 6) return;
  if (Date.now() - lastFactExtract < 8 * 60000) return;
  lastFactExtract = Date.now();
  try {
    const recent = hist
      .slice(-18)
      .map((m) => (m.role === "user" ? "对方：" : "我：") + stripTimeTag(m.content))
      .join("\n");
    const out = await askDeepSeek([
      {
        role: "system",
        content:
          "你是记忆提取器。任务：从对话里挑出值得长期记住的、**关于对方**的事实。\n" +
          "类别只能是：称呼 / 雷点 / 喜好 / 作息 / 约定 / 其他。\n" +
          "规则：\n" +
          "1. 只提取对方明确说过的，不要推测。\n" +
          "2. 每条 ≤ 25 字，要具体（「喜欢喝冰美式」而不是「有喜欢的饮料」）。\n" +
          "3. 拒绝流水账（「今天吃饭了」这种不要）。\n" +
          "4. 没有值得记的就输出 []。\n" +
          "6. 不要记录时间性的临时承诺（「半小时后发消息」「明天找你」「等会儿再聊」这类），只记长期稳定的信息。\n" +
          "5. 只输出 JSON 数组，格式：[{\"cat\":\"类别\",\"val\":\"内容\"}]，不要任何解释。",
      },
      { role: "user", content: recent },
    ]);
    const m = String(out || "").match(/\[[\s\S]*\]/);
    if (!m) return;
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr) || !arr.length) return;
    let added = 0;
    for (const it of arr.slice(0, 5)) {
      const cat = String(it?.cat || "其他").trim();
      const val = String(it?.val || "").trim();
      if (!val || val.length > 40) continue;
      // 兜底：时间性临时承诺不记
      if (/(\d+\s*(分钟|小时)|半小时|一会儿|等会|稍后|过会)/.test(val) &&
          /(发消息|找你|聊|说|回你|打电话)/.test(val)) {
        log(`⏭️ 跳过时间性承诺：${val}`);
        continue;
      }
      if (!["称呼", "雷点", "喜好", "作息", "约定", "其他"].includes(cat)) continue;
      if (store.addFact(cat, val)) {
        added++;
        log(`🧠 记住：${cat} / ${val}`);
      }
    }
    if (added) log(`🧠 本次新记 ${added} 条事实`);
  } catch (e) {
    log("⚠️ 事实提取失败: " + e.message);
  }
}

/** 只把"我做了什么"记进历史（发图/发表情/发语音），不触发摘要和事实提取 */
function noteSelfAction(key, text) {
  try {
    const hist = sessions.get(key) || [];
    hist.push({ role: "assistant", content: String(text), t: Date.now() });
    sessions.set(key, hist);
    saveSession(key);
  } catch {}
}

function pushAssistant(key, text) {
  const hist = sessions.get(key) || [];
  hist.push({ role: "assistant", content: stripTimeTag(text), t: Date.now() });
  if (cfg.memory?.summarize === false) {
    while (hist.length > cfg.memory.maxTurns * 2) hist.shift();
  }
  sessions.set(key, hist);
  saveSession(key);
  maybeSummarize(key).catch(() => {});
  maybeExtractFacts(key).catch(() => {});
}

// ---------------- OneBot ----------------
let ws = null;
let seq = 0;
const pending = new Map();

function connect() {
  log(`连接 NapCat: ${cfg.napcat.wsUrl}`);
  ws = new WebSocket(cfg.napcat.wsUrl);

  ws.addEventListener("open", () => {
    log("✅ 已连接 NapCat OneBot"); _throttle.clear();
    if (cfg.balance?.enable) setTimeout(() => checkBalance("启动检查").catch(() => {}), 2000);
  });
  ws.addEventListener("close", () => { logThrottled("ws-close", "❌ 与 NapCat 断开（已降噪，每 60 秒记一次）", 60000); setTimeout(connect, 5000); });
  ws.addEventListener("error", (e) => logThrottled("ws-err", "WS 错误: " + (e.message || e.type), 60000));

  ws.addEventListener("message", async (ev) => {
    let data;
    try { data = JSON.parse(ev.data); } catch { return; }
    if (data.echo && pending.has(data.echo)) {
      pending.get(data.echo)(data); pending.delete(data.echo); return;
    }
    if (data.post_type !== "message") return;
    handleMessage(data).catch((e) => {
      reportError("handleMessage", e);
      const msg = String(e?.message || e);
      if (/402|insufficient|balance|quota/i.test(msg)) {
        callApi("send_private_msg", { user_id: data.user_id, message: FALLBACK_LINE }).catch(() => {});
        log("🪫 余额不足，已发送降级回复");
      }
    });
  });
}

function callApi(action, params) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState !== 1) return resolve(null);
    const echo = "req" + ++seq;
    pending.set(echo, resolve);
    ws.send(JSON.stringify({ action, params, echo }));
    setTimeout(() => { if (pending.has(echo)) { pending.delete(echo); resolve(null); } }, 20000);
  });
}

// ---------------- 余额 ----------------
let balanceAlerted = false;

async function checkBalance(reason = "定时检查") {
  let bal;
  try { bal = await getBalance(); } catch (e) { log(`⚠️ 余额查询失败(${reason}): ${e.message}`); return; }
  if (!bal || Number.isNaN(bal.total)) return;

  lastKnownBalance = bal.total;
  log(`💰 余额 ${bal.currency} ${bal.total.toFixed(2)}（${reason}）`);
  const threshold = Number(cfg.balance?.threshold ?? 0.5);

  if (bal.total < threshold) {
    if (balanceAlerted) return;
    balanceAlerted = true;
    const text =
      `⚠️ DeepSeek 余额不足\n当前余额：${bal.currency} ${bal.total.toFixed(2)}\n` +
      `提醒阈值：${bal.currency} ${threshold.toFixed(2)}\n请及时充值，否则小塔将无法回复。`;
    for (const qq of cfg.balance?.notifyQQ || []) {
      const r = await callApi("send_private_msg", { user_id: qq, message: text });
      log(`📢 已向 ${qq} 发送余额告警（${r?.status ?? "失败"}）`);
    }
  } else if (balanceAlerted) {
    balanceAlerted = false;
    log("✅ 余额已恢复，解除告警状态");
  }
}

// ---------------- 消息解析 ----------------
/** QQ 黄脸 face id → 中文含义（常用部分，其余显示 id） */
const FACE_MAP = {
  "0": "惊讶", "1": "撇嘴", "2": "色", "3": "发呆", "4": "得意", "5": "流泪",
  "6": "害羞", "7": "闭嘴", "8": "睡", "9": "大哭", "10": "尴尬", "11": "发怒",
  "12": "调皮", "13": "呲牙", "14": "微笑", "15": "难过", "16": "酷", "17": "冷汗",
  "18": "抓狂", "19": "吐", "20": "偷笑", "21": "可爱", "22": "白眼", "23": "傲慢",
  "24": "饥饿", "25": "困", "26": "惊恐", "27": "流汗", "28": "憨笑", "29": "悠闲",
  "30": "奋斗", "31": "咒骂", "32": "疑问", "33": "嘘", "34": "晕", "35": "抓狂",
  "36": "衰", "37": "骷髅", "38": "敲打", "39": "再见", "40": "擦汗", "41": "抠鼻",
  "42": "鼓掌", "43": "糗大了", "44": "坏笑", "45": "左哼哼", "46": "右哼哼",
  "47": "哈欠", "48": "鄙视", "49": "委屈", "50": "快哭了", "51": "阴险",
  "52": "亲亲", "53": "吓", "54": "可怜", "55": "菜刀", "56": "西瓜", "57": "啤酒",
  "58": "篮球", "59": "乒乓", "60": "咖啡", "61": "饭", "62": "猪头", "63": "玫瑰",
  "64": "凋谢", "65": "嘴唇", "66": "爱心", "67": "心碎", "68": "蛋糕", "69": "闪电",
  "70": "炸弹", "71": "刀", "72": "足球", "73": "瓢虫", "74": "便便", "75": "月亮",
  "76": "太阳", "77": "礼物", "78": "拥抱", "79": "强", "80": "弱", "81": "握手",
  "82": "胜利", "83": "抱拳", "84": "勾引", "85": "拳头", "86": "差劲", "87": "爱你",
  "88": "NO", "89": "OK", "90": "爱情", "91": "飞吻", "92": "跳跳", "93": "发抖",
  "94": "怄火", "95": "转圈", "96": "磕头", "97": "回头", "98": "跳绳", "99": "挥手",
  "100": "激动", "101": "街舞", "102": "献吻", "103": "左太极", "104": "右太极",
  "105": "戏弄", "106": "蹭一蹭", "107": "抬上腿", "108": "最右", "109": "擦汗",
  "110": "kiss", "111": "变形", "112": "挥手", "113": "炸", "114": "喵", "115": "爱心",
  "116": "心碎", "117": "茶", "118": "冷笑", "119": "dog", "120": "doge",
}
/** 提取文字，并为图片/表情/语音等非文字消息打上标记，让模型知道"对方发了什么" */
function extractContent(ev) {
  let text = "";
  let images = 0;
  let faces = 0;
  let records = 0;
  let files = 0;
  const imageSegs = [];
  const faceList = [];
  const mfaceList = [];

  if (typeof ev.message === "string") {
    text = ev.message;
    images = (ev.message.match(/\[CQ:image/g) || []).length;
    faces = (ev.message.match(/\[CQ:face/g) || []).length;
    records = (ev.message.match(/\[CQ:record/g) || []).length;
  } else if (Array.isArray(ev.message)) {
    for (const seg of ev.message) {
      switch (seg.type) {
        case "text": text += seg.data?.text || ""; break;
        case "image": images++; imageSegs.push(seg.data || {}); break;
        case "face": {
          const id = String(seg.data?.id ?? "");
          faceList.push(FACE_MAP[id] || `id=${id}`);
          break;
        }
        case "mface": {
          // 自定义/商城表情包：有 url 就当图片识图
          const d = seg.data || {};
          const nm = String(d.summary || "").trim();
          if (d.url && /^https?:\/\//.test(d.url)) {
            images++;
            imageSegs.push({ ...d, __isMface: true, __name: nm });
            mfaceList.push(nm || "表情包");
          } else {
            faces++;
            mfaceList.push(nm || "表情包");
          }
          break;
        }
        case "record": records++; break;
        case "file": files++; break;
        default: break;
      }
    }
  } else {
    text = ev.raw_message || "";
  }

  text = text.trim();
  const marks = [];
  if (images === 1) marks.push("[对方发来一张图片]");
  else if (images > 1) marks.push(`[对方发来${images}张图片]`);
  if (faceList.length) marks.push(`[对方发了个QQ表情：${faceList.join("、")}]`);
  if (mfaceList.length && !images) marks.push(`[对方发来表情包：${mfaceList.join("、")}]`);
  if (records > 0) marks.push("[对方发来语音]");
  if (files > 0) marks.push("[对方发来文件]");

  return { text, full: [text, ...marks].filter(Boolean).join(" "), hasImage: images > 0, imageSegs, records };
}

function isAtMe(ev) {
  const self = String(ev.self_id || cfg.napcat.selfId);
  if (!Array.isArray(ev.message)) return (ev.raw_message || "").includes("[CQ:at,qq=" + self);
  return ev.message.some((s) => s.type === "at" && String(s.data?.qq) === self);
}

function shouldReply(ev, text) {
  if (!text) return false;
  if (ev.message_type === "private") {
    const wl = cfg.reply.privateWhitelist || [];
    if (wl.length && !wl.includes(Number(ev.user_id))) {
      log(`🚫 忽略未授权私聊 ${ev.user_id}`);
      return false;
    }
    return true;
  }
  if (ev.message_type === "group") {
    if (!cfg.reply.enableGroups) return false;
    if (cfg.reply.groupWhitelist?.length && !cfg.reply.groupWhitelist.includes(Number(ev.group_id))) return false;
    if (cfg.reply.groupNeedAt && !isAtMe(ev)) return false;
    return true;
  }
  return false;
}

/** 把 [voice]...[/voice] 抽出来，替换成占位符，交给后续按顺序发送 */
function extractVoices(raw) {
  const voices = [];
  const push = (t) => {
    const x = String(t).trim();
    if (!x) return "";
    voices.push(x);
    return `\u0001V${voices.length - 1}\u0001`;
  };
  let out = raw.replace(/\[voice\]([\s\S]*?)\[\/voice\]/g, (_, t) => push(t));
  out = out.replace(/^\[voice\](.+)$/gm, (_, t) => push(t));
  return { voices, processed: out };
}

/** 把 AI 回复拆成 [{type:'text',text}|{type:'sticker',emotion}] */
function parseReply(raw) {
  const parts = [];
  const re = /\[sticker(?::\s*([a-zA-Z]+))?\]/g;
  let last = 0, m;
  while ((m = re.exec(raw))) {
    const pre = raw.slice(last, m.index).trim();
    if (pre) parts.push({ type: "text", text: pre });
    parts.push({ type: "sticker", emotion: (m[1] || "").toLowerCase() });
    last = m.index + m[0].length;
  }
  const tail = raw.slice(last).trim();
  if (tail) parts.push({ type: "text", text: tail });
  return parts;
}

/** 把过长的句子按标点切成不超过 maxLen 的小段 */
function splitLong(text, maxLen) {
  const out = [];
  let rest = String(text).trim();
  const marks = ["，", "。", "！", "？", "、", "；", ",", ".", "!", "?", " "];
  while (rest.length > maxLen) {
    let cut = -1;
    for (const p of marks) {
      const idx = rest.lastIndexOf(p, maxLen);
      if (idx > cut) cut = idx;
    }
    if (cut < maxLen * 0.4) cut = maxLen - 1;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** 把一段文字按换行拆成多个气泡（限制数量） */
function splitBubbles(text, max) {
  const lines = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (lines.length <= 1) return [text.trim()].filter(Boolean);
  const head = lines.slice(0, Math.max(1, max - 1));
  const rest = lines.slice(Math.max(1, max - 1)).join("\n");
  return rest ? [...head, rest] : head;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 模拟真人"看手机→思考→开始打字"的时间 */
function thinkTime(text, cfgReply) {
  const [mn, mx] = Array.isArray(cfgReply?.typingDelayMs) ? cfgReply.typingDelayMs : [1500, 4000];
  const base = Number(mn) + Math.random() * Math.max(0, Number(mx) - Number(mn));
  const byLen = Math.min(3000, String(text || "").length *100 ); // 长回复想得久
  return Math.round(base + byLen);
}

const SHORT_MAP = {
  "嗯": "嗯嗯", "好": "好的呀", "行": "行呀", "是": "是呀", "对": "对呀",
  "哦": "哦哦", "哈": "哈哈", "在": "在呢", "可以": "可以呀", "没有": "没有啦",
};
/** 去掉模型模仿出来的时间戳前缀 [22:40] / [10-25 22:40] */
function stripTimeTag(text) {
  // 行首时间戳：支持 [20:41] / [11-19 20:41] / [20-11-19 20:41] / [2026-11-19 20:41(:09)]
  // 也支持 【】（）括号、以及斜杠/点/年月日分隔
  const head = /^\s*[\[【(（]\s*(?:(?:\d{1,4}\s*[-.\/年]\s*)?\d{1,2}\s*[-.\/月]\s*\d{1,2}\s*日?\s*)?(?:\d{1,2}\s*:\s*)?\d{1,2}\s*:\s*\d{2}(?:\s*:\s*\d{2})?\s*[\]】)）]\s*/;
  // 行尾时间戳（模型偶尔加在句末）
  const tail = /\s*[\[【(（]\s*(?:(?:\d{1,4}\s*[-.\/年]\s*)?\d{1,2}\s*[-.\/月]\s*\d{1,2}\s*日?\s*)?(?:\d{1,2}\s*:\s*)?\d{1,2}\s*:\s*\d{2}(?:\s*:\s*\d{2})?\s*[\]】)）]\s*$/;
  return String(text || "")
    .split("\n")
    .map((line) => {
      let s = line;
      let guard = 0;
      while (head.test(s) && guard++ < 10) s = s.replace(head, "");
      guard = 0;
      while (tail.test(s) && guard++ < 10) s = s.replace(tail, "");
      return s;
    })
    .filter((line) => line.trim())
    .join("\n")
    .trim();
}

/** 清掉所有残留的 [xxx:...] 标记（兜底用） */
function stripAllMarkers(s) {
  return String(s || "")
    .replace(/\[voice\][\s\S]*?\[\/voice\]/gi, "")
    .replace(/\[(?:sticker|sticker[-_]del|search|qzone|draw|avatar|note|fact|event|todo|done|sys|read|remind|phone)[^\]]*\]/gi, "")
    .replace(/\[avatar\]/gi, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 避免只回一两个字，显得敷衍 */
function fattenShort(text) {
  const t = String(text).trim();
  if (!t || t.length >= 4) return t;
  if (SHORT_MAP[t]) return SHORT_MAP[t];
  if (/[呀呢啦哦嗯哈嘛]$/.test(t)) return t + "～";
  return t + "呀";
}

/** 拿到工具结果后让她再补一句自然的话 */
async function followUpInfo(ev, key, infoText) {
  try {
    const hist = sessions.get(key) || [];
    const msgs = [
      { role: "system", content: cfg.persona.systemPrompt + runtimeStatusText() },
      ...hist,
      { role: "user", content: `${infoText}\n\n用你平时的口吻回应一下，简短一点，不要输出任何 [方括号] 标记。` },
    ];
    const reply = await askDeepSeek(msgs);
    if (!reply) return;
    const clean = stripTimeTag(String(reply).replace(/\[[a-zA-Z_-]+[:：][^\]]*\]/g, "")).trim();
    if (clean) {
      await sendText(ev, clean);
      pushAssistant(key, clean);
    }
  } catch (e) {
    log("⚠️ 二次回应失败: " + e.message);
  }
}

async function sendText(ev, text) {
  if (ev.message_type === "group") {
    return callApi("send_group_msg", { group_id: ev.group_id, message: text });
  }
  return callApi("send_private_msg", { user_id: ev.user_id, message: text });
}

async function sendImage(ev, file) {
  let b64;
  try { b64 = fs.readFileSync(file).toString("base64"); } catch (e) { log("读取表情包失败: " + e.message); return null; }
  const seg = [{ type: "image", data: { file: "base64://" + b64 } }];
  if (ev.message_type === "group") {
    return callApi("send_group_msg", { group_id: ev.group_id, message: seg });
  }
  return callApi("send_private_msg", { user_id: ev.user_id, message: seg });
}

// ---------------- 语音（TTS） ----------------
const TTS_SCRIPT = path.join(HERE, "tts.ps1");
const VOICE_TMP = path.join(HERE, "_voice");

/** 向本地 TTS 服务发 POST，返回音频 Buffer */
function httpPostBuffer(host, port, pathname, body, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: host, port, path: pathname, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          if (res.statusCode !== 200) {
            return reject(new Error("TTS 服务 " + res.statusCode + ": " + buf.toString("utf8").slice(0, 160)));
          }
          resolve(buf);
        });
      },
    );
    req.on("timeout", () => { req.destroy(); reject(new Error("TTS 服务超时")); });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function ttsReady() {
  if (cfg.voice?.enable === false || runtimeState().voice === false) return false;
  if (cfg.voice?.engine === "local") return true; // 由调用时探测服务
  return fs.existsSync(TTS_SCRIPT);
}

/** 合成 WAV，返回文件路径（local=CosyVoice2 服务，sapi=Windows TTS） */
async function synthesize(text) {
  const max = Number(cfg.voice?.maxChars ?? 80);
  const t = String(text).replace(/[[\]]/g, "").trim().slice(0, max);
  if (!t) return null;
  fs.mkdirSync(VOICE_TMP, { recursive: true });

  if (cfg.voice?.engine === "local" && runtimeState().localTts !== false) {
    const port = Number(cfg.voice?.localPort ?? 8808);
    try {
      const buf = await httpPostBuffer("127.0.0.1", port, "/tts", {
        text: t,
        promptText: cfg.voice?.promptText || undefined,
        instruct: cfg.voice?.instruct || undefined,
        speed: Number(cfg.voice?.speed ?? 1.0),
        pitch: Number(cfg.voice?.pitch ?? 1.0),
      });
      const out = path.join(VOICE_TMP, `loc_${Date.now()}_${Math.floor(Math.random() * 10000)}.wav`);
      fs.writeFileSync(out, buf);
      return out;
    } catch (e) {
      log("⚠️ 本地 TTS 失败，回退 Windows TTS: " + e.message);
    }
  }

  return new Promise((resolve, reject) => {
    const stamp = Date.now() + "_" + Math.floor(Math.random() * 100000);
    const txtPath = path.join(VOICE_TMP, `t_${stamp}.txt`);
    const wavPath = path.join(VOICE_TMP, `v_${stamp}.wav`);

    try { fs.writeFileSync(txtPath, t, "utf8"); } catch (e) { return reject(e); }

    execFile(
      "powershell.exe",
      [
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", TTS_SCRIPT,
        "-TextFile", txtPath, "-OutFile", wavPath,
        "-Voice", String(cfg.voice?.name ?? "Microsoft Yaoyao"),
        "-Rate", String(Number(cfg.voice?.rate ?? 0)),
        "-Volume", String(Number(cfg.voice?.volume ?? 0)),
      ],
      { timeout: 90000, windowsHide: true },
      (err) => {
        try { fs.unlinkSync(txtPath); } catch {}
        if (err) return reject(new Error("TTS 执行失败: " + err.message));
        if (!fs.existsSync(wavPath)) return reject(new Error("TTS 未生成文件"));
        resolve(wavPath);
      },
    );
  });
}

async function sendVoice(ev, text) {
  if (!ttsReady()) { log("⚠️ 语音未启用或缺少 tts.ps1"); return null; }
  let wav;
  try {
    wav = await synthesize(text);
  } catch (e) {
    log("⚠️ 语音合成失败: " + e.message);
    return null;
  }
  if (!wav) return null;

  let b64;
  try { b64 = fs.readFileSync(wav).toString("base64"); } catch { return null; }
  const seg = [{ type: "record", data: { file: "base64://" + b64 } }];

  const r = ev.message_type === "group"
    ? await callApi("send_group_msg", { group_id: ev.group_id, message: seg })
    : await callApi("send_private_msg", { user_id: ev.user_id, message: seg });

  try { fs.unlinkSync(wav); } catch {}
  log(`🔊 语音 ${String(text).slice(0, 24)} → ${r?.status ?? "失败"}`);
  return r;
}

// ---------------- 消息处理 ----------------
// ---------------- 连发消息合并（图+文字只回一次） ----------------
const mergeBuf = new Map(); // key → { items: [{text, imageSegs, voiceText}], ev, timer }
const MERGE_WAIT_MS = 2500; // 最后一条消息后等多久再统一处理

async function handleMessage(ev) {
  const { text, full, imageSegs, records } = extractContent(ev);
  if (!shouldReply(ev, full)) return;
  if (runtimeState().enable === false) return; // 面板总开关关闭

  // 语音消息：调 QQ 自带的语音转文字
  let voiceText = null;
  if (records > 0) {
    voiceText = await transcribeVoice(ev.message_id);
    if (voiceText) log(`🎧 语音识别: ${voiceText.slice(0, 60)}`);
    else log("⚠️ 语音识别无结果");
  }

  lastActivity = Date.now(); // 有互动就重置主动消息计时

  // 显式命令：不走 AI，直接执行
  const cmdText = (text || "").trim();
  const mCmd = cmdText.match(/^[#／/](说说|画|换头像)\s*([\s\S]*)$/);
  if (mCmd) {
    const cmd = mCmd[1];
    const arg = (mCmd[2] || "").trim();
    try {
      if (cmd === "说说") {
        if (!arg) { await sendText(ev, "说说内容呢？格式：#说说 今天好累"); return; }
        await sendQzone(arg, cfg.qzone?.ugcRight ?? 1);
        await sendText(ev, "说说发好了~");
        return;
      }
      if (cmd === "画") {
        if (!arg) { await sendText(ev, "画什么？格式：#画 一只蓝色鲸鱼"); return; }
        await sendText(ev, "等我画一下…");
        const f = await generateImage(arg);
        await sendImage(ev, f);
        return;
      }
      if (cmd === "换头像") {
        if (imageSegs.length && imageSegs[0].url) {
          const buf = await fetchBuffer(imageSegs[0].url);
          if (buf) {
            const dir = path.join(HERE, "_img");
            fs.mkdirSync(dir, { recursive: true });
            const f = path.join(dir, `ava_${Date.now()}.png`);
            fs.writeFileSync(f, buf);
            await setQqAvatar(f);
            await sendText(ev, "头像换好了");
            return;
          }
        }
        if (arg) {
          const f = await generateImage(arg);
          await setQqAvatar(f);
          await sendText(ev, "头像换成这张啦");
          return;
        }
        await sendText(ev, "发张图给我，或者写 #换头像 画什么");
        return;
      }
    } catch (e) {
      log(`⚠️ 命令 ${cmd} 失败: ${e.message}`);
      await sendText(ev, "这个我搞砸了…");
      return;
    }
  }

  // ---------------- 连发消息合并：先攒起来，等 2.2 秒没新消息再统一回 ----------------
  if (!ev.__merged) {
    const mk = sessionKey(ev);
    const buf = mergeBuf.get(mk) || { items: [], ev, timer: null };
    buf.items.push({ text, imageSegs, records, voiceText });
    buf.ev = ev;
    mergeBuf.set(mk, buf);
    if (buf.timer) clearTimeout(buf.timer);
    buf.timer = setTimeout(() => {
      const cur = mergeBuf.get(mk);
      mergeBuf.delete(mk);
      if (!cur || !cur.items.length) return;
      const segs = [];
      let first = true;
      for (const it of cur.items) {
        const t = (it.text || "").trim();
        if (t) {
          if (!first) segs.push({ type: "text", data: { text: "\n" } });
          segs.push({ type: "text", data: { text: t } });
          first = false;
        }
        for (const s of it.imageSegs || []) segs.push({ type: "image", data: s });
      }
      const vts = cur.items.map((i) => i.voiceText).filter(Boolean);
      if (vts.length) {
        segs.push({ type: "text", data: { text: (first ? "" : " ") + vts.map((v) => `[对方发来语音，说的是：「${v}」]`).join(" ") } });
      }
      const mergedEv = { ...cur.ev, __merged: true, message: segs, raw_message: "" };
      log(`🧩 合并 ${cur.items.length} 条消息后统一处理`);
      handleMessage(mergedEv).catch((e) => reportError("mergedMessage", e));
    }, MERGE_WAIT_MS);
    return;
  }

  const who = ev.message_type === "group" ? `群${ev.group_id}/${ev.user_id}` : `私聊${ev.user_id}`;

  // 有图且启用了视觉模型 → 先识图，把描述塞进上下文
  let augmented = full;
  let imgDesc = null;
  if (imageSegs.length && cfg.vision?.enable && cfg.vision?.apiKey) {
    imgDesc = await describeImage(imageSegs[0]);
    if (imgDesc) {
      const isMf = !!imageSegs[0].__isMface;
      const label = isMf
        ? `[对方发来一个表情包，画面内容：${imgDesc}]`
        : `[对方发来图片，画面内容：${imgDesc}]`;
      augmented = full.replace(/\[对方发来[^\]]*图片\]/, label);
    }
  }
  // 自动收藏对方发的图（丢进表情包库）
  if (imageSegs.length && cfg.stickers?.autoCollect !== false) {
    collectSticker(imageSegs[0], imgDesc).catch(() => {});
  }
  if (voiceText) {
    augmented = augmented.replace("[对方发来语音]", `[对方发来语音，说的是：「${voiceText}」]`);
  }

  log(`📩 ${who}: ${augmented.slice(0, 140)}`);

  const key = sessionKey(ev);
  let raw;
  try {
    raw = await askDeepSeek(buildMessages(key, augmented));
  } catch (e) {
    log("❌ DeepSeek 调用失败: " + e.message);
    raw = "（我这边出了点问题，等下再试）";
  }
  if (!raw) return;

  // 如果模型要求联网搜索，就搜一次再让它重答
  const sm = raw.match(/\[search[:：]\s*([^\]\n]+)\]/);
  if (sm && cfg.search?.enable !== false) {
    const q = sm[1].trim();
    const info = await webSearch(q);
    if (info) {
      log(`🔍 联网搜索「${q}」→ ${info.replace(/\s+/g, " ").slice(0, 80)}`);
      const hist = sessions.get(key) || [];
      const messages2 = [
        { role: "system", content: cfg.persona.systemPrompt },
        ...hist,
        {
          role: "user",
          content: `【联网搜索结果】\n${info}\n\n请根据上面的结果，用你平时的口吻回答我刚才那句。不要再输出 [search:...]。`,
        },
      ];
      try {
        const second = await askDeepSeek(messages2);
        if (second) raw = second;
      } catch (e) {
        log("⚠️ 搜索后二次请求失败: " + e.message);
      }
    } else {
      log(`⚠️ 搜索「${q}」没有结果`);
    }
  }
  raw = raw.replace(/\[search[:：][^\]]*\]/g, "").trim();

  // 提取 QQ 空间 / 画图 / 头像 标记
  const jobs = [];
  raw = raw.replace(/\[qzone[:：]([^\]]+)\]/g, (_, t) => { jobs.push({ type: "qzone", text: t.trim() }); return ""; });
  raw = raw.replace(/\[draw[:：]([^\]]+)\]/g, (_, t) => { jobs.push({ type: "draw", prompt: t.trim() }); return ""; });
  raw = raw.replace(/\[avatar[:：]([^\]]+)\]/g, (_, t) => { jobs.push({ type: "avatar", prompt: t.trim() }); return ""; });
  raw = raw.replace(/\[avatar\]/gi, () => { jobs.push({ type: "avatar" }); return ""; }).trim();
  const notes = [];
  const memOps = [];
  raw = raw.replace(/\[fact[:：]\s*([^:：\]\n]{1,10})[:：]\s*([^\]\n]+)\]/g, (_, c, v) => { memOps.push(["fact", c.trim(), v.trim()]); return ""; });
  raw = raw.replace(/\[event[:：]\s*([^\]\n]+)\]/g, (_, v) => { memOps.push(["event", v.trim()]); return ""; });
  raw = raw.replace(/\[todo[:：]\s*([^\]\n]+)\]/g, (_, v) => { memOps.push(["todo", v.trim()]); return ""; });
  raw = raw.replace(/\[done[:：]\s*([^\]\n]+)\]/g, (_, v) => { memOps.push(["done", v.trim()]); return ""; });
  const toolOps = [];
  raw = raw.replace(/\[sys\]/gi, () => { toolOps.push(["sys"]); return ""; });
  raw = raw.replace(/\[read[:：]\s*(config|diary|配置|日记)\s*\]/gi, (_, w) => { toolOps.push(["read", /config|配置/i.test(w) ? "config" : "diary"]); return ""; });
  raw = raw.replace(/\[remind[:：]\s*([^:：\]\n]+)[:：]\s*([^\]\n]+)\]/g, (_, w, c) => { toolOps.push(["remind", w.trim(), c.trim()]); return ""; });
  raw = raw.replace(/\[sticker[-_]del[:：]\s*([^\]\n]+)\]/gi, (_, k) => { toolOps.push(["sdel", k.trim()]); return ""; });
  raw = raw.replace(/\[phone[-_:：]\s*([a-z]+)(?:[:：]\s*([^\]\n]*))?\]/gi, (_, a, b) => { toolOps.push(["phone", a.trim(), (b || "").trim()]); return ""; });
  raw = raw.replace(/\[note[:：]([^\]]+)\]/g, (_, t) => { notes.push(t.trim()); return ""; }).trim();

  if (!raw && jobs.length === 0) raw = "这个我查了下没找到诶";
  if (!raw && jobs.length > 0) raw = "";

  pushAssistant(key, raw || "（执行操作）");
  log(`📤 ${who}: ${(raw || "(仅执行操作)").slice(0, 120).replace(/\n/g, " ⏎ ")}`);

  const cfgReply = cfg.reply || {};
  const baseMax = Number(cfgReply.maxBubbles ?? 3);
  const minB = Number(cfgReply.minBubbles ?? 2);
  const maxBubbles = cfgReply.randomBubbles === false
    ? baseMax
    : Math.max(minB, minB + Math.floor(Math.random() * Math.max(1, baseMax - minB + 1)));
  const [dMin, dMax] = Array.isArray(cfgReply.delayMs) ? cfgReply.delayMs : [350, 900];
  const stickerLimit = cfg.stickers?.enable === false ? 0 : Number(cfg.stickers?.maxPerReply ?? 1);

  const maxLen = Number(cfgReply.maxCharsPerBubble ?? 50);
  const typoChance = Number(cfgReply.typoChance ?? 0);
  let stickersUsed = 0;
  const { voices, processed } = extractVoices(raw);

  for (const part of parseReply(processed)) {
    if (part.type === "text") {
      // 一段文字里可能夹着语音占位符，按占位符切片
      for (const seg of part.text.split(/(\u0001V\d+\u0001)/)) {
        const mv = seg.match(/^\u0001V(\d+)\u0001$/);
        if (mv) {
          const vt = voices[Number(mv[1])];
          if (vt) {
            await sendVoice(ev, vt);
              noteSelfAction(key, `（我说了一段语音：${vt}）`);
            await sleep(dMin + Math.random() * Math.max(0, dMax - dMin));
          }
          continue;
        }
        const chunk = seg.trim();
        if (!chunk) continue;
        let bubbles = [];
        for (const b of splitBubbles(chunk, maxBubbles)) {
          if (maxLen > 0) bubbles.push(...splitLong(b, maxLen));
          else bubbles.push(b);
        }
        if (bubbles.length > maxBubbles) {
          bubbles = bubbles.slice(0, maxBubbles - 1).concat([bubbles.slice(maxBubbles - 1).join("")]);
        }
        let firstBubble = true;
        for (const bubble of bubbles) {
          if (!bubble) continue;
          if (firstBubble) {
            const wait = thinkTime(bubble, cfgReply);
            log(`⏳ 思考 ${(wait / 1000).toFixed(1)}s 后回复`);
            await sleep(wait);
            firstBubble = false;
          }
          const out = fattenShort(stripTimeTag(stripAllMarkers(bubble)));
          // 极低频：先发一半再撤回
          if (typoChance > 0 && out.length >= 8 && Math.random() < typoChance) {
            try {
              const half = out.slice(0, Math.max(3, Math.floor(out.length / 2)));
              const r1 = await sendText(ev, half + "…");
              await sleep(900 + Math.random() * 900);
              const mid = r1?.data?.message_id;
              if (mid) await callApi("delete_msg", { message_id: mid });
              await sleep(250);
            } catch (e) { log("⚠️ 撤回流程失败: " + e.message); }
          }
          await sendText(ev, out);
          await sleep(dMin + Math.random() * Math.max(0, dMax - dMin));
        }
      }
    } else if (part.type === "sticker") {
      if (stickersUsed >= stickerLimit) continue;
      const file = pickSticker(part.emotion);
      if (!file) { log("⚠️ 没有可用表情包（stickers 目录为空）"); continue; }
      const r = await sendImage(ev, file);
      stickersUsed++;
      log(`🎴 发送表情包 [${part.emotion || "随机"}] ${path.basename(file)} → ${r?.status ?? "失败"}`);
      noteSelfAction(key, `（我发了一个${part.emotion || ""}的表情包）`);
      await sleep(dMin + Math.random() * Math.max(0, dMax - dMin));
    }
  }

  for (const n of notes) appendDiary(n);
  // 工具：电脑状态 / 读配置日记 / 定时提醒 / 删表情包
  for (const op of toolOps) {
    try {
      if (op[0] === "sys") {
        const info = await tools.sysInfoFull();
        log(`🖥️ 电脑状态：${info}`);
        await followUpInfo(ev, key, `【电脑状态（真实数据）】${info}`);
      } else if (op[0] === "read") {
        const info = op[1] === "config" ? tools.readConfigSafe() : tools.readDiary(3);
        log(`📖 读取${op[1] === "config" ? "配置" : "日记"}：${String(info).slice(0, 60)}`);
        await followUpInfo(ev, key, `【${op[1] === "config" ? "你的配置" : "你最近写的日记"}】\n${info}`);
      } else if (op[0] === "remind") {
        const item = tools.addReminder(op[1], op[2], ev.user_id);
        if (item) { log(`⏰ 设提醒：${item.atText} ${item.content}`); await sendText(ev, `好，${item.atText} 我提醒你～`); }
        else await sendText(ev, "这个时间我没看懂，换个说法？比如「21:30」或者「+30m」");
      } else if (op[0] === "phone") {
        const act = op[1];
        const arg = op[2] || "";
        if (act === "connect") {
          const r = await phone.connect(arg);
          log(`📱 连接手机 ${arg} → ${r.ok ? "成功" : "失败：" + r.msg}`);
          await sendText(ev, r.ok ? "手机连上了" : `连不上：${r.msg}`);
        } else if (act === "disconnect") {
          await phone.disconnectAll();
          log("📱 已断开所有手机连接");
          await sendText(ev, "手机连接断开了");
        } else {
          const r = await phone.exec(act, arg);
          log(`📱 手机${act}${arg ? "(" + arg + ")" : ""} → ${r.ok ? r.msg : "拒绝：" + r.msg}`);
          if (r.ok && r.file) await sendImage(ev, r.file);
          else await sendText(ev, r.msg);
        }
      } else if (op[0] === "sdel") {
        const del = tools.deleteSticker(op[1]);
        if (del && del.length) { log(`🗑️ 删除表情包：${del.join(", ")}`); await sendText(ev, "删掉啦～"); }
        else await sendText(ev, "没找到这个表情包诶");
      }
    } catch (e) { log(`⚠️ 工具 ${op[0]} 失败: ${e.message}`); }
  }

  for (const op of memOps) {
    const kind = op[0];
    if (kind === "fact") { if (store.addFact(op[1], op[2])) log(`📌 档案 ${op[1]}：${op[2]}`); }
    else if (kind === "event") { if (store.addEvent(op[1])) log(`📅 事件：${op[1]}`); }
    else if (kind === "todo") { if (store.addTodo(op[1])) log(`📝 待聊：${op[1]}`); }
    else if (kind === "done") { if (store.doneTodo(op[1])) log(`✔️ 聊完：${op[1]}`); }
  }

  // 执行 QQ空间 / 画图 / 换头像
  for (const job of jobs) {
    try {
      if (job.type === "qzone") {
        await sendQzone(job.text, cfg.qzone?.ugcRight ?? 1);
        await sendText(ev, "说说发好了~");
      } else if (job.type === "draw") {
        await sendText(ev, "等我画一下…");
        const f = await generateImage(job.prompt);
        await sendImage(ev, f);
          noteSelfAction(key, `（我画了一张图：${job.prompt}）`);
      } else if (job.type === "avatar") {
        if (job.prompt) {
          const f = await generateImage(job.prompt);
          await setQqAvatar(f);
          await sendText(ev, "头像换成这张啦");
        } else if (imageSegs.length && imageSegs[0].url) {
          const buf = await fetchBuffer(imageSegs[0].url);
          if (!buf) throw new Error("下载原图失败");
          const dir = path.join(HERE, "_img");
          fs.mkdirSync(dir, { recursive: true });
          const f = path.join(dir, `ava_${Date.now()}.png`);
          fs.writeFileSync(f, buf);
          await setQqAvatar(f);
          await sendText(ev, "头像换好了");
        } else {
          await sendText(ev, "你发张图给我，或者告诉我画什么，再换头像");
        }
      }
    } catch (e) {
      log(`⚠️ ${job.type} 执行失败: ${e.message}`);
      await sendText(ev, "这个我搞砸了…");
    }
  }

  if (cfg.balance?.enable && Math.random() < 0.1) checkBalance("聊天后抽查").catch(() => {});
}

// ---------------- 主动发消息 ----------------
let nextProactiveAt = 0;
let proactiveDay = new Date().getDate();
let proactiveCount = 0;
const randBetween = (a, b) => a + Math.random() * (b - a);

function scheduleNextProactive() {
  const p = cfg.proactive || {};
  const idle = randBetween(Number(p.minIdleMinutes ?? 40), Number(p.maxIdleMinutes ?? 110));
  nextProactiveAt = Date.now() + idle * 60000;
}

async function maybeProactive() {
  const p = cfg.proactive || {};
  if (!p.enable) return;
  if (runtimeState().proactive === false) return;
  if (!nextProactiveAt) { scheduleNextProactive(); return; }

  const now = new Date();
  if (now.getDate() !== proactiveDay) { proactiveDay = now.getDate(); proactiveCount = 0; }

  const qs = Number(p.quietStartHour ?? 23);
  const qe = Number(p.quietEndHour ?? 8);
  const h = now.getHours();
  const inQuiet = qs <= qe ? (h >= qs && h < qe) : (h >= qs || h < qe);
  if (inQuiet) return;

  if (proactiveCount >= Number(p.maxPerDay ?? 4)) return;
  if (Date.now() < nextProactiveAt) return;
  if (Date.now() - lastActivity < Number(p.minIdleMinutes ?? 40) * 60000) return;

  const todoHint = store.randomTodo();
  const instruction = [
    "现在主动给他发一条消息。要求：",
    "1. 优先接住最近对话里没聊完的事，提一个具体的细节（他提过的东西、做过的事、说过的计划）。",
    "2. 不许用「在干嘛」「吃了吗」「睡了吗」「今天天气」这类万能开场。",
    "3. 一两句话，口语，可以是关心、想念、吐槽、分享一个刚想到的小事。",
    "4. 只能用对话记录、摘要、事实库里**真实出现过**的信息。",
    "4.5 引用细节时只能引用**他（用户）**说过的话或做过的事；你自己说过的话、你自己的提议，不能当成是他说的。如果分不清某件事是谁说的，就不要提这个细节，改成笼统的关心，绝不要自言自语。",
    "5. 绝对禁止编造具体的东西（文件名、计划、地点、事件）。想不起来具体细节时，就笼统地关心，比如「今天还顺利吗」，不要凭空说出一个具体的东西。",
    "6. 如果不确定某件事现在还成立，就别说得像确定。",
    "7. 如果你觉得现在确实没什么可说的，就只输出 [skip]，不要硬凑。",
    todoHint ? `\n（一个可以接的话头，只在不突兀时用：「${todoHint}」）` : "",
  ].filter(Boolean).join("\n");

  for (const qq of p.targets || []) {
    const key = `p:${qq}`;
    const all = sessions.get(key) || [];
    const hist = all.slice(-12);
    const summary = summaries.get(key) || "";
    const facts = store.factsText();
    const messages = [
      {
        role: "system",
        content:
          cfg.persona.systemPrompt +
          (summary ? `\n\n【更早的摘要】\n${summary}` : "") +
          (facts ? `\n\n【你记得的关于他的事】\n${facts}` : "") +
          `\n\n【当前时间】${nowText()}\n（你已经 ${Math.round((Date.now() - lastActivity) / 60000)} 分钟没跟他说话了）` +
          `\n\n【本次任务】${instruction}`,
      },
      ...hist.map((m) => ({ role: m.role, content: timeTag(m.t) + stripTimeTag(m.content) })),
    ];
    try {
      let text = await askDeepSeek(messages);
      if (!text) continue;
      if (/\[?\s*skip\s*\]?/i.test(text.trim()) && text.trim().length < 20) {
        log("💤 主动消息跳过（她判断没话说）");
        continue;
      }
      // 主动消息里如果她发了 [qzone:...]，真的发出去
      let zoneText = "";
      text = text.replace(/\[qzone[:：]([^\]]+)\]/g, (_, z) => { zoneText = String(z).trim(); return ""; });
      if (zoneText) {
        try {
          await sendQzone(zoneText, cfg.qzone?.ugcRight ?? 1);
          log(`📣 主动发说说：${zoneText.slice(0, 30)}`);
        } catch (e) { log("⚠️ 主动发说说失败: " + e.message); }
      }
      text = stripTimeTag(stripAllMarkers(text));
      if (!text) continue;
      await callApi("send_private_msg", { user_id: qq, message: text });
      pushAssistant(key, text);
      proactiveCount++;
      // 偶尔顺手发张图（主动分享）
      if (Math.random() < 0.3) {
        try {
          const topic = await askDeepSeek([
            { role: "system", content: "你是绘图提示器，只输出一句画面描述，20字内，不要解释。" },
            { role: "user", content: "结合你刚才想说的话，画一张什么样的小图合适？" },
          ]);
          if (topic) {
            const file = await generateImage(String(topic).trim().slice(0, 40));
            const b64 = fs.readFileSync(file).toString("base64");
            await callApi("send_private_msg", {
              user_id: qq,
              message: [{ type: "image", data: { file: "base64://" + b64 } }],
            });
            log(`🎨 主动分享了一张图：${String(topic).slice(0, 24)}`);
          }
        } catch (e) {
          log("⚠️ 主动分享图片失败: " + e.message);
        }
      }
      log(`📣 主动消息 → ${qq}: ${text.slice(0, 60)}`);
    } catch (e) {
      log("⚠️ 主动消息失败: " + e.message);
    }
  }
  scheduleNextProactive();
}

// ---------------- 启动 ----------------
rotateLog();
loadStickers();
loadCollectedHashes();
probeTts();
setInterval(probeTts, 30000);
setInterval(() => maybeWriteDiary().catch(() => {}), 60000);
setInterval(async () => {
  for (const r of tools.dueReminders()) {
    try {
      await callApi("send_private_msg", { user_id: r.qq, message: `⏰ 提醒你：${r.content}` });
      log(`⏰ 已发送提醒：${r.content}`);
    } catch (e) { log("⚠️ 提醒发送失败: " + e.message); }
  }
}, 30000);
const loadedSessions = loadSessions();
log("=== QQ Bot 启动 ===");
log(`模型: ${cfg.deepseek.model}  人设: ${cfg.persona.name}`);
log(`私聊白名单: ${JSON.stringify(cfg.reply.privateWhitelist || [])}`);
log(`余额阈值: ${cfg.balance?.threshold}`);
log(`表情包分类: ${[...stickerMap.keys()].join(", ") || "（空，请往 stickers/ 里放图）"}`);
log(`多气泡: 最多 ${cfg.reply?.maxBubbles ?? 3} 条/次`);
log(`视觉识图: ${cfg.vision?.enable && cfg.vision?.apiKey ? "已启用（" + cfg.vision.model + "）" : "未启用"}`);
log(`语音合成: ${cfg.voice?.engine === "local" ? "CosyVoice2 克隆（" + (cfg.voice?.promptText ? "zero_shot" : "cross_lingual") + "）" : "Windows TTS"}`);
log(`记忆: ${cfg.memory?.maxTurns ?? 10} 轮${cfg.memory?.persist !== false ? "，已落盘（C:\\QQBot\\memory）" : "，仅内存"}`);

connect();

if (cfg.proactive?.enable) {
  scheduleNextProactive();
  setInterval(() => maybeProactive().catch(() => {}), 60 * 1000);
  log(
    `主动消息: 已启用（空闲 ${cfg.proactive.minIdleMinutes}~${cfg.proactive.maxIdleMinutes} 分钟后触发，` +
    `每天最多 ${cfg.proactive.maxPerDay} 条，${cfg.proactive.quietStartHour}点~${cfg.proactive.quietEndHour}点不发）`,
  );
}

if (cfg.balance?.enable) {
  const mins = Number(cfg.balance.checkIntervalMinutes || 10);
  setInterval(() => checkBalance("定时检查").catch(() => {}), mins * 60 * 1000);
  log(`余额定时检查：每 ${mins} 分钟`);
}


