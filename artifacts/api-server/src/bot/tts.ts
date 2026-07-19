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

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Build SSML with the specific voice embedded.
 * Using rawToStream() with this SSML lets us use ANY voice on a SINGLE shared
 * WebSocket — no reconnection needed when the voice changes.
 */
function buildSsml(text: string, voiceId: string): string {
  // Infer locale from voice ID: "en-US-JennyNeural" → "en-US"
  const locale = voiceId.match(/^([a-z]{2}-[A-Z]{2})/)?.[1] ?? "en-US";
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" ` +
    `xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${locale}">` +
    `<voice name="${voiceId}">${escapeXml(text)}</voice>` +
    `</speak>`
  );
}

// ─── Single shared WebSocket engine ──────────────────────────────────────────
// ONE MsEdgeTTS instance for ALL voices.
// Voice is specified per-request via SSML (<voice name="...">) using rawToStream().
// This avoids the per-voice reconnect that causes Microsoft to block connections.
let sharedEngine: MsEdgeTTS | null = null;

async function getEngine(): Promise<MsEdgeTTS> {
  if (sharedEngine) return sharedEngine;
  const engine = new MsEdgeTTS();
  // Connect with Jenny — actual voice is overridden per-request in the SSML
  await engine.setMetadata(DEFAULT_VOICE.id, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
  sharedEngine = engine;
  console.log("[tts] WebSocket established (shared for all voices)");
  return engine;
}

function invalidateEngine(): void {
  sharedEngine = null;
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
  const engine = await getEngine();
  const ssml   = buildSsml(text, voiceId);

  await Promise.race([
    new Promise<void>((resolve, reject) => {
      // rawToStream sends our pre-built SSML directly — voice name is inside it,
      // so any of the 20+ voices work without a new WebSocket connection.
      const { audioStream } = engine.rawToStream(ssml);
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
 * Uses a single shared WebSocket (rawToStream + per-request SSML) so all
 * voices work without reconnecting. Retries invalidate and reconnect on failure.
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
        // Next attempt creates a fresh WebSocket.
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
