import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";

// Saves images posted in the #spam channel as server emojis.
// Name comes from the filename (sanitized to Discord's rules).
// Run from the folder with node save-emojis.js — safe to rerun:
// files already imported are skipped by name.

const SPAM_CHANNEL = "spam";
const SUPPORTED = { png: true, jpg: true, jpeg: true, gif: true };
const MAX_MESSAGES = 100;

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

function sanitizeName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32) || "emoji";
}

client.once("ready", async () => {
  try {
    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    const channel = guild.channels.cache.find((c) => c.name === SPAM_CHANNEL);
    if (!channel) {
      console.error(`No #${SPAM_CHANNEL} channel found`);
      process.exit(1);
    }

    const existing = new Set((await guild.emojis.fetch()).map((e) => e.name));
    const messages = await channel.messages.fetch({ limit: MAX_MESSAGES });
    const files = [];

    for (const msg of messages.values()) {
      for (const att of msg.attachments.values()) {
        const ext = att.name.split(".").pop()?.toLowerCase();
        if (!SUPPORTED[ext] || att.size > 262144) continue; // 256 KB limit
        files.push({ url: att.url, name: sanitizeName(att.name.split(".")[0]) });
      }

      // Also grab custom emojis typed in messages (<:name:id> or <a:name:id>)
      for (const match of msg.content.matchAll(/<(a?):([A-Za-z0-9_]+):(\d+)>/g)) {
        const [, animated, name, id] = match;
        const url = `https://cdn.discordapp.com/emojis/${id}.${animated ? "gif" : "png"}`;
        files.push({ url, name: sanitizeName(name) });
      }
    }

    console.log(`Found ${files.length} image attachment(s)`);
    let imported = 0;
    const skipped = [];

    for (const f of files) {
      if (existing.has(f.name)) {
        skipped.push(f.name);
        continue;
      }
      try {
        const res = await fetch(f.url);
        if (!res.ok) { skipped.push(`${f.name} (download failed)`); continue; }
        const buf = Buffer.from(await res.arrayBuffer());
        await guild.emojis.create({ attachment: buf, name: f.name });
        console.log(`Imported: ${f.name}`);
        imported++;
        existing.add(f.name);
        await new Promise((r) => setTimeout(r, 800)); // stay under rate limits
      } catch (err) {
        skipped.push(`${f.name} (${err.message?.slice(0, 60) || err})`);
      }
    }

    console.log(`Done. Imported ${imported}, skipped ${skipped.length}: ${skipped.join(", ")}`);
  } catch (err) {
    console.error(err);
  }
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);