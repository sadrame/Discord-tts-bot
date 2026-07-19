import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { writeFile, unlink } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import type { VoiceOption } from "./voices.js";
import { DEFAULT_VOICE } from "./voices.js";

const TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function sanitizeText(text: string): string {
  return text
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/[^\S\n]+/g, " ")
    .trim();
}

// ─── Single shared WebSocket engine ──────────────────────────────────────────
// ONE MsEdgeTTS instance for ALL voices.
// When the voice changes, setMetadata() triggers ONE reconnect.
// When the voice stays the same, the open connection is reused (zero overhead).
// This avoids the rapid reconnect rate-limiting that broke non-Jenny voices.
let sharedEngine: MsEdgeTTS | null = null;
let engineVoiceId: string | null = null; // tracks what voice the engine is set to

async function getEngine(voiceId: string): Promise<MsEdgeTTS> {
  if (sharedEngine && engineVoiceId === voiceId) {
    // Same voice — reuse the open connection
    return sharedEngine;
  }

  if (!sharedEngine) {
    sharedEngine = new MsEdgeTTS();
    console.log("[tts] Creating new MsEdgeTTS instance");
  }

  // Voice changed (or first init) — setMetadata reconnects once
  await sharedEngine.setMetadata(voiceId, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
  engineVoiceId = voiceId;
  console.log(`[tts] WebSocket set to voice: ${voiceId}`);
  return sharedEngine;
}

function invalidateEngine(): void {
  sharedEngine = null;
  engineVoiceId = null;
  console.log("[tts] WebSocket invalidated — will reconnect on next request");
}

// ─── Global TTS semaphore ─────────────────────────────────────────────────────
// ONE synthesis at a time. Held for the entire textToMp3File call (all retries).
let ttsInFlight = false;
const ttsQueue: Array<() => void> = [];

async function acquireTts(): Promise<void> {
  if (!ttsInFlight) { ttsInFlight = true; return; }
  await new Promise<void>((resolve) => ttsQueue.push(resolve));
}

function releaseTts(): void {
  const next = ttsQueue.shift();
  if (next) { next(); } else { ttsInFlight = false; }
}

// ─── Low-level synthesis ──────────────────────────────────────────────────────

async function synthesize(text: string, voiceId: string, filePath: string): Promise<void> {
  const engine = await getEngine(voiceId);

  await Promise.race([
    new Promise<void>((resolve, reject) => {
      // toStream() uses the voice already set via setMetadata() above.
      // The engine's voice matches voiceId — no SSML tricks needed.
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

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Convert text to an MP3 temp file.
 *
 * Uses a single shared WebSocket. When the voice changes, setMetadata()
 * triggers exactly ONE reconnect — safe and not rate-limited. On failure,
 * the engine is invalidated and reconnected fresh on the next attempt.
 * The global semaphore ensures only one synthesis is in-flight at a time.
 */
export async function textToMp3File(
  text: string,
  voice: VoiceOption = DEFAULT_VOICE,
): Promise<string> {
  const clean = sanitizeText(text);
  if (!clean) throw new Error("Text is empty after sanitisation");

  await acquireTts();
  try {
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
        // Invalidate the shared engine — stale or rate-limited connection.
        // Next attempt creates a fresh WebSocket with the correct voice.
        invalidateEngine();
        console.warn(`[tts] attempt ${attempt}/3 failed (${voice.id}): ${lastErr.message}`);
        if (attempt < 3) await sleep(2_000);
      }
    }

    throw lastErr;
  } finally {
    releaseTts();
  }
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

/** No-op — kept for import compatibility. */
export function warmUpVoice(_voice: VoiceOption): void {
  // Intentionally empty
}
