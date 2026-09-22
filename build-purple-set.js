import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";

const BRAND = { r: 0xa7, g: 0x6e, b: 0xff }; // #A76EFF
const OUT_DIR = path.join(process.cwd(), "purple_emojis");
const SUPPORTED = { png: true, jpg: true, jpeg: true, gif: true, webp: true };

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

function sanitizeName(name) {
  return (name.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32) || "emoji");
}

async function tintRaw(buffer) {
  const { data, info } = await sharp(buffer)
    .removeAlpha()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 0) {
      data[i] = BRAND.r;
      data[i + 1] = BRAND.g;
      data[i + 2] = BRAND.b;
    }
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

async function savePurple(url, name) {
  const outPath = path.join(OUT_DIR, `${name}.png`);
  if (fs.existsSync(outPath)) return "dup";
  const res = await fetch(url);
  if (!res.ok) return `fail:${res.status}`;
  const tinted = await tintRaw(Buffer.from(await res.arrayBuffer()));
  fs.writeFileSync(outPath, tinted);
  return "ok";
}

client.once("ready", async () => {
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    const channel = guild.channels.cache.find((c) => c.name === "spam");
    if (!channel) { console.log("NO_SPAM_CHANNEL"); process.exit(1); }

    const messages = await channel.messages.fetch({ limit: 100 });
    let ok = 0, dup = 0, bad = 0;

    for (const msg of messages.values()) {
      for (const att of msg.attachments.values()) {
        const ext = att.name.split(".").pop()?.toLowerCase();
        if (!SUPPORTED[ext]) continue;
        const name = sanitizeName(att.name.split(".")[0]);
        const r = await savePurple(att.url, name);
        if (r === "ok") { ok++; console.log(`saved ${name}`); }
        else if (r === "dup") dup++;
        else { bad++; console.log(`FAILED ${name} (${r})`); }
      }
      for (const match of msg.content.matchAll(/<(a?):([A-Za-z0-9_]+):(\d+)>/g)) {
        const [, animated, name, id] = match;
        const url = `https://cdn.discordapp.com/emojis/${id}.${animated ? "gif" : "png"}`;
        const r = await savePurple(url, sanitizeName(name));
        if (r === "ok") { ok++; console.log(`saved ${sanitizeName(name)}`); }
        else if (r === "dup") dup++;
        else { bad++; console.log(`FAILED ${name} (${r})`); }
      }
    }

    const total = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith(".png")).length;
    console.log(`TOTAL_FILES=${total} new=${ok} dup=${dup} bad=${bad}`);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
  }
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);