import "dotenv/config";
import { Client, GatewayIntentBits, ChannelType } from "discord.js";

// This only needs Guilds — we're creating structure, not listening to
// ongoing events, so no message/voice intents required here.
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Edit this list to match what you actually want. Each category becomes
// a folder in the channel sidebar; each channel inside it is created
// under that category automatically.
const STRUCTURE = [
  {
    category: "Welcome",
    channels: [
      { name: "rules", type: "text" },
      { name: "announcements", type: "text" },
      { name: "role-select", type: "text" },
    ],
  },
  {
    category: "Community",
    channels: [
      { name: "general", type: "text" },
      { name: "bot-commands", type: "text" },
    ],
  },
  {
    category: "Voice",
    channels: [
      { name: "General VC", type: "voice" },
      { name: "Music", type: "voice" },
    ],
  },
];

// Roles the bot's features assume exist (matches ROLE_NAMES in roleButtons.js).
// "Member" is the base role guildMemberAdd.js gives everyone automatically.
const ROLES = ["Member", "Shopper", "Creator", "SOON"];

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const guild = await client.guilds.fetch(process.env.GUILD_ID);

  // Roles first, since channel permission overwrites could reference them
  for (const roleName of ROLES) {
    const exists = guild.roles.cache.find((r) => r.name === roleName);
    if (exists) continue;
    await guild.roles.create({ name: roleName, mentionable: true });
    console.log(`Created role: ${roleName}`);
  }

  // Then categories + their channels, in order, so the sidebar layout
  // matches STRUCTURE top to bottom
  for (const group of STRUCTURE) {
    const category = await guild.channels.create({
      name: group.category,
      type: ChannelType.GuildCategory,
    });

    for (const ch of group.channels) {
      await guild.channels.create({
        name: ch.name,
        type: ch.type === "voice" ? ChannelType.GuildVoice : ChannelType.GuildText,
        parent: category.id,
      });
      console.log(`Created #${ch.name} under ${group.category}`);
    }
  }

  console.log("Server structure setup complete. Note: this script doesn't set");
  console.log("WELCOME_CHANNEL_ID for you — copy the #role-select channel ID");
  console.log("into your .env once it's created above.");
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);
