import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";

// Locks down the channels/categories created by setup-server.js so only
// the server owner (and the bot) can see them while things are being
// configured. @everyone loses View Channel; the owner keeps access and
// can restructure everything manually from the sidebar afterward.
const TARGETS = ["Welcome", "Community", "Voice", "rules", "announcements", "role-select", "general", "bot-commands", "General VC", "Music"];

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

client.once("ready", async () => {
  try {
    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    const owner = await guild.members.fetch(guild.ownerId);
    const botRole = guild.members.me.roles.highest;

    const channels = await guild.channels.fetch();
    const targets = channels.filter((c) => TARGETS.includes(c.name));

    for (const ch of targets.values()) {
      await ch.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: false });
      await ch.permissionOverwrites.edit(owner, { ViewChannel: true });
      if (botRole && botRole.id !== guild.roles.everyone.id) {
        await ch.permissionOverwrites.edit(botRole, { ViewChannel: true });
      }
      console.log(`Locked: ${ch.name}`);
    }
  } catch (err) {
    console.error(err);
  }
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);