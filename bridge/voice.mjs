// Local, offline voice — runs entirely in Node as ONNX. No Python, no cloud.
//   STT: Whisper via @huggingface/transformers
//   TTS: Kokoro-82M via kokoro-js
// Models download once on first use to the HF cache, then run locally.

import { pipeline } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";

let transcriber = null;
let tts = null;
let voice = "bm_george";
let speed = 1.12; // slightly quicker than 1.0 — more natural, less ponderous
let readyPromise = null;

export function warmVoice(opts = {}) {
  if (readyPromise) return readyPromise;
  const {
    sttModel = "onnx-community/whisper-base.en",
    ttsModel = "onnx-community/Kokoro-82M-v1.0-ONNX",
    dtype = "q8",
    voice: v = "bm_george",
    speed: sp = 1.12,
    log = () => {},
  } = opts;
  voice = v;
  speed = sp;
  readyPromise = (async () => {
    log(`STT  loading ${sttModel} …`);
    transcriber = await pipeline("automatic-speech-recognition", sttModel, { dtype: "q8" });
    log(`TTS  loading ${ttsModel} (${voice}) …`);
    tts = await KokoroTTS.from_pretrained(ttsModel, { dtype });
    log(`voice ready.`);
  })();
  return readyPromise;
}

// audio: Float32Array mono @ 16 kHz, samples in [-1, 1]
export async function transcribe(audio) {
  await warmVoice();
  const out = await transcriber(audio);
  return (out?.text || "").trim();
}

// Streams one WAV Buffer per sentence to onChunk so playback starts before
// the whole reply is synthesized (lower perceived latency).
export async function speak(text, onChunk) {
  await warmVoice();
  for (const part of splitSentences(text)) {
    const audio = await tts.generate(part, { voice, speed });
    onChunk(Buffer.from(audio.toWav()));
  }
}

function splitSentences(t) {
  const parts = (t.match(/[^.!?\n]+[.!?]*/g) || [t]).map((s) => s.trim()).filter(Boolean);
  // merge tiny fragments so we don't synth one-word clips
  const out = [];
  for (const p of parts) {
    if (out.length && (out[out.length - 1].length < 24 || p.length < 24)) out[out.length - 1] += " " + p;
    else out.push(p);
  }
  return out.length ? out : [t];
}
