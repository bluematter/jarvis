// Round-trip: Kokoro synthesizes speech -> Whisper transcribes it back. Proves both run locally.
import { warmVoice, transcribe, speak } from "../bridge/voice.mjs";

const t0 = Date.now();
await warmVoice({ voice: process.env.JARVIS_VOICE || "bm_george", log: (m) => console.log("[load]", m) });
console.log(`models ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const phrase = "Systems online. All projects nominal.";
let bytes = 0;
const wavs = [];
const ts = Date.now();
await speak(phrase, (buf) => { bytes += buf.length; wavs.push(buf); });
console.log(`TTS: "${phrase}" -> ${wavs.length} chunk(s), ${bytes} bytes in ${((Date.now() - ts) / 1000).toFixed(1)}s`);

// decode first WAV (16-bit PCM mono) -> downsample to 16k -> transcribe
const wav = wavs[0];
const rate = wav.readUInt32LE(24);
let off = 12;
while (off + 8 <= wav.length && wav.toString("ascii", off, off + 4) !== "data") off += 8 + wav.readUInt32LE(off + 4);
const dataStart = off + 8, n = (wav.length - dataStart) >> 2; // 32-bit float samples
const src = new Float32Array(n);
for (let i = 0; i < n; i++) src[i] = wav.readFloatLE(dataStart + i * 4);
const ratio = rate / 16000, out = new Float32Array(Math.floor(n / ratio));
for (let i = 0; i < out.length; i++) {
  const a = Math.floor(i * ratio), b = Math.min(n, Math.floor((i + 1) * ratio));
  let s = 0; for (let j = a; j < b; j++) s += src[j];
  out[i] = b > a ? s / (b - a) : 0;
}

const tr = Date.now();
const text = await transcribe(out);
console.log(`STT (${rate}Hz->16k): "${text}" in ${((Date.now() - tr) / 1000).toFixed(1)}s`);
console.log(bytes > 1000 && text.length > 3 ? "\n✅ round trip OK" : "\n⚠️ check output");
