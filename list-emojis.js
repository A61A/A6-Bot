import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("ready", async () => {
  const guild = await client.guilds.fetch(process.env.GUILD_ID, { withEmojis: true });
  const emojis = await guild.emojis.fetch();
  console.log("Available emojis:");
  for (const e of emojis.values()) {
    console.log(`${e.animated ? "[anim]" : "[static]"} ${e.name} = <${e.animated ? "a" : ""}:${e.name}:${e.id}>`);
  }
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);