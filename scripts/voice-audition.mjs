// Synthesize one JARVIS-style line in each British-male Kokoro voice so you can pick by ear.
// Run: node scripts/voice-audition.mjs   then play: afplay /tmp/jarvis-voice-<name>.wav
import { KokoroTTS } from "kokoro-js";

const tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "fp16" });
const line = "Good evening, sir. Revenue is up twelve percent today. Shall I pull the full briefing?";
const voices = ["bm_george", "bm_fable", "bm_lewis", "bm_daniel"];

for (const v of voices) {
  const audio = await tts.generate(line, { voice: v, speed: 1.0 });
  await audio.save(`/tmp/jarvis-voice-${v}.wav`);
  console.log("wrote /tmp/jarvis-voice-" + v + ".wav");
}
console.log("\nPlay all four:  for v in bm_george bm_fable bm_lewis bm_daniel; do echo $v; afplay /tmp/jarvis-voice-$v.wav; done");
