// 小塔的长期记忆：事实库 / 事件时间线 / 待办话题
import fs from "node:fs";
import path from "node:path";

export function createStore(baseDir) {
  const FACTS = path.join(baseDir, "facts.json");
  const EVENTS = path.join(baseDir, "events.jsonl");
  const TODO = path.join(baseDir, "todo.json");

  const CATS = ["称呼", "雷点", "喜好", "作息", "约定", "其他"];

  function readJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      try { return JSON.parse(fs.readFileSync(file + ".bak", "utf8")); } catch { return fallback; }
    }
  }
  function writeJson(file, obj) {
    // 原子写：先写 .tmp 再重命名，断电不会留下半截文件
    try {
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
      try { if (fs.existsSync(file)) fs.copyFileSync(file, file + ".bak"); } catch {}
      fs.renameSync(tmp, file);
    } catch {}
  }

  // ---------- 事实库 ----------
  let facts = readJson(FACTS, null);
  if (!facts || typeof facts !== "object") {
    facts = {};
    for (const c of CATS) facts[c] = [];
    writeJson(FACTS, facts);
  }

  function addFact(cat, text) {
    const c = CATS.includes(cat) ? cat : "其他";
    const t = String(text || "").trim();
    if (!t) return false;
    if (!facts[c]) facts[c] = [];
    // 去重：完全相同、互相包含、或字符重合度 > 60% 都算重复
    const sim = (a, b) => {
      const sa = new Set(String(a).replace(/[^\u4e00-\u9fa5a-z0-9]/gi, ""));
      const sb = new Set(String(b).replace(/[^\u4e00-\u9fa5a-z0-9]/gi, ""));
      if (!sa.size || !sb.size) return 0;
      let hit = 0;
      for (const ch of sa) if (sb.has(ch)) hit++;
      return hit / Math.min(sa.size, sb.size);
    };
    if (facts[c].some((x) => x === t || x.includes(t) || t.includes(x) || sim(x, t) > 0.6)) return false;
    facts[c].push(t);
    // 限流：每类最多 6 条，全局最多 30 条（防止越聊越多）
    const MAX_PER_CAT = 6, MAX_TOTAL = 30;
    if (facts[c].length > MAX_PER_CAT) facts[c] = facts[c].slice(-MAX_PER_CAT);
    let total = 0;
    for (const k of CATS) total += (facts[k] || []).length;
    if (total > MAX_TOTAL) {
      for (const k of CATS) {
        const over = total - MAX_TOTAL;
        if (over <= 0) break;
        const arr = facts[k] || [];
        if (arr.length > 1) { facts[k] = arr.slice(1); total--; }
      }
    }
    writeJson(FACTS, facts);
    return true;
  }

  function factsText() {
    const lines = [];
    for (const c of CATS) {
      const arr = (facts[c] || []).filter(Boolean);
      if (arr.length) lines.push(`- ${c}：${arr.join("、")}`);
    }
    return lines.length ? `\n\n【关于对方的档案（长期记住）】\n${lines.join("\n")}` : "";
  }

  // ---------- 事件时间线 ----------
  function addEvent(text) {
    const t = String(text || "").trim();
    if (!t) return false;
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    try { fs.appendFileSync(EVENTS, JSON.stringify({ t: stamp, text: t }) + "\n", "utf8"); } catch { return false; }
    return true;
  }

  function recentEvents(n = 8) {
    try {
      const lines = fs.readFileSync(EVENTS, "utf8").split("\n").filter(Boolean);
      return lines.slice(-n).map((l) => {
        try { const j = JSON.parse(l); return `- ${j.t} ${j.text}`; } catch { return null; }
      }).filter(Boolean);
    } catch { return []; }
  }

  function eventsText(n = 8) {
    const arr = recentEvents(n);
    return arr.length ? `\n\n【你们之间发生过的事（可回忆）】\n${arr.join("\n")}` : "";
  }

  // ---------- 待办话题 ----------
  let todo = readJson(TODO, []);
  if (!Array.isArray(todo)) todo = [];

  function addTodo(text) {
    const t = String(text || "").trim();
    if (!t) return false;
    if (todo.includes(t)) return false;
    todo.push(t);
    writeJson(TODO, todo);
    return true;
  }

  function doneTodo(text) {
    const t = String(text || "").trim();
    const i = todo.findIndex((x) => x === t || x.includes(t) || t.includes(x));
    if (i < 0) return false;
    todo.splice(i, 1);
    writeJson(TODO, todo);
    return true;
  }

  function todoText() {
    if (!todo.length) return "";
    return `\n\n【还欠着的话题（可以主动提起）】\n` + todo.map((x) => `- ${x}`).join("\n");
  }

  function randomTodo() {
    return todo.length ? todo[Math.floor(Math.random() * todo.length)] : null;
  }

  return { addFact, factsText, addEvent, eventsText, recentEvents, addTodo, doneTodo, todoText, randomTodo, facts, todo };
}
