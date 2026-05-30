// Semantic end-of-turn detection — LiveKit turn-detector (Qwen2.5-0.5B fine-tune, EN v1.2.2-en).
// Given the transcript so far, it predicts whether the user has FINISHED their thought, so we can wait
// through a mid-sentence pause ("what's my…") and fire instantly when complete ("what's my revenue").
// Local: onnxruntime-node for the model + transformers.js for the Qwen tokenizer/chat template.
import ort from "onnxruntime-node";
import { AutoTokenizer } from "@huggingface/transformers";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "models");
const ONNX = join(DIR, "turn-detector.onnx");
const URL = "https://huggingface.co/livekit/turn-detector/resolve/v1.2.2-en/onnx/model_q8.onnx";
const THRESHOLD = 0.0289; // EN "unlikely floor": prob >= threshold => user is done
const MAX_TOKENS = 128;
let sess = null, tok = null;

export async function loadTurnDetector(log = () => {}) {
  if (sess) return;
  log("TURN loading end-of-turn model …");
  if (!existsSync(ONNX)) {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
    log("TURN downloading model …");
    const r = await fetch(URL); if (!r.ok) throw new Error("download: HTTP " + r.status);
    writeFileSync(ONNX, Buffer.from(await r.arrayBuffer()));
  }
  tok = await AutoTokenizer.from_pretrained("livekit/turn-detector", { revision: "v1.2.2-en" });
  sess = await ort.InferenceSession.create(ONNX);
  log("TURN ready.");
}

const norm = (s) => (s || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}\s'’-]/gu, "").replace(/\s+/g, " ").trim();

// history: prior [{role,content}] turns (optional). Returns { prob, complete }.
export async function isTurnComplete(userText, history = []) {
  await loadTurnDetector();
  const msgs = [...history, { role: "user", content: norm(userText) }];
  let text = tok.apply_chat_template(msgs, { tokenize: false, add_generation_prompt: false });
  const cut = text.lastIndexOf("<|im_end|>");
  if (cut >= 0) text = text.slice(0, cut); // strip the closing tag so the model predicts whether it comes next
  let ids = tok.encode(text);
  if (ids.length > MAX_TOKENS) ids = ids.slice(ids.length - MAX_TOKENS);
  const input = new ort.Tensor("int64", BigInt64Array.from(ids.map((n) => BigInt(n))), [1, ids.length]);
  const out = await sess.run({ input_ids: input });
  const data = out.prob.data;
  const prob = Number(data[data.length - 1]);
  return { prob, complete: prob >= THRESHOLD };
}
