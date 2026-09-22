import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("ready", async () => {
  try {
    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    const emojis = await guild.emojis.fetch();
    console.log(`Found ${emojis.size} emojis to delete`);
    for (const emoji of emojis.values()) {
      await emoji.delete("Replacing server emoji set");
      console.log(`Deleted: ${emoji.name}`);
    }
    console.log(`Finished. ${emojis.size} emojis removed.`);
  } catch (err) {
    console.error(err);
  }
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);