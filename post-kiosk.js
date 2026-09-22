import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
import { buildKioskMessage } from "./components/kioskButtons.js";

const TARGET_CHANNEL_ID = process.env.KIOSK_CHANNEL_ID;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("ready", async () => {
  try {
    if (!TARGET_CHANNEL_ID) {
      console.error("Set KIOSK_CHANNEL_ID in your .env first.");
      process.exit(1);
    }
    const channel = await client.channels.fetch(TARGET_CHANNEL_ID);
    if (!channel) {
      console.error(`No channel with id ${TARGET_CHANNEL_ID}`);
      process.exit(1);
    }

    const { embed, row, file } = buildKioskMessage();
    await channel.send({ embeds: [embed], components: [row], files: file ? [file] : [] });
    console.log(`Kiosk posted to #${channel.name}.`);
  } catch (err) {
    console.error(err);
  }
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);