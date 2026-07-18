import {
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  AudioPlayer,
  AudioPlayerStatus,
  VoiceConnection,
} from "@discordjs/voice";
import { VoiceBasedChannel, TextBasedChannel, Guild } from "discord.js";
import { textToMp3File, cleanupFile, splitIntoChunks, warmUpVoice } from "./tts.js";
import type { VoiceOption } from "./voices.js";
import { DEFAULT_VOICE } from "./voices.js";

// ─── Session ──────────────────────────────────────────────────────────────────

export interface ReadSession {
  guildId: string;
  title: string;
  allChunks: string[];
  chunkIndex: number;
  paused: boolean;
  stopped: boolean;
  /** Incremented every time the voice changes — lets the pipeline detect stale pre-gens */
  voiceVersion: number;
  player: AudioPlayer;
  textChannel: TextBasedChannel;
}

interface ChunkResult {
  file: string;
  /** The chunk index this file covers (for backtracking after a voice change) */
  chunkIdx: number;
  /** Voice version active when generation started */
  voiceVersion: number;
}

const sessions = new Map<string, ReadSession>();
const guildVoices = new Map<string, VoiceOption>();

// ─── Voice preference ─────────────────────────────────────────────────────────

export function getGuildVoice(guildId: string): VoiceOption {
  return guildVoices.get(guildId) ?? DEFAULT_VOICE;
}

export function setGuildVoice(guildId: string, voice: VoiceOption): void {
  guildVoices.set(guildId, voice);

  const session = sessions.get(guildId);
  if (session) {
    // Bump version so the pipeline discards any pre-buffered old-voice chunk
    session.voiceVersion++;
    // Stop the current chunk immediately → creates the "quick pause" before new voice
    session.player.stop();
  }

  // Pre-warm the WebSocket so it's ready when the pipeline hits the next chunk
  warmUpVoice(voice);
  console.log(`[voice] guild ${guildId} → ${voice.id} (version ${session?.voiceVersion ?? 0})`);
}

// ─── Session lifecycle ────────────────────────────────────────────────────────

export function getSession(guildId: string): ReadSession | undefined {
  return sessions.get(guildId);
}

export function stopSession(guildId: string): void {
  const session = sessions.get(guildId);
  if (session) {
    session.stopped = true;
    session.player.stop(true);
  }
  sessions.delete(guildId);
  getVoiceConnection(guildId)?.destroy();
}

export async function startReading(
  guild: Guild,
  voiceChannel: VoiceBasedChannel,
  textChannel: TextBasedChannel,
  title: string,
  paragraphs: string[]
): Promise<void> {
  stopSession(guild.id);

  const allChunks: string[] = [];
  for (const para of paragraphs) allChunks.push(...splitIntoChunks(para));

  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
  });

  const session: ReadSession = {
    guildId: guild.id,
    title,
    allChunks,
    chunkIndex: 0,
    paused: false,
    stopped: false,
    voiceVersion: 0,
    player,
    textChannel,
  };

  sessions.set(guild.id, session);

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  } catch {
    stopSession(guild.id);
    throw new Error("Could not connect to the voice channel within 15 seconds.");
  }

  connection.subscribe(player);
  connection.on(VoiceConnectionStatus.Disconnected, () => stopSession(guild.id));

  runPipeline(session, connection).catch((err) =>
    console.error("[pipeline] uncaught:", err)
  );
}

// ─── Pipelined reading loop ───────────────────────────────────────────────────
//
// While chunk N is *playing*, chunk N+1 is already being *generated*.
// On voice switch: current chunk stops immediately (player.stop in setGuildVoice),
// voiceVersion bumps, and any pre-generated stale chunk is discarded + re-generated
// with the new voice before playback resumes.

