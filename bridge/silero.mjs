// Silero VAD v5 — a tiny neural speech/no-speech classifier (far more robust than energy thresholding).
// Used to endpoint a command precisely: it knows real speech from background noise, so we can end on a
// short, accurate silence instead of guessing with loudness. Local ONNX, ~2MB. github.com/snakers4/silero-vad
import ort from "onnxruntime-node";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MODEL = join(dirname(fileURLToPath(import.meta.url)), "models", "silero_vad.onnx");
let sess = null;

export async function loadSilero(log = () => {}) {
  if (sess) return;
  log("VAD  loading Silero …");
  sess = await ort.InferenceSession.create(MODEL);
  log("VAD  ready.");
}

// One VAD per connection. feed() takes Float32Array @16k in [-1,1]; returns the latest speech probability.
export function createVAD() {
  const CHUNK = 512, CTX = 64; // Silero v5: 512-sample window @16k, prepended with 64 samples of context
  let buf = new Float32Array(0);
  let ctx = new Float32Array(CTX);
  let state = new ort.Tensor("float32", new Float32Array(2 * 1 * 128), [2, 1, 128]);
  const sr = new ort.Tensor("int64", BigInt64Array.from([16000n]), []);
  let lastProb = 0;
  return {
    async feed(frame) {
      const m = new Float32Array(buf.length + frame.length);
      m.set(buf); m.set(frame, buf.length); buf = m;
      while (buf.length >= CHUNK) {
        const chunk = buf.slice(0, CHUNK); buf = buf.slice(CHUNK);
        const inp = new Float32Array(CTX + CHUNK); inp.set(ctx); inp.set(chunk, CTX);
        ctx = chunk.slice(CHUNK - CTX);
        const out = await sess.run({ input: new ort.Tensor("float32", inp, [1, CTX + CHUNK]), state, sr });
        state = out.stateN;
        lastProb = out.output.data[0];
      }
      return lastProb;
    },
    prob() { return lastProb; },
    reset() { buf = new Float32Array(0); ctx = new Float32Array(CTX); state = new ort.Tensor("float32", new Float32Array(256), [2, 1, 128]); },
  };
}
