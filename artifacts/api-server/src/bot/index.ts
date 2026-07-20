import {
  Client,
  Events,
  GatewayIntentBits,
  Message,
  GuildMember,
  TextChannel,
  ChatInputCommandInteraction,
  ButtonInteraction,
  Interaction,
  REST,
  Routes,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  ComponentType,
  ChannelType,
  VoiceBasedChannel,
  Guild,
  User,
} from "discord.js";
import { scrapeChapter } from "./scraper.js";
import {
  startReading,
  stopSession,
  pauseSession,
  resumeSession,
  skipParagraph,
  seekSessionBySeconds,
  seekRelativeSeconds,
  restartSession,
  skipToChapter,
  forceProgressUpdate,
  getSession,
  getSessionByUserId,
  getProgressInfo,
  getProgressSeconds,
  getChapterInfo,
  getGuildVoice,
  setGuildVoice,
} from "./voice.js";
import { getBookmark } from "./bookmarks.js";
import { VOICES } from "./voices.js";
import { slashCommands } from "./commands.js";

const PREFIX = "!";

// ─── Global crash guards ──────────────────────────────────────────────────────
process.on("unhandledRejection", (reason) => console.error("[unhandledRejection]", reason));
process.on("uncaughtException",  (err)    => console.error("[uncaughtException]", err));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildProgressBar(pct: number, width = 20): string {
  const filled = Math.round((pct / 100) * width);
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

function helpText(): string {
  return [
    "📖 **WCT Reader Bot**",
    "",
    "`/read <url> [channel]` — fetch a chapter and read it aloud",
    "`/stop` — stop reading and leave voice (saves your position)",
    "`/pause` — pause playback",
    "`/resume` — resume playback",
    "`/skip` — skip current paragraph",
    "`/chapter <n>` — jump to chapter/section N",
    "`/chapters` — list all detected chapters in the current reading",
    "`/restart` — restart the chapter from the beginning",
    "`/seek <seconds>` — jump to a timestamp (e.g. `/seek 120` = 2:00)",
    "`/progress` — show current progress info",
    "`/voice` — pick a TTS voice from a dropdown",
    "`/help` — show this message",
    "",
    "Progress embed buttons: ⏮️ Restart · ⏪ -10s · ⏸️ Pause · ⏩ +10s · ⏹️ Stop",
    "Chapter buttons: ⬅️ Prev Ch. · ➡️ Next Ch. (appear when chapters are detected)",
    "",
    "All commands also work with the `!` prefix.",
    "Supports WitchCultTranslations and AO3 links.",
    "Your position is saved when you `!stop` — re-reading the same URL resumes automatically.",
  ].join("\n");
}

async function safeSend(channel: TextChannel | null | undefined, content: string): Promise<void> {
  if (!channel) return;
  try { await channel.send(content); } catch (err) { console.error("[safeSend]", err); }
}

// ─── Voice select menu builder ────────────────────────────────────────────────

const ACCENT_FLAG: Record<string, string> = {
  American:   "🇺🇸",
  British:    "🇬🇧",
  Australian: "🇦🇺",
  Irish:      "🇮🇪",
};

function buildVoiceMenu(guildId: string): ActionRowBuilder<StringSelectMenuBuilder> {
  const currentVoice = getGuildVoice(guildId);

  const options = VOICES.map((v) => {
    const flag   = ACCENT_FLAG[v.accent] ?? "🌐";
    const gender = v.gender === "Female" ? "♀" : "♂";
    return {
      label:       v.label,
      description: `${flag} ${v.accent} ${gender} · ${v.style}`,
      value:       v.id,
      default:     v.id === currentVoice.id,
    };
  });

  const menu = new StringSelectMenuBuilder()
    .setCustomId("voice_select")
    .setPlaceholder("Choose a voice…")
    .addOptions(options);

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

async function sendVoicePicker(
  guildId: string,
  sendFn: (payload: { content: string; components: ActionRowBuilder<StringSelectMenuBuilder>[] }) => Promise<Message | void>
): Promise<void> {
  const currentVoice = getGuildVoice(guildId);
  await sendFn({
    content:    `🎙️ Current voice: **${currentVoice.label}** — pick a new one below:`,
    components: [buildVoiceMenu(guildId)],
  });
}

// ─── VC picker ────────────────────────────────────────────────────────────────

async function pickVoiceChannel(
  guild: Guild,
  textChannel: TextChannel,
  replyFn: (payload: { content: string; components: ActionRowBuilder<StringSelectMenuBuilder>[] }) => Promise<Message | void>
): Promise<VoiceBasedChannel | null> {
  const vcs = guild.channels.cache.filter(
    (c) => c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice
  );
  if (vcs.size === 0) {
    await replyFn({ content: "❌ No voice channels found in this server.", components: [] });
    return null;
  }

  const options = vcs.map((ch) => ({
    label:       ch.name.slice(0, 25),
    value:       ch.id,
    description: `${(ch as VoiceBasedChannel).members?.size ?? 0} members`,
  }));

  const menu = new StringSelectMenuBuilder()
    .setCustomId("vc_pick")
    .setPlaceholder("Choose a voice channel…")
    .addOptions(options.slice(0, 25));

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
  const sentMsg = await replyFn({ content: "🎙️ Which voice channel should I join?", components: [row] });

  try {
    const collected = await textChannel.awaitMessageComponent({
      componentType: ComponentType.StringSelect,
      filter: (i) => i.customId === "vc_pick",
      time: 30_000,
    });
    await collected.deferUpdate();
    return guild.channels.cache.get(collected.values[0]!) as VoiceBasedChannel ?? null;
  } catch {
    if (sentMsg && "edit" in sentMsg) {
      await (sentMsg as Message).edit({ content: "⏱️ Timed out — no channel selected.", components: [] }).catch(() => {});
    }
    return null;
  }
}

// ─── Admin read log ───────────────────────────────────────────────────────────

async function logRead(user: User, guild: Guild, sourceChannel: TextChannel, url: string): Promise<void> {
  const channelId = process.env["DISCORD_LOG_CHANNEL_ID"];
  if (!channelId) return;
  try {
    const ch = await client.channels.fetch(channelId);
    if (!ch || !("send" in ch)) return;
    const ts          = `<t:${Math.floor(Date.now() / 1000)}:F>`;
    const serverLink  = `[${guild.name}](https://discord.com/channels/${guild.id}/${sourceChannel.id})`;
    await (ch as TextChannel).send(
      `📋 **Read request**\n` +
      `👤 **User:** ${user.tag} (${user.id})\n` +
      `🏠 **Server:** ${serverLink}\n` +
      `🔗 **URL:** ${url}\n` +
      `🕐 **Time:** ${ts}`
    );
  } catch { /* non-fatal — log channel may be unreachable */ }
}

// ─── Shared command logic ─────────────────────────────────────────────────────

async function handleRead(
  guildId: string,
  guild: Guild,
  textChannel: TextChannel,
  memberVC: VoiceBasedChannel | null | undefined,
  explicitVC: VoiceBasedChannel | null | undefined,
  url: string,
  requestedBy: User,
  replyFn: (payload: { content: string; components?: ActionRowBuilder<StringSelectMenuBuilder>[] }) => Promise<Message | void>
): Promise<void> {
  if (!url.startsWith("http")) { await replyFn({ content: "❌ Please provide a valid URL." }); return; }

  let voiceChannel: VoiceBasedChannel | null;
  if (explicitVC) {
    voiceChannel = explicitVC;
  } else if (memberVC) {
    voiceChannel = memberVC;
  } else {
    voiceChannel = await pickVoiceChannel(guild, textChannel,
      (p) => replyFn({ content: p.content, components: p.components })
    );
  }
  if (!voiceChannel) return;

  await replyFn({ content: "🔍 Fetching chapter..." });

  let chapter;
  try { chapter = await scrapeChapter(url); }
  catch (err) { await safeSend(textChannel, `❌ Could not read that page: ${(err as Error).message}`); return; }

  // Log the request to the admin channel (fire-and-forget)
  logRead(requestedBy, guild, textChannel, url).catch(() => {});

  // ── Check for saved bookmark ─────────────────────────────────────────────
  let resumeFromChunk = 0;
  try {
    const bookmark = await getBookmark(guildId);
    if (bookmark && bookmark.url === url && bookmark.chunkIndex > 0) {
      resumeFromChunk = bookmark.chunkIndex;
      const pct = Math.round((bookmark.chunkIndex / bookmark.totalChunks) * 100);
      await safeSend(
        textChannel,
        `📌 Resuming **${bookmark.title}** from where you left off — chunk ${bookmark.chunkIndex}/${bookmark.totalChunks} (${pct}% done).`
      );
    }
  } catch { /* non-fatal */ }

  const voice = getGuildVoice(guildId);
  await safeSend(
    textChannel,
    `📖 Starting **${chapter.title}** (${chapter.paragraphs.length} paragraphs)\n` +
    `🎙️ Voice: **${voice.label}** — ${voice.accent} ${voice.gender} | Joining **${voiceChannel.name}**`
  );

  // Announce detected chapters/sections
  if (chapter.sections.length > 1) {
    await safeSend(
      textChannel,
      `📑 Detected **${chapter.sections.length} sections** — use \`/chapter <n>\` or the ⬅️ ➡️ buttons to navigate.`
    );
  }

  try {
    await startReading(guild, voiceChannel, textChannel, chapter.title, chapter.paragraphs, url, chapter.sections, resumeFromChunk, requestedBy.id);
  } catch (err) {
    await safeSend(textChannel, `❌ Voice error: ${(err as Error).message}`);
  }
}

async function handleStop(guildId: string): Promise<string> {
  if (!getSession(guildId)) return "❌ Nothing is currently playing.";
  await stopSession(guildId);
  return "⏹️ Stopped and left the voice channel. Your position has been saved — read the same URL to resume.";
}

function handlePause(guildId: string): string {
  return pauseSession(guildId) ? "⏸️ Paused. Use `/resume` or `!resume` to continue." : "❌ Nothing is playing or already paused.";
}

function handleResume(guildId: string): string {
  return resumeSession(guildId) ? "▶️ Resuming..." : "❌ Nothing is paused.";
}

function handleSkip(guildId: string): string {
  return skipParagraph(guildId) ? "⏭️ Skipping forward..." : "❌ Nothing is currently playing.";
}

function handleProgress(guildId: string): string {
  const info = getProgressInfo(guildId);
  if (!info) return "❌ Nothing is currently playing.";
  const pct = Math.round((info.index / info.total) * 100);
  return (
    `📖 **${info.title}**\n` +
    `${buildProgressBar(pct)} ${pct}%\n` +
    `Chunk ${info.index}/${info.total}` +
    (info.paused ? " *(paused)*" : "")
  );
}

function handleChapter(guildId: string, num: number): string {
  const result = skipToChapter(guildId, num);
  if (!result.ok) return `❌ ${result.title || "No chapters detected in this content."}`;
  return `📑 Jumping to chapter **${num}**: *${result.title}* (${result.total} total)...`;
}

function handleChapters(guildId: string): string {
  const info = getChapterInfo(guildId);
  if (!info) return "❌ Nothing is currently playing.";
  if (info.total <= 1) return "ℹ️ No separate chapters/sections were detected in this content.";
  const list = info.titles
    .map((t, i) => `${i + 1 === info.current ? "▶️" : "　"} **${i + 1}.** ${t}`)
    .join("\n");
  return `📑 **Chapters** (currently on ${info.current}/${info.total}):\n${list}`;
}

function handleRestart(guildId: string): string {
  const session = getSession(guildId);
  if (!session) return "❌ Nothing is currently playing.";
  const title = session.title;
  restartSession(guildId);
  return `⏮️ Restarting **${title}** from the beginning...`;
}

function handleSeek(guildId: string, seconds: number): string {
  const info = getProgressSeconds(guildId);
  if (!info) return "❌ Nothing is currently playing.";
  if (seconds > info.totalSec) return `❌ Chapter is only **${fmt(info.totalSec)}** long.`;
  seekSessionBySeconds(guildId, seconds);
  return `⏩ Jumping to **${fmt(seconds)}** of *${info.title}* (~${fmt(info.totalSec)} total)...`;
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ─── Discord client ───────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.DirectMessages,
  ],
  partials: ["CHANNEL" as any], // required to receive DM events
});

