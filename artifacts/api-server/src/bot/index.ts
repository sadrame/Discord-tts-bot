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
import { voiceListEmbed, findVoice } from "./voices.js";
import { slashCommands } from "./commands.js";

const PREFIX = "!";

// ─── Global crash guards — never let an unhandled error kill the process ──────
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildProgressBar(pct: number, width = 20): string {
  const filled = Math.round((pct / 100) * width);
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

function helpText(): string {
  return [
    "📖 **WCT Reader Bot**",
    "",
    "`/read <url> [channel]` — fetch a chapter and read it aloud (picks VC for you if omitted)",
    "`/stop` — stop reading and leave voice",
    "`/pause` — pause playback",
    "`/resume` — resume playback",
    "`/skip` — skip current paragraph",
    "`/progress` — show a progress bar",
    "`/voice [name]` — change voice (no name = list all voices)",
    "`/help` — show this message",
    "",
    "All commands also work with the `!` prefix.",
  ].join("\n");
}

/** Safe wrapper — never throws, logs errors silently */
async function safeSend(
  channel: TextChannel | null | undefined,
  content: string
): Promise<void> {
  if (!channel) return;
  try {
    await channel.send(content);
  } catch (err) {
    console.error("[safeSend]", err);
  }
}

// ─── VC picker — shows a select menu of available voice channels ──────────────

async function pickVoiceChannel(
  guild: Guild,
  replyFn: (content: string, components: ActionRowBuilder<StringSelectMenuBuilder>[]) => Promise<Message | void>,
  textChannel: TextChannel
): Promise<VoiceBasedChannel | null> {
  const voiceChannels = guild.channels.cache.filter(
    (c) => c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice
  );

  if (voiceChannels.size === 0) {
    await replyFn("❌ No voice channels found in this server.", []);
    return null;
  }

  const options = voiceChannels.map((ch) => ({
    label: ch.name,
    value: ch.id,
    description: `${(ch as VoiceBasedChannel).members?.size ?? 0} members`,
  }));

  const select = new StringSelectMenuBuilder()
    .setCustomId("vc_pick")
    .setPlaceholder("Choose a voice channel…")
    .addOptions(options.slice(0, 25)); // Discord max

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

  const sentMsg = await replyFn("🎙️ Which voice channel should I join?", [row]);

  // Wait up to 30 s for the user to pick
  try {
    const collected = await textChannel.awaitMessageComponent({
      componentType: ComponentType.StringSelect,
      filter: (i) => i.customId === "vc_pick",
      time: 30_000,
    });

    await collected.deferUpdate();
    const channelId = collected.values[0]!;
    const picked = guild.channels.cache.get(channelId) as VoiceBasedChannel | undefined;
    return picked ?? null;
  } catch {
    // Timed out
    if (sentMsg && "edit" in sentMsg) {
      await (sentMsg as Message).edit({ content: "⏱️ Timed out — no channel selected.", components: [] }).catch(() => {});
    }
    return null;
  }
}

// ─── Shared command logic ─────────────────────────────────────────────────────

/** Resolve the voice channel to join, or trigger a VC picker. */
async function resolveVoiceChannel(
  guild: Guild,
  memberVoiceChannel: VoiceBasedChannel | null | undefined,
  explicitChannel: VoiceBasedChannel | null | undefined,
  replyFn: (content: string, components?: ActionRowBuilder<StringSelectMenuBuilder>[]) => Promise<Message | void>,
  textChannel: TextChannel
): Promise<VoiceBasedChannel | null> {
  if (explicitChannel) return explicitChannel;
  if (memberVoiceChannel) return memberVoiceChannel;
  return pickVoiceChannel(guild, replyFn as Parameters<typeof pickVoiceChannel>[1], textChannel);
}

async function handleRead(
  guildId: string,
  guild: Guild,
  textChannel: TextChannel,
  memberVoiceChannel: VoiceBasedChannel | null | undefined,
  explicitVoiceChannel: VoiceBasedChannel | null | undefined,
  url: string,
  replyFn: (content: string, components?: ActionRowBuilder<StringSelectMenuBuilder>[]) => Promise<Message | void>
): Promise<void> {
  if (!url.startsWith("http")) {
    await replyFn("❌ Please provide a valid URL.");
    return;
  }

  const voiceChannel = await resolveVoiceChannel(
    guild, memberVoiceChannel, explicitVoiceChannel, replyFn, textChannel
  );
  if (!voiceChannel) return; // picker timed out or no channels

  await replyFn("🔍 Fetching chapter...");

  let chapter;
  try {
    chapter = await scrapeChapter(url);
  } catch (err) {
    await safeSend(textChannel, `❌ Could not read that page: ${(err as Error).message}`);
    return;
  }

  const voice = getGuildVoice(guildId);
  await safeSend(
    textChannel,
    `📖 Starting **${chapter.title}** (${chapter.paragraphs.length} paragraphs)\n` +
    `🎙️ Voice: **${voice.label}** — ${voice.accent} ${voice.gender} | Joining **${voiceChannel.name}**`
  );

  try {
    await startReading(guild, voiceChannel, textChannel, chapter.title, chapter.paragraphs);
  } catch (err) {
    await safeSend(textChannel, `❌ Voice error: ${(err as Error).message}`);
  }
}

function handleStop(guildId: string): string {
  if (!getSession(guildId)) return "❌ Nothing is currently playing.";
  stopSession(guildId);
  return "⏹️ Stopped and left the voice channel.";
}

function handlePause(guildId: string): string {
  return pauseSession(guildId)
    ? "⏸️ Paused. Use `/resume` or `!resume` to continue."
    : "❌ Nothing is playing or already paused.";
}

function handleResume(guildId: string): string {
  return resumeSession(guildId) ? "▶️ Resuming..." : "❌ Nothing is paused.";
}

function handleSkip(guildId: string): string {
  return skipParagraph(guildId)
    ? "⏭️ Skipping to next paragraph..."
    : "❌ Nothing is currently playing.";
}

function handleProgress(guildId: string): string {
  const info = getProgressInfo(guildId);
  if (!info) return "❌ Nothing is currently playing.";
  const pct = Math.round((info.index / info.total) * 100);
  const bar = buildProgressBar(pct);
  return (
    `📖 **${info.title}**\n` +
    `${bar} ${pct}%\n` +
    `Chunk ${info.index}/${info.total}` +
    (info.paused ? " *(paused)*" : "")
  );
}

function handleVoice(guildId: string, name?: string): string {
  if (!name) return voiceListEmbed();
  const match = findVoice(name);
  if (!match) {
    return `❌ Voice **${name}** not found. Use \`/voice\` or \`!voice\` (no name) to list all.`;
  }
  setGuildVoice(guildId, match);
  return `✅ Voice set to **${match.label}** (${match.accent} ${match.gender} — ${match.style ?? ""})`;
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
  c.user.setActivity("📖 /help or !help");

  try {
    const rest = new REST().setToken(process.env["DISCORD_BOT_TOKEN"]!);
    await rest.put(Routes.applicationCommands(c.user.id), { body: slashCommands });
    console.log("✅ Slash commands registered globally.");
  } catch (err) {
    console.error("Failed to register slash commands:", err);
  }
});

