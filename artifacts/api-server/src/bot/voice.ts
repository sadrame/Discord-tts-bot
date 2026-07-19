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
import { VoiceBasedChannel, TextBasedChannel, Guild, Message as DjsMessage } from "discord.js";
import { textToMp3File, cleanupFile, splitIntoChunks, warmUpVoice } from "./tts.js";
import type { VoiceOption } from "./voices.js";
import { DEFAULT_VOICE } from "./voices.js";
import { saveBookmark, clearBookmark } from "./bookmarks.js";

// ─── Session ──────────────────────────────────────────────────────────────────

export interface ReadSession {
  guildId: string;
  title: string;
  url: string;
  allChunks: string[];
  chunkIndex: number;
  paused: boolean;
  stopped: boolean;
  voiceVersion: number;
  consecutiveSkips: number;
  player: AudioPlayer;
  textChannel: TextBasedChannel;
  /** The live progress bar message — edited in place as reading advances */
  progressMsg: DjsMessage | null;
  /** Timestamp of last progress edit — rate-limit to ≤1 edit per 4 s */
  lastProgressEdit: number;
}

interface ChunkResult {
  file: string;
  chunkIdx: number;
  voiceVersion: number;
}

const sessions  = new Map<string, ReadSession>();
const guildVoices = new Map<string, VoiceOption>();

// ─── Voice preference ─────────────────────────────────────────────────────────

export function getGuildVoice(guildId: string): VoiceOption {
  return guildVoices.get(guildId) ?? DEFAULT_VOICE;
}

export function setGuildVoice(guildId: string, voice: VoiceOption): void {
  guildVoices.set(guildId, voice);
  const session = sessions.get(guildId);
  if (session) {
    session.voiceVersion++;
    session.consecutiveSkips = 0; // reset failure counter on explicit voice change
    session.player.stop();
  }
  warmUpVoice(voice);
  console.log(`[voice] guild ${guildId} → ${voice.id}`);
}

// ─── Session lifecycle ────────────────────────────────────────────────────────

export function getSession(guildId: string): ReadSession | undefined {
  return sessions.get(guildId);
}

export async function stopSession(guildId: string): Promise<void> {
  const session = sessions.get(guildId);
  if (session) {
    session.stopped = true;
    session.player.stop(true);
    // Save bookmark so the user can resume later
    if (session.chunkIndex > 0 && session.chunkIndex < session.allChunks.length) {
      await saveBookmark(
        guildId,
        session.url,
        session.chunkIndex,
        session.allChunks.length,
        session.title,
      ).catch(() => {});
    }
  }
  sessions.delete(guildId);
  getVoiceConnection(guildId)?.destroy();
}

export async function startReading(
  guild: Guild,
  voiceChannel: VoiceBasedChannel,
  textChannel: TextBasedChannel,
  title: string,
  paragraphs: string[],
  url: string,
  resumeFromChunk = 0,
): Promise<void> {
  await stopSession(guild.id);

  const allChunks: string[] = [];
  for (const para of paragraphs) allChunks.push(...splitIntoChunks(para));

  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
  });

  // Send the initial progress bar message ("loading" state)
  const voice = getGuildVoice(guild.id);
  let progressMsg: DjsMessage | null = null;
  try {
    progressMsg = await (textChannel as { send(c: string): Promise<DjsMessage> }).send(
      progressBar(title, resumeFromChunk, allChunks.length, voice, true)
    );
  } catch { /* non-fatal */ }

  const session: ReadSession = {
    guildId: guild.id,
    title,
    url,
    allChunks,
    chunkIndex: resumeFromChunk,
    paused: false,
    stopped: false,
    voiceVersion: 0,
    consecutiveSkips: 0,
    player,
    textChannel,
    progressMsg,
    lastProgressEdit: 0,
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
    await stopSession(guild.id);
    throw new Error("Could not connect to the voice channel within 15 seconds.");
  }

  connection.subscribe(player);
  connection.on(VoiceConnectionStatus.Disconnected, () => stopSession(guild.id));

  runPipeline(session, connection).catch((err) =>
    console.error("[pipeline] uncaught:", err)
  );
}

// ─── Progress bar ─────────────────────────────────────────────────────────────

function progressBar(
  title: string,
  done: number,
  total: number,
  voice: VoiceOption,
  loading = false,
): string {
  const WIDTH = 20;
  const pct   = total > 0 ? Math.round((done / total) * 100) : 0;
  const filled = Math.round((pct / 100) * WIDTH);
  const bar    = "▓".repeat(filled) + "░".repeat(WIDTH - filled);
  const flag   = ({ American: "🇺🇸", British: "🇬🇧", Australian: "🇦🇺", Irish: "🇮🇪" } as Record<string, string>)[voice.accent] ?? "🌐";

  if (loading) {
    return (
      `📖 **${title}**\n` +
      `${"░".repeat(WIDTH)} ⏳ Loading...\n` +
      `🎙️ ${flag} **${voice.label}**`
    );
  }

  return (
    `📖 **${title}**\n` +
    `${bar} **${pct}%** · ${done}/${total} chunks\n` +
    `🎙️ ${flag} **${voice.label}**` +
    (pct === 100 ? " · ✅ Done!" : "")
  );
}

