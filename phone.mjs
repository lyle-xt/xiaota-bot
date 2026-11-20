// 手机控制（ADB）—— 白名单制，无任意命令执行
// 三条紧急关闭：
//   1) C:\QQBot\phone.lock 存在 = 全禁
//   2) state.json 里 phone:false = 全禁
//   3) C:\QQBot\adb\断开手机.bat = 物理断开
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

const ADB = "C:\\QQBot\\adb\\platform-tools\\adb.exe";
const LOCK = "C:\\QQBot\\phone.lock";
const SHOT_DIR = "C:\\QQBot\\_phone";

// —— 硬性黑名单：包名 / 关键词，命中直接拒绝 ——
const BLOCK_PKGS = [
  "com.tencent.mm",            // 微信
  "com.android.settings",      // 系统设置
  "com.android.dialer",        // 拨号
  "com.google.android.dialer",
  "com.android.incallui",      // 通话界面
  "com.android.contacts",      // 通讯录
  "com.android.mms",           // 短信
  "com.android.server.telecom",
];

const BLOCK_WORDS = [
  "tel:", "sms:", "call", "dial", "拨号", "电话", "微信", "wechat",
  "settings", "设置", "contacts", "通讯录", "sms", "短信",
  "input", "text", "passwd", "password", "密码", "keyevent 7",
  "su", "root", "rm ", "reboot", "pm grant", "monkey",
];

// 允许打开的包（白名单，可在 config 里扩展）
const DEFAULT_ALLOW_PKGS = [
  "com.netease.cloudmusic",   // 网易云音乐
  "com.tencent.qqmusic",      // QQ音乐
  "com.ximalaya.ting.android",// 喜马拉雅
  "tv.danmaku.bili",          // B站
  "com.tencent.mobileqq",     // QQ（手机版）
];

/** 键位码：只允许这几个 */
const KEYCODES = {
  play_pause: "85",
  next: "87",
  prev: "88",
  volup: "24",
  voldown: "25",
  mute: "164",
  wake: "224",
  home: "3",
  back: "4",
};

function run(args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(ADB, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || "").trim(), err: err ? String(stderr || err.message).trim() : "" });
    });
  });
}

export function createPhone(getConfig, isEnabled) {
  function blocked() {
    if (fs.existsSync(LOCK)) return "手机控制已被锁定（phone.lock 存在）";
    if (!isEnabled()) return "手机控制开关是关着的";
    return null;
  }

  function looksBlocked(str) {
    const s = String(str || "").toLowerCase();
    return BLOCK_WORDS.some((w) => s.includes(w.toLowerCase()));
  }

  async function devices() {
    const r = await run(["devices"]);
    return r.out.split("\n").slice(1).map((l) => l.trim()).filter(Boolean);
  }

  async function connected() {
    const d = await devices();
    return d.some((l) => l.endsWith("device"));
  }

  /** 统一入口：只接受白名单动作 */
  async function exec(action, arg) {
    const b = blocked();
    if (b) return { ok: false, msg: b };

    const act = String(action || "").trim().toLowerCase();
    if (looksBlocked(act) || looksBlocked(arg)) {
      return { ok: false, msg: "这个操作被隐私规则拦下了" };
    }

    // —— 参数校验放在"是否连上"之前，保证黑名单优先拦截 ——
    if (act === "open") {
      const pkg = String(arg || "").trim();
      if (!/^[a-zA-Z0-9_.]+$/.test(pkg)) return { ok: false, msg: "包名不合法" };
      if (BLOCK_PKGS.some((b) => pkg === b || pkg.startsWith(b + "."))) {
        return { ok: false, msg: "这个 App 在屏蔽名单里（微信/拨号/设置/短信/通讯录）" };
      }
      const allowed = new Set([...DEFAULT_ALLOW_PKGS, ...(getConfig()?.phone?.allowPackages || [])]);
      if (!allowed.has(pkg)) return { ok: false, msg: "这个 App 不在白名单里" };
    }
    if (act === "key") {
      const k = String(arg || "").trim().toLowerCase();
      if (!KEYCODES[k]) return { ok: false, msg: "不支持的按键" };
    }
    if (!["status", "shot", "key", "open"].includes(act)) {
      return { ok: false, msg: "不认识这个手机指令" };
    }

    if (!(await connected())) return { ok: false, msg: "手机没连上，先开无线调试" };

    // 1) 状态查询
    if (act === "status") {
      const bat = await run(["shell", "dumpsys", "battery"]);
      const level = (bat.out.match(/level:\s*(\d+)/) || [])[1] || "?";
      const model = await run(["shell", "getprop", "ro.product.model"]);
      const scr = await run(["shell", "dumpsys", "power"]);
      const on = /mWakefulness=Awake/.test(scr.out) ? "亮屏" : "息屏";
      return { ok: true, msg: `电量 ${level}%，${on}，机型 ${model.out}` };
    }

    // 2) 截图
    if (act === "shot") {
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      const remote = "/sdcard/_xiaota_shot.png";
      const local = path.join(SHOT_DIR, `shot_${Date.now()}.png`);
      const a = await run(["shell", "screencap", "-p", remote]);
      if (!a.ok) return { ok: false, msg: "截图失败" };
      const b2 = await run(["pull", remote, local], 20000);
      await run(["shell", "rm", "-f", remote]);
      if (!b2.ok || !fs.existsSync(local)) return { ok: false, msg: "取回截图失败" };
      return { ok: true, msg: "截图好了", file: local };
    }

    // 3) 媒体/按键（只允许 KEYCODES 里的）
    if (act === "key") {
      const code = KEYCODES[String(arg || "").trim().toLowerCase()];
      if (!code) return { ok: false, msg: "不支持的按键" };
      const r = await run(["shell", "input", "keyevent", code]);
      return { ok: r.ok, msg: r.ok ? "按了" : "按键失败" };
    }

    // 4) 打开 App（白名单包名）
    if (act === "open") {
      const pkg = String(arg || "").trim();
      const r = await run(["shell", "monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1"]);
      return { ok: r.ok, msg: r.ok ? `打开了 ${pkg}` : "打开失败" };
    }

    return { ok: false, msg: "不认识这个手机指令" };
  }

  async function connect(hostPort) {
    const hp = String(hostPort || "").trim();
    if (!/^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/.test(hp)) return { ok: false, msg: "格式应为 IP:端口" };
    const r = await run(["connect", hp], 20000);
    return { ok: r.ok && /connected/.test(r.out), msg: r.out || r.err };
  }

  async function disconnectAll() {
    const r = await run(["disconnect"]);
    return { ok: true, msg: r.out || "已断开" };
  }

  function lockedNow() {
    return fs.existsSync(LOCK);
  }

  return { exec, connect, disconnectAll, connected, devices, lockedNow };
}

export { BLOCK_PKGS, BLOCK_WORDS, DEFAULT_ALLOW_PKGS };
