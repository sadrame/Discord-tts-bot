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
import { VoiceBasedChannel, TextBasedChannel, Guild, Message as DjsMessage, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
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
    progressMsg = await (textChannel as any).send(
      progressPayload(title, allChunks, resumeFromChunk, voice, false, true)
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

// ─── Time estimation (word-count based, ~150 wpm TTS) ────────────────────────

const WORDS_PER_SEC = 2.5;

function chunkSeconds(chunk: string): number {
  return Math.max(0.3, chunk.trim().split(/\s+/).length / WORDS_PER_SEC);
}

function totalChapterSeconds(chunks: string[]): number {
  return chunks.reduce((s, c) => s + chunkSeconds(c), 0);
}

function currentChapterSeconds(chunks: string[], upTo: number): number {
  return chunks.slice(0, upTo).reduce((s, c) => s + chunkSeconds(c), 0);
}

function chunkIndexAtSecond(chunks: string[], targetSec: number): number {
  let elapsed = 0;
  for (let i = 0; i < chunks.length; i++) {
    elapsed += chunkSeconds(chunks[i]!);
    if (elapsed >= targetSec) return i;
  }
  return Math.max(0, chunks.length - 1);
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ─── Progress bar ─────────────────────────────────────────────────────────────

function progressBar(
  title: string,
  currentSec: number,
  totalSec: number,
  done: number,
  total: number,
  voice: VoiceOption,
  loading = false,
): string {
  const WIDTH = 20;
  const pct    = total > 0 ? Math.round((done / total) * 100) : 0;
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
    `${bar} **${fmt(currentSec)}** / ${fmt(totalSec)}\n` +
    `🎙️ ${flag} **${voice.label}**` +
    (done >= total ? " · ✅ Done!" : "")
  );
}

function buildControlRow(paused: boolean): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("ctrl_restart").setEmoji("⏮️").setLabel("Restart").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ctrl_back").setEmoji("⏪").setLabel("-30s").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("ctrl_pause")
      .setEmoji(paused ? "▶️" : "⏸️")
      .setLabel(paused ? "Resume" : "Pause")
      .setStyle(paused ? ButtonStyle.Success : ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("ctrl_forward").setEmoji("⏩").setLabel("+30s").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("ctrl_stop").setEmoji("⏹️").setLabel("Stop").setStyle(ButtonStyle.Danger),
  );
}

type ProgressPayload = { content: string; components: ActionRowBuilder<ButtonBuilder>[] };

function progressPayload(
  title: string,
  allChunks: string[],
  chunkIndex: number,
  voice: VoiceOption,
  paused: boolean,
  loading = false,
): ProgressPayload {
  const currentSec = loading ? 0 : currentChapterSeconds(allChunks, chunkIndex);
  const totalSec   = totalChapterSeconds(allChunks);
  const content    = progressBar(title, currentSec, totalSec, chunkIndex, allChunks.length, voice, loading);
  const finished   = chunkIndex >= allChunks.length;
  return { content, components: loading || finished ? [] : [buildControlRow(paused)] };
}

async function updateProgress(session: ReadSession): Promise<void> {
  if (!session.progressMsg) return;
  const now = Date.now();
  if (now - session.lastProgressEdit < 4_000) return; // rate limit: max 1 edit per 4 s
  session.lastProgressEdit = now;

  const voice = getGuildVoice(session.guildId);
  const payload = progressPayload(session.title, session.allChunks, session.chunkIndex, voice, session.paused);
  try {
    await session.progressMsg.edit(payload);
  } catch { /* ignore — message might be deleted */ }
}

/** Force an immediate progress bar refresh — bypasses the 4-second rate limit.
 *  Use after button interactions so the UI reflects the new state right away. */
export async function forceProgressUpdate(guildId: string): Promise<void> {
  const session = sessions.get(guildId);
  if (!session?.progressMsg) return;
  session.lastProgressEdit = 0; // clear rate-limit so updateProgress runs
  await updateProgress(session);
}

async function finalizeProgress(session: ReadSession, stopped = false): Promise<void> {
  if (!session.progressMsg) return;
  if (stopped) {
    try { await session.progressMsg.edit({ content: `⏹️ **${session.title}** — stopped.`, components: [] }); } catch { /* ignore */ }
    return;
  }
  const voice = getGuildVoice(session.guildId);
  try {
    await session.progressMsg.edit(
      progressPayload(session.title, session.allChunks, session.allChunks.length, voice, false)
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
      // Voice changed or seek happened — discard stale pre-generated chunk and
      // re-generate from the current chunkIndex (seek may have moved it)
      await cleanupFile(preGen.file);
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

export function seekSession(guildId: string, chunkIndex: number): boolean {
  const session = sessions.get(guildId);
  if (!session) return false;
  session.chunkIndex = Math.max(0, Math.min(chunkIndex, session.allChunks.length - 1));
  session.voiceVersion++;   // discard any in-flight pre-generated audio
  session.consecutiveSkips = 0;
  session.player.stop();    // kick the pipeline to regenerate from new position
  return true;
}

export function seekSessionBySeconds(guildId: string, targetSec: number): boolean {
  const session = sessions.get(guildId);
  if (!session) return false;
  const idx = chunkIndexAtSecond(session.allChunks, Math.max(0, targetSec));
  return seekSession(guildId, idx);
}

export function seekRelativeSeconds(guildId: string, deltaSec: number): boolean {
  const session = sessions.get(guildId);
  if (!session) return false;
  const current = currentChapterSeconds(session.allChunks, session.chunkIndex);
  return seekSessionBySeconds(guildId, current + deltaSec);
}

export function restartSession(guildId: string): boolean {
  return seekSession(guildId, 0);
}

export function getProgressSeconds(guildId: string): { currentSec: number; totalSec: number; title: string } | null {
  const session = sessions.get(guildId);
  if (!session) return null;
  return {
    currentSec: currentChapterSeconds(session.allChunks, session.chunkIndex),
    totalSec:   totalChapterSeconds(session.allChunks),
    title:      session.title,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
