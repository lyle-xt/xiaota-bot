// 小塔的工具箱：系统状态 / 只读文件 / 定时提醒 / 表情包整理
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";

export function createTools(baseDir) {
  const REMIND = path.join(baseDir, "reminders.json");
  const TRASH = path.join(baseDir, "stickers", "_trash");

  function readJson(f, d) {
    try {
      return JSON.parse(fs.readFileSync(f, "utf8"));
    } catch {
      try { return JSON.parse(fs.readFileSync(f + ".bak", "utf8")); } catch { return d; }
    }
  }
  function writeJson(f, o) {
    try {
      const tmp = f + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(o, null, 2), "utf8");
      try { if (fs.existsSync(f)) fs.copyFileSync(f, f + ".bak"); } catch {}
      fs.renameSync(tmp, f);
    } catch {}
  }

  // ---------- 系统状态 ----------
  function sysInfo() {
    const total = os.totalmem() / 1024 ** 3;
    const free = os.freemem() / 1024 ** 3;
    const usedPct = ((total - free) / total) * 100;
    const upH = (os.uptime() / 3600).toFixed(1);

    let disks = [];
    try {
      const { execFileSync } = require("node:child_process");
    } catch {}

    const cpus = os.cpus();
    let load = 0;
    try {
      load = Math.round((os.loadavg()[0] / cpus.length) * 100);
    } catch {}
    if (!isFinite(load) || load < 0) load = 0;

    return [
      `内存 ${usedPct.toFixed(0)}%（${(total - free).toFixed(1)}/${total.toFixed(0)}GB）`,
      `开机 ${upH} 小时`,
      `CPU 核心 ${cpus.length}`,
      `平台 ${os.platform()} ${os.release()}`,
    ].join("；");
  }

  function diskInfo() {
    return new Promise((resolve) => {
      execFile("powershell", ["-NoProfile", "-Command",
        "Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used -ne $null } | ForEach-Object { \"$($_.Name):$([math]::Round($_.Free/1GB,1))G-free\" }"
      ], { timeout: 8000, windowsHide: true }, (err, stdout) => {
        if (err) return resolve("");
        resolve(String(stdout).trim().replace(/\r?\n/g, "；"));
      });
    });
  }

  async function sysInfoFull() {
    const d = await diskInfo();
    return sysInfo() + (d ? "；磁盘 " + d : "");
  }

  // ---------- 只读文件 ----------
  function readConfigSafe() {
    try {
      const c = readJson(path.join(baseDir, "config.json"), null);
      if (!c) return "读不到配置";
      const masked = JSON.parse(JSON.stringify(c));
      const mask = (o) => {
        if (!o || typeof o !== "object") return;
        for (const k of Object.keys(o)) {
          if (/apikey|api_key|key|token|secret/i.test(k) && typeof o[k] === "string") o[k] = "***已隐藏***";
          else if (typeof o[k] === "object") mask(o[k]);
        }
      };
      mask(masked);
      const v = masked.voice || {};
      const r = masked.reply || {};
      const m = masked.memory || {};
      const p = masked.proactive || {};
      return [
        `名字 ${masked.persona?.name}`,
        `人设 ${masked.persona?.systemPrompt?.length || 0} 字`,
        `语音 ${v.engine}/${v.speed}x/${v.pitch}`,
        `气泡 ${r.minBubbles}~${r.maxBubbles} 条`,
        `记忆 ${m.maxTurns} 轮${m.summarize ? "+摘要" : ""}`,
        `主动消息 每天${p.maxPerDay}条`,
      ].join("；");
    } catch (e) {
      return "读配置失败: " + e.message;
    }
  }

  function readDiary(n = 3) {
    try {
      const f = path.join(baseDir, "日记", "小塔日记.md");
      const txt = fs.readFileSync(f, "utf8");
      const blocks = txt.split(/^## /m).filter((x) => x.trim());
      const last = blocks.slice(-n).map((b) => "## " + b.trim()).join("\n\n");
      return last || "日记本还是空的";
    } catch {
      return "还没写过日记";
    }
  }

  // ---------- 定时提醒 ----------
  // 每次都从磁盘读，避免内存与文件不同步（外部写入会被覆盖的 bug）
  function loadReminders() {
    const j = readJson(REMIND, []);
    return Array.isArray(j) ? j.filter((r) => r && typeof r.at === "number") : [];
  }
  function saveReminders(list) {
    writeJson(REMIND, list);
  }

  /** 解析时间：+30m / +2h / 21:30 / 明天8点 */
  function parseWhen(spec) {
    const s = String(spec || "").trim();
    const now = new Date();
    let m;
    if ((m = s.match(/^\+(\d+)\s*(m|min|分钟)$/i))) return new Date(now.getTime() + Number(m[1]) * 60000);
    if ((m = s.match(/^\+(\d+)\s*(h|小时)$/i))) return new Date(now.getTime() + Number(m[1]) * 3600000);
    if ((m = s.match(/^(\d{1,2})[:：](\d{2})$/))) {
      const d = new Date(now);
      d.setHours(Number(m[1]), Number(m[2]), 0, 0);
      if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
      return d;
    }
    if ((m = s.match(/^(明天|明早|今晚|今天晚上)?\s*(\d{1,2})\s*[点时](\d{1,2})?分?$/))) {
      const day = m[1] || "";
      let h = Number(m[2]);
      const min = Number(m[3] || 0);
      if (h < 0 || h > 23 || min < 0 || min > 59) return null;
      const d = new Date(now);
      if ((day === "今晚" || day === "今天晚上") && h < 12) h += 12;
      d.setHours(h, min, 0, 0);
      if (day === "明天" || day === "明早") d.setDate(d.getDate() + 1);
      else if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
      return d;
    }
    return null;
  }

  function addReminder(whenText, content, qq) {
    const when = parseWhen(whenText);
    if (!when) return null;
    const item = { at: when.getTime(), atText: when.toLocaleString("zh-CN"), content: String(content || "").trim(), qq };
    const list = loadReminders();
    list.push(item);
    saveReminders(list);
    return item;
  }

  function dueReminders(now = Date.now()) {
    const list = loadReminders();
    const due = list.filter((r) => r.at <= now);
    if (due.length) saveReminders(list.filter((r) => r.at > now));
    return due;
  }

  function listReminders() {
    return loadReminders().map((r) => `${r.atText} ${r.content}`);
  }

  // ---------- 表情包整理 ----------
  function deleteSticker(keyword) {
    const kw = String(keyword || "").trim();
    if (!kw) return null;
    const cats = ["happy", "angry", "shy", "confused", "sad", "smug", "speechless", "_inbox"];
    const hits = [];
    for (const c of cats) {
      const dir = path.join(baseDir, "stickers", c);
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!/\.(png|jpe?g|gif|webp)$/i.test(f)) continue;
        if (f.includes(kw)) hits.push({ cat: c, file: f, full: path.join(dir, f) });
      }
    }
    // 关键词没命中文件名，就按分类名删最近收藏的
    if (!hits.length) {
      for (const c of cats) {
        if (kw === c) {
          const dir = path.join(baseDir, "stickers", c);
          if (!fs.existsSync(dir)) continue;
          const list = fs.readdirSync(dir).filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f));
          if (list.length) hits.push({ cat: c, file: list[0], full: path.join(dir, list[0]) });
        }
      }
    }
    if (!hits.length) return null;
    fs.mkdirSync(TRASH, { recursive: true });
    for (const h of hits) {
      try { fs.renameSync(h.full, path.join(TRASH, `${h.cat}__${h.file}`)); } catch {}
    }
    return hits.map((h) => `${h.cat}/${h.file}`);
  }

  return { sysInfoFull, readConfigSafe, readDiary, addReminder, dueReminders, listReminders, deleteSticker, parseWhen };
}
