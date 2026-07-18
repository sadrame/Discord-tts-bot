import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { writeFile, unlink } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import type { VoiceOption } from "./voices.js";
import { DEFAULT_VOICE } from "./voices.js";

const TIMEOUT_MS = 25_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function sanitizeText(text: string): string {
  return text
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/[^\S\n]+/g, " ")
    .trim();
}

// ─── Persistent engine cache ──────────────────────────────────────────────────
// Re-using the same MsEdgeTTS instance keeps the WebSocket alive across chunks,
// avoiding the per-chunk reconnect that causes Microsoft to rate-limit us.
// On any failure the entry is evicted so the next attempt gets a fresh socket.
const engineCache = new Map<string, MsEdgeTTS>();

async function getEngine(voiceId: string): Promise<MsEdgeTTS> {
  const cached = engineCache.get(voiceId);
  if (cached) return cached;

  const engine = new MsEdgeTTS();
  await engine.setMetadata(voiceId, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
  engineCache.set(voiceId, engine);
  console.log(`[tts] new WS connection for ${voiceId}`);
  return engine;
}

function evictEngine(voiceId: string): void {
  engineCache.delete(voiceId);
}

// ─── Global TTS semaphore ─────────────────────────────────────────────────────
// Only ONE synthesis runs at a time. Acquired ONCE per textToMp3File call
// (covering all retries) so retries never let another caller sneak in.
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
 * - Reuses a cached MsEdgeTTS instance (persistent WebSocket) per voice to
 *   avoid Microsoft rate-limiting from repeated connection handshakes.
 * - Evicts the cached instance on failure so the next retry gets a fresh socket.
 * - Holds the global semaphore for all retries so no other synthesis can
 *   interleave — concurrent WebSockets to Edge TTS cause "stream closed".
 */
export async function textToMp3File(
  text: string,
  voice: VoiceOption = DEFAULT_VOICE
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
        // Evict the cached engine — the WebSocket is likely dead or blacklisted.
        // Next attempt (or next call) will open a fresh connection.
        evictEngine(voice.id);
        console.warn(`[tts] attempt ${attempt}/3 failed (${voice.id}): ${lastErr.message}`);
        if (attempt < 3) await sleep(1_500);
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
  // Intentionally empty — concurrent connections break Edge TTS
}
