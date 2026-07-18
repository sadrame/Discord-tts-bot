import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { writeFile, unlink } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import type { VoiceOption } from "./voices.js";
import { DEFAULT_VOICE } from "./voices.js";

const TIMEOUT_MS = 20_000; // abort a hung TTS call after 20 s

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Strip characters that confuse the Edge TTS WebSocket. */
function sanitizeText(text: string): string {
  return text
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "") // control chars
    .replace(/[^\S\n]+/g, " ")                            // collapse whitespace
    .trim();
}

/**
 * Convert text to an MP3 temp file using a brand-new MsEdgeTTS instance.
 * We NEVER reuse engines — a stale WebSocket is the #1 cause of empty/truncated audio.
 * Retries up to 3 times with exponential back-off.
 * Caller must delete the file via cleanupFile() when done.
 */
export async function textToMp3File(
  text: string,
  voice: VoiceOption = DEFAULT_VOICE
): Promise<string> {
  const clean = sanitizeText(text);
  if (!clean) throw new Error("Text is empty after sanitisation");

  const MAX_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const filePath = join(tmpdir(), `wct-tts-${randomUUID()}.mp3`);

    try {
      // Always create a fresh engine — no caching
      const engine = new MsEdgeTTS();
      await engine.setMetadata(voice.id, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);

      console.log(`[tts] attempt ${attempt} — voice: ${voice.id} — ${clean.length} chars`);

      await Promise.race([
        new Promise<void>((resolve, reject) => {
          const { audioStream } = engine.toStream(clean);
          const chunks: Buffer[] = [];

          audioStream.on("data", (chunk: Buffer) => chunks.push(chunk));
          audioStream.on("end", async () => {
            try {
              const buf = Buffer.concat(chunks);
              if (buf.length === 0) {
                reject(new Error("Empty audio buffer — server returned no audio"));
                return;
              }
              await writeFile(filePath, buf);
              resolve();
            } catch (err) {
              reject(err);
            }
          });
          audioStream.on("error", reject);
        }),

        // Timeout — kills the promise if Edge TTS hangs
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`TTS timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS)
        ),
      ]);

      return filePath; // ✅ success
    } catch (err) {
      await unlink(filePath).catch(() => {});

      if (attempt === MAX_RETRIES) {
        console.error(`[tts] all ${MAX_RETRIES} attempts failed:`, (err as Error).message);
        throw err;
      }

      const delay = attempt * 1500; // 1.5 s, 3 s
      console.warn(`[tts] attempt ${attempt} failed (${(err as Error).message}), retry in ${delay}ms`);
      await sleep(delay);
    }
  }

  throw new Error("TTS failed after all retries");
}

export async function cleanupFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // ignore
  }
}

/**
 * Split text into TTS-friendly chunks at sentence boundaries.
 * Keep chunks ≤400 chars — shorter = less likely for WS to drop mid-stream.
 */
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
