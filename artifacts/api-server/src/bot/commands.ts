import { SlashCommandBuilder, ChannelType } from "discord.js";

export const slashCommands = [
  new SlashCommandBuilder()
    .setName("read")
    .setDescription("Scrape a chapter URL and read it in a voice channel")
    .addStringOption((o) =>
      o.setName("url").setDescription("Chapter URL to read").setRequired(true)
    )
    .addChannelOption((o) =>
      o
        .setName("channel")
        .setDescription("Voice channel to join (defaults to your current VC)")
        .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stop reading and leave the voice channel"),

  new SlashCommandBuilder()
    .setName("pause")
    .setDescription("Pause the current reading"),

  new SlashCommandBuilder()
    .setName("resume")
    .setDescription("Resume a paused reading"),

  new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Skip the current paragraph"),

  new SlashCommandBuilder()
    .setName("progress")
    .setDescription("Show reading progress for the current chapter"),

  new SlashCommandBuilder()
    .setName("voice")
    .setDescription("Pick a TTS voice from a dropdown menu"),

  new SlashCommandBuilder()
    .setName("restart")
    .setDescription("Restart the current chapter from the beginning"),

  new SlashCommandBuilder()
    .setName("seek")
    .setDescription("Jump to a position in the current chapter (0–100%)")
    .addIntegerOption((o) =>
      o.setName("percent").setDescription("Position to jump to (0–100)").setRequired(true).setMinValue(0).setMaxValue(100)
    ),

  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show all bot commands"),
].map((cmd) => cmd.toJSON());