// ─── Slash command handler ────────────────────────────────────────────────────

client.on(Events.InteractionCreate, async (interaction: Interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.guild) {
    await interaction.reply({ content: "❌ This bot only works in servers.", ephemeral: true }).catch(() => {});
    return;
  }

  const cmd = interaction as ChatInputCommandInteraction;

  // Always defer immediately — prevents "application did not respond" for every command
  try {
    await cmd.deferReply();
  } catch {
    return; // interaction already expired
  }

  const guildId = interaction.guild.id;
  const member = interaction.member as GuildMember | null;
  const memberVC = member?.voice?.channel ?? null;
  const textChannel = interaction.channel as TextChannel;

  const editReply = (content: string) => cmd.editReply(content).catch(() => {});

  try {
    switch (cmd.commandName) {
      case "read": {
        const url = cmd.options.getString("url", true);
        const explicitVC = (cmd.options.getChannel("channel") as VoiceBasedChannel | null) ?? null;

        await handleRead(
          guildId,
          interaction.guild,
          textChannel,
          memberVC,
          explicitVC,
          url,
          async (content, components) => {
            if (components && components.length > 0) {
              await cmd.editReply({ content, components }).catch(() => {});
            } else {
              await cmd.editReply(content).catch(() => {});
            }
          }
        );
        break;
      }
      case "stop":     await editReply(handleStop(guildId));            break;
      case "pause":    await editReply(handlePause(guildId));           break;
      case "resume":   await editReply(handleResume(guildId));          break;
      case "skip":     await editReply(handleSkip(guildId));            break;
      case "progress": await editReply(handleProgress(guildId));        break;
      case "voice":    await editReply(handleVoice(guildId, cmd.options.getString("name") ?? undefined)); break;
      case "help":     await editReply(helpText());                     break;
      default:         await editReply("❓ Unknown command.");           break;
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

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift()?.toLowerCase();
  if (!command) return;

  const guildId = message.guild.id;
  const member = message.member as GuildMember | null;
  const memberVC = member?.voice?.channel ?? null;
  const textChannel = message.channel as TextChannel;

  let reply = "";

  try {
    switch (command) {
      case "read": {
        const url = args[0] ?? "";
        // For prefix commands, use replyFn that edits the bot's first reply
        let placeholder: Message | undefined;
        try {
          placeholder = await message.reply("🔍 Working...");
        } catch {
          placeholder = undefined;
        }
        await handleRead(
          guildId,
          message.guild,
          textChannel,
          memberVC,
          null, // no explicit VC from prefix command — use member VC or picker
          url,
          async (content, components) => {
            try {
              if (placeholder) {
                return await placeholder.edit({
                  content,
                  components: components ?? [],
                });
              }
            } catch {
              // fallback
            }
          }
        );
        return;
      }
      case "stop":     reply = handleStop(guildId);          break;
      case "pause":    reply = handlePause(guildId);         break;
      case "resume":   reply = handleResume(guildId);        break;
      case "skip":     reply = handleSkip(guildId);          break;
      case "progress": reply = handleProgress(guildId);      break;
      case "voice":    reply = handleVoice(guildId, args[0]); break;
      case "help":     reply = helpText();                   break;
      default: return;
    }
  } catch (err) {
    console.error(`[prefix:${command}]`, err);
    reply = `❌ Error: ${(err as Error).message}`;
  }

  try {
    await message.reply(reply);
  } catch (err) {
    console.error("[prefix reply]", err);
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

const token = process.env["DISCORD_BOT_TOKEN"];
if (!token) {
  console.error("DISCORD_BOT_TOKEN is not set.");
  process.exit(1);
}

client.login(token).catch((err) => {
  console.error("Failed to log in:", err);
  process.exit(1);
});