async function runPipeline(session: ReadSession, connection: VoiceConnection): Promise<void> {
  let next = await generateChunk(session);

  while (next !== null && !session.stopped) {
    // ── Pause handling ──────────────────────────────────────────────────────
    if (session.paused) {
      await cleanupFile(next.file);
      while (session.paused && !session.stopped) await sleep(200);
      if (session.stopped) break;
      next = await generateChunk(session);
      continue;
    }

    const current = next;
    const versionAtKickoff = session.voiceVersion;

    // Kick off next chunk generation in parallel while this one plays
    const nextPromise = generateChunk(session);

    // ── Play current chunk ──────────────────────────────────────────────────
    try {
      const resource = createAudioResource(current.file, { inputType: StreamType.Arbitrary });
      session.player.play(resource);
      await entersState(session.player, AudioPlayerStatus.Playing, 10_000);
      await entersState(session.player, AudioPlayerStatus.Idle, 300_000);
    } catch {
      // Player was stopped (e.g. voice change) — that's fine, continue
    } finally {
      await cleanupFile(current.file);
    }

    // ── Voice-change check ──────────────────────────────────────────────────
    // Wait for the pre-gen to finish regardless so we can clean it up if needed
    const preGen = await nextPromise;

    if (preGen && session.voiceVersion !== versionAtKickoff) {
      // Voice changed while we were playing — the pre-gen used the wrong voice.
      // Discard it, back up the chunk index to that position, and re-generate.
      await cleanupFile(preGen.file);
      session.chunkIndex = preGen.chunkIdx; // rewind to that chunk
      next = await generateChunk(session);
    } else {
      next = preGen;
    }
  }

  if (!session.stopped) {
    await safeSend(session.textChannel, `✅ Finished reading **${session.title}**!`);
    stopSession(session.guildId);
  }
}

// ─── Chunk generation ─────────────────────────────────────────────────────────

async function generateChunk(session: ReadSession): Promise<ChunkResult | null> {
  // Find the next non-empty chunk
  while (session.chunkIndex < session.allChunks.length) {
    if (session.stopped) return null;

    const chunkIdx = session.chunkIndex++;
    const text = session.allChunks[chunkIdx]!;
    const capturedVersion = session.voiceVersion;

    // Progress update every 20 chunks
    if (chunkIdx > 0 && chunkIdx % 20 === 0) {
      const pct = Math.round((chunkIdx / session.allChunks.length) * 100);
      safeSend(session.textChannel, `📖 ${pct}% through **${session.title}**`).catch(() => {});
    }

    const voice = getGuildVoice(session.guildId);

    try {
      const file = await textToMp3File(text, voice);
      return { file, chunkIdx, voiceVersion: capturedVersion };
    } catch (err) {
      // textToMp3File already tried the fallback voice internally — if it still
      // throws, just skip this chunk silently and move on
      console.error(`[generateChunk] skipping chunk ${chunkIdx}: ${(err as Error).message}`);
    }
  }

  return null; // all chunks exhausted
}

// ─── Controls ────────────────────────────────────────────────────────────────

export function pauseSession(guildId: string): boolean {
  const session = sessions.get(guildId);
  if (!session || session.paused) return false;
  session.paused = true;
  session.player.pause();
  return true;
}

export function resumeSession(guildId: string): boolean {
  const session = sessions.get(guildId);
  if (!session || !session.paused) return false;
  session.paused = false;
  session.player.unpause();
  return true;
}

export function skipParagraph(guildId: string): boolean {
  const session = sessions.get(guildId);
  if (!session) return false;
  session.chunkIndex = Math.min(session.chunkIndex + 10, session.allChunks.length);
  session.player.stop();
  return true;
}

export function getProgressInfo(
  guildId: string
): { index: number; total: number; title: string; paused: boolean } | null {
  const session = sessions.get(guildId);
  if (!session) return null;
  return {
    index: session.chunkIndex,
    total: session.allChunks.length,
    title: session.title,
    paused: session.paused,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function safeSend(channel: TextBasedChannel, content: string): Promise<void> {
  try {
    if ("send" in channel) {
      await (channel as { send(content: string): Promise<unknown> }).send(content);
    }
  } catch (err) {
    console.error("[safeSend]", err);
  }
}