async function updateProgress(session: ReadSession): Promise<void> {
  if (!session.progressMsg) return;
  const now = Date.now();
  if (now - session.lastProgressEdit < 4_000) return; // rate limit: max 1 edit per 4 s
  session.lastProgressEdit = now;

  const voice = getGuildVoice(session.guildId);
  const content = progressBar(
    session.title,
    session.chunkIndex,
    session.allChunks.length,
    voice,
  );
  try {
    await session.progressMsg.edit(content);
  } catch { /* ignore — message might be deleted */ }
}

async function finalizeProgress(session: ReadSession, stopped = false): Promise<void> {
  if (!session.progressMsg) return;
  if (stopped) {
    try { await session.progressMsg.edit(`⏹️ **${session.title}** — stopped.`); } catch { /* ignore */ }
    return;
  }
  const voice = getGuildVoice(session.guildId);
  try {
    await session.progressMsg.edit(
      progressBar(session.title, session.allChunks.length, session.allChunks.length, voice)
    );
  } catch { /* ignore */ }
}

// ─── Pipeline ────────────────────────────────────────────────────────────────

async function runPipeline(session: ReadSession, connection: VoiceConnection): Promise<void> {
  let next = await generateChunk(session);
  // Update bar from "loading" to actual progress now that first chunk is ready
  await updateProgress(session);

  while (next !== null && !session.stopped) {
    // ── Pause ──────────────────────────────────────────────────────────────
    if (session.paused) {
      await cleanupFile(next.file);
      while (session.paused && !session.stopped) await sleep(200);
      if (session.stopped) break;
      next = await generateChunk(session);
      continue;
    }

    const current = next;
    const versionAtKickoff = session.voiceVersion;
    const nextPromise = generateChunk(session); // pre-generate while this chunk plays

    // ── Play ───────────────────────────────────────────────────────────────
    try {
      const resource = createAudioResource(current.file, { inputType: StreamType.Arbitrary });
      session.player.play(resource);
      await entersState(session.player, AudioPlayerStatus.Playing, 10_000);
      await entersState(session.player, AudioPlayerStatus.Idle, 300_000);
    } catch { /* player stopped — ok */ } finally {
      await cleanupFile(current.file);
    }

    // ── Update progress bar ────────────────────────────────────────────────
    await updateProgress(session);

    // ── Voice-change check ─────────────────────────────────────────────────
    const preGen = await nextPromise;

    if (preGen && session.voiceVersion !== versionAtKickoff) {
      // Voice changed while playing — discard stale chunk and re-generate
      await cleanupFile(preGen.file);
      session.chunkIndex = preGen.chunkIdx;
      next = await generateChunk(session);
    } else {
      next = preGen;
    }
  }

  await finalizeProgress(session, session.stopped);

  if (!session.stopped) {
    // Natural completion — clear any saved bookmark for this chapter
    await clearBookmark(session.guildId).catch(() => {});
    stopSession(session.guildId);
  }
}

// ─── Chunk generation ────────────────────────────────────────────────────────

const FALLBACK_THRESHOLD = 3; // consecutive failures before auto-switching to Jenny

async function generateChunk(session: ReadSession): Promise<ChunkResult | null> {
  while (session.chunkIndex < session.allChunks.length) {
    if (session.stopped) return null;

    const chunkIdx        = session.chunkIndex++;
    const text            = session.allChunks[chunkIdx]!;
    const capturedVersion = session.voiceVersion;
    const voice           = getGuildVoice(session.guildId);

    try {
      const file = await textToMp3File(text, voice);
      session.consecutiveSkips = 0; // reset on success
      return { file, chunkIdx, voiceVersion: capturedVersion };
    } catch (err) {
      console.error(`[generateChunk] skip chunk ${chunkIdx}: ${(err as Error).message}`);
      session.consecutiveSkips++;

      // After N consecutive failures on a non-Jenny voice, auto-fall back to Jenny
      // so reading continues rather than the session terminating silently.
      if (
        session.consecutiveSkips >= FALLBACK_THRESHOLD &&
        voice.id !== DEFAULT_VOICE.id
      ) {
        console.warn(`[generateChunk] ${voice.label} unavailable — falling back to Jenny`);
        // setGuildVoice bumps voiceVersion (triggers pipeline regen) and resets counter
        setGuildVoice(session.guildId, DEFAULT_VOICE);
        try {
          await (session.textChannel as { send(c: string): Promise<DjsMessage> }).send(
            `⚠️ Voice **${voice.label}** isn't available right now — switching to **Jenny** to continue reading.`
          );
        } catch { /* ignore */ }
      }
    }
  }
  return null;
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

export function getProgressInfo(guildId: string): { index: number; total: number; title: string; paused: boolean } | null {
  const session = sessions.get(guildId);
  if (!session) return null;
  return { index: session.chunkIndex, total: session.allChunks.length, title: session.title, paused: session.paused };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
