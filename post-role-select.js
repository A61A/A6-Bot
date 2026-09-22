import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
import { buildRolePicker } from "./components/rolePicker.js";

const TARGET_CHANNEL_ID = process.env.ROLE_SELECT_CHANNEL_ID;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("ready", async () => {
  try {
    if (!TARGET_CHANNEL_ID) {
      console.error("Set ROLE_SELECT_CHANNEL_ID in your .env first.");
      process.exit(1);
    }
    const channel = await client.channels.fetch(TARGET_CHANNEL_ID);
    if (!channel) {
      console.error(`No channel with id ${TARGET_CHANNEL_ID}`);
      process.exit(1);
    }

    // Role-select holds ONLY the role picker. The "How To Use A7" kiosk
    // embed lives in the bot-commands channel (KIOSK_CHANNEL_ID) — same
    // embed, one place only, so nothing overlaps.
    // Clear any previously-posted role picker (bot's own messages in this
    // channel), then post the current one so we never stack duplicates.
    const old = await channel.messages.fetch({ limit: 50 });
    const stale = old.filter(
      (m) =>
        m.author.id === client.user.id &&
        m.components?.some((row) =>
          row.components?.some((c) => String(c.customId).startsWith("role:"))
        )
    );
    for (const [, m] of stale) {
      await m.delete().catch(() => {});
    }

    const picker = buildRolePicker();

    await channel.send({
      embeds: [picker.embed],
      components: [picker.row],
      files: [picker.file],
    });
    console.log(`Role-select setup posted to #${channel.name}.`);
  } catch (err) {
    console.error(err);
  }
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);