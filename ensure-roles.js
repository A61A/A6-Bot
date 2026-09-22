import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";

// Creates any of these roles that don't exist yet. Safe to rerun — only
// adds what's missing, never touches existing roles (setup-server.js
// would also create the full channel structure, so use this for
// role-only changes).
const ROLES = ["Member", "Shopper", "Creator", "SOON"];

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("ready", async () => {
  try {
    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    for (const roleName of ROLES) {
      const exists = guild.roles.cache.find((r) => r.name === roleName);
      if (exists) {
        console.log(`Exists: ${roleName}`);
        continue;
      }
      await guild.roles.create({ name: roleName, mentionable: true });
      console.log(`Created: ${roleName}`);
    }
  } catch (err) {
    console.error(err);
  }
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);