// openWakeWord "hey jarvis" — a purpose-built wake-word detector that runs the 3-model chain
// (melspectrogram → embedding → wake) on a 16 kHz audio stream and fires ONLY when the phrase
// "hey jarvis" is spoken. Unlike an energy detector, it ignores the room (music, chatter, clicks).
// Models: github.com/dscripka/openWakeWord v0.5.1. Runs on onnxruntime-node CPU.
import ort from "onnxruntime-node";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MODELS = join(dirname(fileURLToPath(import.meta.url)), "models");
const RELEASE = "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1";
const FILES = ["melspectrogram.onnx", "embedding_model.onnx", "hey_jarvis_v0.1.onnx"];
let melSess, embSess, wakeSess, melIn, melOut, embIn, embOut, wakeIn, wakeOut;

async function ensureModels(log) {
  if (!existsSync(MODELS)) mkdirSync(MODELS, { recursive: true });
  for (const f of FILES) {
    const p = join(MODELS, f);
    if (existsSync(p)) continue;
    log(`WAKE downloading ${f} …`);
    const res = await fetch(`${RELEASE}/${f}`);
    if (!res.ok) throw new Error(`download ${f}: HTTP ${res.status}`);
    writeFileSync(p, Buffer.from(await res.arrayBuffer()));
  }
}

export async function loadWakeWord(log = () => {}) {
  if (wakeSess) return;
  await ensureModels(log);
  log("WAKE loading openWakeWord (hey_jarvis) …");
  melSess = await ort.InferenceSession.create(join(MODELS, "melspectrogram.onnx"));
  embSess = await ort.InferenceSession.create(join(MODELS, "embedding_model.onnx"));
  wakeSess = await ort.InferenceSession.create(join(MODELS, "hey_jarvis_v0.1.onnx"));
  [melIn, melOut] = [melSess.inputNames[0], melSess.outputNames[0]];
  [embIn, embOut] = [embSess.inputNames[0], embSess.outputNames[0]];
  [wakeIn, wakeOut] = [wakeSess.inputNames[0], wakeSess.outputNames[0]];
  log("WAKE ready.");
}

// One detector per connection. feed() takes Float32Array @16 kHz with INT16 MAGNITUDE (±32768,
// NOT normalized to ±1 — openWakeWord was trained on raw int16 cast to float). Resolves true on a fire.
export function createDetector({ threshold = 0.5, cooldownMs = 2000 } = {}) {
  const CHUNK = 1280;                 // 80 ms @16k
  const CTX = 480;                    // 3 mel-frames of left context fed to the melspec each chunk
  const MEL_WINDOW = 76, MEL_STRIDE = 8, MEL_MAX = 970;
  const EMB_WINDOW = 16, EMB_MAX = 120;
  let raw = new Float32Array(0);      // pending samples not yet chunked
  let prev = new Float32Array(CTX);   // left context carried between chunks
  let mel = [];                       // [32] mel frames
  let sinceEmb = 0;                   // mel frames since the last embedding
  const emb = [];                     // [96] embeddings, seeded with zeros so the wake model can run immediately
  for (let i = 0; i < EMB_WINDOW; i++) emb.push(new Float32Array(96));
  let lastFire = 0, lastScore = 0;

  async function step(nowMs) {
    let fired = false;
    while (raw.length >= CHUNK) {
      const chunk = raw.slice(0, CHUNK);
      raw = raw.slice(CHUNK);
      const inp = new Float32Array(CTX + CHUNK);
      inp.set(prev); inp.set(chunk, CTX);
      prev = chunk.slice(CHUNK - CTX);
      const melT = await melSess.run({ [melIn]: new ort.Tensor("float32", inp, [1, CTX + CHUNK]) });
      const md = melT[melOut].data;            // [1,1,frames,32]
      const frames = md.length / 32;
      for (let f = 0; f < frames; f++) {
        const fr = new Float32Array(32);
        for (let b = 0; b < 32; b++) fr[b] = md[f * 32 + b] / 10 + 2; // mandatory openWakeWord transform
        mel.push(fr);
      }
      if (mel.length > MEL_MAX) mel.splice(0, mel.length - MEL_MAX);
      sinceEmb += frames;
      while (sinceEmb >= MEL_STRIDE && mel.length >= MEL_WINDOW) {
        sinceEmb -= MEL_STRIDE;
        const flat = new Float32Array(MEL_WINDOW * 32);
        for (let i = 0; i < MEL_WINDOW; i++) flat.set(mel[mel.length - MEL_WINDOW + i], i * 32);
        const embT = await embSess.run({ [embIn]: new ort.Tensor("float32", flat, [1, MEL_WINDOW, 32, 1]) });
        emb.push(Float32Array.from(embT[embOut].data)); // 96-dim
        if (emb.length > EMB_MAX) emb.shift();
        const w = new Float32Array(EMB_WINDOW * 96);
        for (let i = 0; i < EMB_WINDOW; i++) w.set(emb[emb.length - EMB_WINDOW + i], i * 96);
        const wt = await wakeSess.run({ [wakeIn]: new ort.Tensor("float32", w, [1, EMB_WINDOW, 96]) });
        lastScore = wt[wakeOut].data[0];
        if (lastScore >= threshold && nowMs - lastFire > cooldownMs) { lastFire = nowMs; fired = true; }
      }
    }
    return fired;
  }

  return {
    // frame: Float32Array @16k int16-magnitude. nowMs: Date.now(). Resolves true on a "hey jarvis" fire.
    async feed(frame, nowMs) {
      const merged = new Float32Array(raw.length + frame.length);
      merged.set(raw); merged.set(frame, raw.length); raw = merged;
      return step(nowMs);
    },
    score() { return lastScore; },
    reset() {
      raw = new Float32Array(0); prev = new Float32Array(CTX); mel = []; sinceEmb = 0;
      emb.length = 0; for (let i = 0; i < EMB_WINDOW; i++) emb.push(new Float32Array(96));
    },
  };
}