// ─── Ready ────────────────────────────────────────────────────────────────────

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ WCT Reader Bot ready! Logged in as ${c.user.tag}`);
  console.log(`🎙️ Voices loaded: ${VOICES.map(v => v.label).join(", ")}`);
  c.user.setActivity("📖 /help or !help");
  try {
    const rest = new REST().setToken(process.env["DISCORD_BOT_TOKEN"]!);
    await rest.put(Routes.applicationCommands(c.user.id), { body: slashCommands });
    console.log("✅ Slash commands registered globally.");
  } catch (err) {
    console.error("Failed to register slash commands:", err);
  }
});

// ─── Interaction handler (slash commands + select menus) ──────────────────────

client.on(Events.InteractionCreate, async (interaction: Interaction) => {
  if (!interaction.guild) return;
  const guildId = interaction.guild.id;

  // ── Seek/restart/pause/stop control buttons on the progress bar ────────────
  if (interaction.isButton()) {
    const btn = interaction as ButtonInteraction;
    const { customId } = btn;
    const CTRL_IDS = ["ctrl_restart","ctrl_back","ctrl_forward","ctrl_pause","ctrl_stop","ctrl_prev_chapter","ctrl_next_chapter"];
    if (CTRL_IDS.includes(customId)) {
      await btn.deferUpdate().catch(() => {});
      switch (customId) {
        case "ctrl_restart":      restartSession(guildId); break;
        case "ctrl_back":         seekRelativeSeconds(guildId, -10); break;
        case "ctrl_forward":      seekRelativeSeconds(guildId, +10); break;
        case "ctrl_pause": {
          const s = getSession(guildId);
          if (s?.paused) resumeSession(guildId); else pauseSession(guildId);
          break;
        }
        case "ctrl_stop":         await stopSession(guildId); break;
        case "ctrl_prev_chapter": {
          const ci = getChapterInfo(guildId);
          if (ci) skipToChapter(guildId, Math.max(1, ci.current - 1));
          break;
        }
        case "ctrl_next_chapter": {
          const ci = getChapterInfo(guildId);
          if (ci) skipToChapter(guildId, Math.min(ci.total, ci.current + 1));
          break;
        }
      }
      // Immediately refresh embed so button states update at once
      await forceProgressUpdate(guildId).catch(() => {});
      return;
    }
  }

  // ── Voice select menu result ────────────────────────────────────────────────
  if (interaction.isStringSelectMenu() && interaction.customId === "voice_select") {
    const sel = interaction as StringSelectMenuInteraction;
    const voiceId = sel.values[0]!;
    const picked = VOICES.find((v) => v.id === voiceId);
    if (!picked) { await sel.reply({ content: "❌ Unknown voice.", ephemeral: true }).catch(() => {}); return; }

    setGuildVoice(guildId, picked);

    const flag   = ACCENT_FLAG[picked.accent] ?? "🌐";
    const gender = picked.gender === "Female" ? "♀" : "♂";
    await sel.update({
      content:    `✅ Voice switched to **${picked.label}** ${flag} ${gender} · *${picked.style}*`,
      components: [],
    }).catch(() => {});
    return;
  }

  // ── Slash commands ──────────────────────────────────────────────────────────
  if (!interaction.isChatInputCommand()) return;
  const cmd = interaction as ChatInputCommandInteraction;

  try { await cmd.deferReply(); } catch { return; }

  const member    = interaction.member as GuildMember | null;
  const memberVC  = member?.voice?.channel ?? null;
  const textChannel = interaction.channel as TextChannel;
  const editReply = (content: string) => cmd.editReply(content).catch(() => {});

  try {
    switch (cmd.commandName) {
      case "read": {
        const url        = cmd.options.getString("url", true);
        const explicitVC = (cmd.options.getChannel("channel") as VoiceBasedChannel | null) ?? null;
        await handleRead(guildId, interaction.guild, textChannel, memberVC, explicitVC, url, interaction.user,
          (p) => p.components?.length
            ? cmd.editReply({ content: p.content, components: p.components }).catch(() => {})
            : cmd.editReply(p.content).catch(() => {})
        );
        break;
      }
      case "stop":     await editReply(await handleStop(guildId)); break;
      case "pause":    await editReply(handlePause(guildId));      break;
      case "resume":   await editReply(handleResume(guildId));     break;
      case "skip":     await editReply(handleSkip(guildId));       break;
      case "chapter": {
        const num = cmd.options.getInteger("number", true);
        await editReply(handleChapter(guildId, num));
        break;
      }
      case "chapters": await editReply(handleChapters(guildId)); break;
      case "restart":  await editReply(handleRestart(guildId));    break;
      case "seek": {
        const secs = cmd.options.getInteger("seconds", true);
        await editReply(handleSeek(guildId, secs));
        break;
      }
      case "progress": await editReply(handleProgress(guildId));   break;
      case "help":     await editReply(helpText());                break;

      case "voice":
        await sendVoicePicker(guildId,
          (p) => cmd.editReply({ content: p.content, components: p.components }).catch(() => {})
        );
        break;

      default: await editReply("❓ Unknown command."); break;
    }
  } catch (err) {
    console.error(`[slash:${cmd.commandName}]`, err);
    await editReply(`❌ Error: ${(err as Error).message}`).catch(() => {});
  }
});

// ─── Prefix command handler ───────────────────────────────────────────────────

client.on(Events.MessageCreate, async (message: Message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args    = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift()?.toLowerCase();
  if (!command) return;

  const inDM        = !message.guild;
  const textChannel = message.channel as TextChannel;
  let reply = "";

  // ── DM / group-chat handling ──────────────────────────────────────────────
  if (inDM) {
    if (command === "help") {
      try { await message.reply(helpText()); } catch { /* ignore */ }
      return;
    }

    if (command === "read") {
      try { await message.reply("❌ Voice reading requires a server with voice channels. Use `/read` or `!read` in a server text channel, then you can control playback from here."); } catch { /* ignore */ }
      return;
    }

    // Control commands — find the user's active session across all guilds
    const session = getSessionByUserId(message.author.id);
    if (!session) {
      try { await message.reply("❌ You don't have an active reading session. Start one in a server first."); } catch { /* ignore */ }
      return;
    }
    const guildId = session.guildId;

    try {
      switch (command) {
        case "stop":     reply = await handleStop(guildId); break;
        case "pause":    reply = handlePause(guildId);      break;
        case "resume":   reply = handleResume(guildId);     break;
        case "skip":     reply = handleSkip(guildId);       break;
        case "restart":  reply = handleRestart(guildId);    break;
        case "chapter": {
          const num = parseInt(args[0] ?? "", 10);
          reply = isNaN(num) || num < 1 ? "❌ Usage: `!chapter <number>`" : handleChapter(guildId, num);
          break;
        }
        case "chapters": reply = handleChapters(guildId); break;
        case "seek": {
          const secs = parseInt(args[0] ?? "", 10);
          reply = isNaN(secs) || secs < 0 ? "❌ Usage: `!seek <seconds>`" : handleSeek(guildId, secs);
          break;
        }
        case "progress": reply = handleProgress(guildId); break;
        default: reply = `❓ Unknown command. Try \`!help\`.`;
      }
    } catch (err) {
      reply = `❌ Error: ${(err as Error).message}`;
    }
    try { await message.reply(reply); } catch { /* ignore */ }
    return;
  }

  // ── Server (guild) handling ───────────────────────────────────────────────
  const guildId  = message.guild!.id;
  const member   = message.member as GuildMember | null;
  const memberVC = member?.voice?.channel ?? null;

  try {
    switch (command) {
      case "read": {
        let placeholder: Message | undefined;
        try { placeholder = await message.reply("🔍 Working..."); } catch { placeholder = undefined; }
        await handleRead(guildId, message.guild!, textChannel, memberVC, null, args[0] ?? "", message.author,
          async (p) => {
            try {
              if (placeholder) return await placeholder.edit({ content: p.content, components: p.components ?? [] });
            } catch { /* fallback */ }
          }
        );
        return;
      }

      case "voice": {
        try {
          await message.reply({
            content:    `🎙️ Current voice: **${getGuildVoice(guildId).label}** — pick a new one below:`,
            components: [buildVoiceMenu(guildId)],
          });
        } catch (err) { console.error("[prefix voice]", err); }
        return;
      }

      case "stop":     reply = await handleStop(guildId); break;
      case "pause":    reply = handlePause(guildId);      break;
      case "resume":   reply = handleResume(guildId);     break;
      case "skip":     reply = handleSkip(guildId);       break;
      case "chapter": {
        const num = parseInt(args[0] ?? "", 10);
        reply = isNaN(num) || num < 1 ? "❌ Usage: `!chapter <number>`" : handleChapter(guildId, num);
        break;
      }
      case "chapters": reply = handleChapters(guildId); break;
      case "restart":  reply = handleRestart(guildId);    break;
      case "seek": {
        const secs = parseInt(args[0] ?? "", 10);
        reply = isNaN(secs) || secs < 0 ? "❌ Usage: `!seek <seconds>` (e.g. `!seek 120` = 2:00)" : handleSeek(guildId, secs);
        break;
      }
      case "progress": reply = handleProgress(guildId);   break;
      case "help":     reply = helpText();                break;
      default: return;
    }
  } catch (err) {
    console.error(`[prefix:${command}]`, err);
    reply = `❌ Error: ${(err as Error).message}`;
  }

  try { await message.reply(reply); } catch (err) { console.error("[prefix reply]", err); }
});

// ─── Start ────────────────────────────────────────────────────────────────────

// ─── Tiny health server for Render / UptimeRobot ─────────────────────────────
// Render requires a web service to bind a port. This keeps UptimeRobot happy
// without needing a separate API server process.
import { createServer } from "http";
const PORT = process.env["PORT"] ? parseInt(process.env["PORT"]) : 3000;
createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("OK");
}).listen(PORT, () => console.log(`✅ Health server listening on port ${PORT}`));

// ─── Start ────────────────────────────────────────────────────────────────────

const token = process.env["DISCORD_BOT_TOKEN"];
if (!token) { console.error("DISCORD_BOT_TOKEN is not set."); process.exit(1); }

client.login(token).catch((err) => { console.error("Failed to log in:", err); process.exit(1); });
