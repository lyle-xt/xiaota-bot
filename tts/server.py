# -*- coding: utf-8 -*-
"""
本地 TTS 服务 —— CosyVoice2 零样本克隆（GPU）
配置：参考音频 ref.wav + 温柔轻快指令，输出与 B3 完全一致
接口：
  POST /tts   {"text": "...", "instruct": "可选", "speed": 1.0}  -> WAV
  GET  /health
"""
import os, sys, io, json, time, threading, traceback, warnings, subprocess, tempfile
warnings.filterwarnings("ignore")

BASE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(BASE, "cosy_src", "CosyVoice-main")
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "third_party", "Matcha-TTS"))
FFMPEG = r"D:\新建文件夹\winziper\ffmpeg.exe"
os.environ["PATH"] = os.path.dirname(FFMPEG) + os.pathsep + os.environ.get("PATH", "")

import torch
import torchaudio
import numpy as np
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("TTS_PORT", "8808"))
MODEL_DIR = os.path.join(ROOT, "pretrained_models", "CosyVoice2-0.5B")
REF = os.path.join(BASE, "ref.wav")
# 必须留空：CosyVoice2-0.5B 不支持 instruct 模式，非空会把指令念出来
DEFAULT_INSTRUCT = os.environ.get("TTS_INSTRUCT", "")

print("[tts] 加载 CosyVoice2 ...", flush=True)
t0 = time.time()
from cosyvoice.cli.cosyvoice import CosyVoice2

cosy = CosyVoice2(MODEL_DIR, load_jit=False, load_trt=False, fp16=False)
print(f"[tts] 加载完成 {time.time()-t0:.1f}s  sr={cosy.sample_rate}", flush=True)

LOCK = threading.Lock()


def pitch_shift(wav_bytes: bytes, ratio: float, sr: int) -> bytes:
    """升高音高但保持时长（asetrate + atempo 抵消）"""
    if abs(ratio - 1.0) < 0.01:
        return wav_bytes
    tmpdir = tempfile.mkdtemp(prefix="ttsp_")
    src = os.path.join(tmpdir, "in.wav")
    dst = os.path.join(tmpdir, "out.wav")
    try:
        with open(src, "wb") as f:
            f.write(wav_bytes)
        af = f"asetrate={int(sr*ratio)},aresample={sr},atempo={1.0/ratio:.6f}"
        subprocess.run(
            [FFMPEG, "-y", "-i", src, "-af", af, "-ar", str(sr), "-ac", "1", dst],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60, check=True,
        )
        with open(dst, "rb") as f:
            return f.read()
    finally:
        for p in (src, dst):
            try: os.remove(p)
            except OSError: pass
        try: os.rmdir(tmpdir)
        except OSError: pass


def synth(text: str, instruct: str, speed: float, prompt_text: str = "") -> bytes:
    with LOCK:
        chunks = []
        if prompt_text:
            # 零样本复刻：参考文本准确时韵律最自然，且不会念出指令
            gen = cosy.inference_zero_shot(text, prompt_text, REF, stream=False, speed=speed)
        elif instruct:
            gen = cosy.inference_instruct2(text, instruct, REF, stream=False, speed=speed)
        else:
            gen = cosy.inference_cross_lingual(text, REF, stream=False, speed=speed)
        for out in gen:
            chunks.append(out["tts_speech"].cpu().numpy().reshape(-1))
    if not chunks:
        raise RuntimeError("合成结果为空")
    audio = np.concatenate(chunks).astype(np.float32)
    buf = io.BytesIO()
    import soundfile as sf
    sf.write(buf, audio, cosy.sample_rate, format="WAV", subtype="PCM_16")
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            info = {
                "ok": True,
                "engine": "CosyVoice2",
                "device": "cuda" if torch.cuda.is_available() else "cpu",
                "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
                "vram_mb": round(torch.cuda.memory_allocated() / 1024 / 1024, 1) if torch.cuda.is_available() else 0,
                "instruct": DEFAULT_INSTRUCT,
            }
            self._send(200, json.dumps(info, ensure_ascii=False).encode("utf-8"))
        else:
            self._send(404, b'{"error":"not found"}')

    def do_POST(self):
        if not self.path.startswith("/tts"):
            self._send(404, b'{"error":"not found"}')
            return
        try:
            n = int(self.headers.get("Content-Length", "0"))
            req = json.loads(self.rfile.read(n).decode("utf-8"))
            text = (req.get("text") or "").strip()
            if not text:
                self._send(400, b'{"error":"empty text"}')
                return
            instruct = (req.get("instruct") or DEFAULT_INSTRUCT).strip()
            prompt_text = (req.get("promptText") or "").strip()
            speed = float(req.get("speed") or 1.0)
            pitch = float(req.get("pitch") or 1.0)
            t = time.time()
            wav = synth(text[:150], instruct, speed, prompt_text)
            wav = pitch_shift(wav, pitch, cosy.sample_rate)
            print(f"[tts] 合成 {len(text)} 字 -> {len(wav)/1024:.0f}KB  用时 {time.time()-t:.2f}s", flush=True)
            self._send(200, wav, "audio/wav")
        except Exception as e:
            traceback.print_exc()
            self._send(500, json.dumps({"error": str(e)}, ensure_ascii=False).encode("utf-8"))


if __name__ == "__main__":
    print(f"[tts] 监听 http://127.0.0.1:{PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
