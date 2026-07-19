import {
  Client,
  Events,
  GatewayIntentBits,
  Message,
  GuildMember,
  TextChannel,
  ChatInputCommandInteraction,
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
} from "discord.js";
import { scrapeChapter } from "./scraper.js";
import {
  startReading,
  stopSession,
  pauseSession,
  resumeSession,
  skipParagraph,
  getSession,
  getProgressInfo,
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
    "`/progress` — show a progress bar",
    "`/voice` — pick a TTS voice from a dropdown",
    "`/help` — show this message",
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

// ─── Shared command logic ─────────────────────────────────────────────────────

async function handleRead(
  guildId: string,
  guild: Guild,
  textChannel: TextChannel,
  memberVC: VoiceBasedChannel | null | undefined,
  explicitVC: VoiceBasedChannel | null | undefined,
  url: string,
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

  try {
    await startReading(guild, voiceChannel, textChannel, chapter.title, chapter.paragraphs, url, resumeFromChunk);
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

// ─── Discord client ───────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
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
        await handleRead(guildId, interaction.guild, textChannel, memberVC, explicitVC, url,
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
  if (!message.guild) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args    = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift()?.toLowerCase();
  if (!command) return;

  const guildId     = message.guild.id;
  const member      = message.member as GuildMember | null;
  const memberVC    = member?.voice?.channel ?? null;
  const textChannel = message.channel as TextChannel;

  let reply = "";

  try {
    switch (command) {
      case "read": {
        let placeholder: Message | undefined;
        try { placeholder = await message.reply("🔍 Working..."); } catch { placeholder = undefined; }
        await handleRead(guildId, message.guild, textChannel, memberVC, null, args[0] ?? "",
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

const token = process.env["DISCORD_BOT_TOKEN"];
if (!token) { console.error("DISCORD_BOT_TOKEN is not set."); process.exit(1); }

client.login(token).catch((err) => { console.error("Failed to log in:", err); process.exit(1); });
