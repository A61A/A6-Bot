import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
import sharp from "sharp";

const BRAND = { r: 0xa7, g: 0x6e, b: 0xff }; // #A76EFF

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

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
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toBuffer();
}

client.once("ready", async () => {
  try {
    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    const emojis = [...(await guild.emojis.fetch()).values()];
    console.log(`Processing ${emojis.length} emojis`);

    const results = [];
    for (const e of emojis) {
      try {
        const ext = e.animated ? "gif" : "png";
        const res = await fetch(`https://cdn.discordapp.com/emojis/${e.id}.${ext}`);
        const tinted = await tintRaw(Buffer.from(await res.arrayBuffer()));

        const tempName = `t_${e.name}_t`;
        const created = await guild.emojis.create({ attachment: tinted, name: tempName });
        await e.delete("Recoloring to brand purple");
        await created.edit({ name: e.name });
        console.log(`Recolored: ${e.name} (id ${created.id})${e.animated ? " [was animated, now static]" : ""}`);
        results.push({ name: e.name, id: created.id });
        await new Promise((r) => setTimeout(r, 900));
      } catch (err) {
        console.log(`FAILED: ${e.name} — ${err.message?.slice(0, 80) || err}`);
      }
    }

    console.log("--- NEW IDS (name=id) ---");
    for (const r of results) console.log(`${r.name}=${r.id}`);
  } catch (err) {
    console.error(err);
  }
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);