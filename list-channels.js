import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("ready", async () => {
  const guild = await client.guilds.fetch(process.env.GUILD_ID);
  const channels = await guild.channels.fetch();
  for (const ch of channels.values()) {
    const type = ch.type;
    const parent = ch.parent ? ch.parent.name : "—";
    console.log(`[${type}] ${ch.name}  (parent: ${parent})`);
  }
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);