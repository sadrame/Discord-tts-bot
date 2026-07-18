import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { writeFile, unlink } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import type { VoiceOption } from "./voices.js";
import { DEFAULT_VOICE } from "./voices.js";

const TIMEOUT_MS = 20_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function sanitizeText(text: string): string {
  return text
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/[^\S\n]+/g, " ")
    .trim();
}

async function synthesize(text: string, voiceId: string, filePath: string): Promise<void> {
  const engine = new MsEdgeTTS();
  await engine.setMetadata(voiceId, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);

  await Promise.race([
    new Promise<void>((resolve, reject) => {
      const { audioStream } = engine.toStream(text);
      const chunks: Buffer[] = [];
      audioStream.on("data", (c: Buffer) => chunks.push(c));
      audioStream.on("end", async () => {
        try {
          const buf = Buffer.concat(chunks);
          if (buf.length === 0) { reject(new Error("Empty audio buffer")); return; }
          await writeFile(filePath, buf);
          resolve();
        } catch (e) { reject(e); }
      });
      audioStream.on("error", reject);
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`TTS timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS)
    ),
  ]);
}

/**
 * Convert text to an MP3 temp file using the requested voice.
 * Retries up to 3 times with the SAME voice — no silent fallback to a
 * different voice, which would override the user's selection.
 * Throws if all retries fail; caller decides whether to skip the chunk.
 */
export async function textToMp3File(
  text: string,
  voice: VoiceOption = DEFAULT_VOICE
): Promise<string> {
  const clean = sanitizeText(text);
  if (!clean) throw new Error("Text is empty after sanitisation");

  let lastErr: Error = new Error("Unknown TTS error");

  for (let attempt = 1; attempt <= 3; attempt++) {
    const filePath = join(tmpdir(), `wct-tts-${randomUUID()}.mp3`);
    try {
      console.log(`[tts] voice=${voice.id} attempt=${attempt} len=${clean.length}`);
      await synthesize(clean, voice.id, filePath);
      return filePath; // ✅
    } catch (err) {
      lastErr = err as Error;
      await unlink(filePath).catch(() => {});
      console.warn(`[tts] attempt ${attempt}/3 failed (${voice.id}): ${lastErr.message}`);
      if (attempt < 3) await sleep(attempt * 800); // 800 ms, 1600 ms
    }
  }

  throw lastErr;
}

export async function cleanupFile(filePath: string): Promise<void> {
  try { await unlink(filePath); } catch { /* ignore */ }
}

export function splitIntoChunks(text: string, maxChars = 400): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+["'\u201C\u201D]?|[^.!?]+$/g) ?? [text];
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (current.length + sentence.length > maxChars) {
      if (current.trim()) chunks.push(current.trim());
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter((c) => c.length > 0);
}

/** Fire-and-forget: open a WebSocket for this voice so it's warm when the pipeline needs it. */
export function warmUpVoice(voice: VoiceOption): void {
  const filePath = join(tmpdir(), `wct-warmup-${randomUUID()}.mp3`);
  const engine = new MsEdgeTTS();
  engine
    .setMetadata(voice.id, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3)
    .then(() => {
      const { audioStream } = engine.toStream("Ready.");
      const chunks: Buffer[] = [];
      audioStream.on("data", (c: Buffer) => chunks.push(c));
      audioStream.on("end", () => unlink(filePath).catch(() => {}));
      audioStream.on("error", () => {});
    })
    .catch(() => {});
  console.log(`[tts] warming up ${voice.id}`);
}
