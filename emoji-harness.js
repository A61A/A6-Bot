import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";

const BRAND = { r: 0xa7, g: 0x6e, b: 0xff }; // #A76EFF
const OUT_DIR = path.join(process.cwd(), "purple_emojis");
const CLIENTS = path.join(process.cwd(), "applied.json");
const MODE = process.argv[2] || "inventory";
const LIMIT = Number(process.argv[3] || 5);

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
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

client.once("ready", async () => {
  try {
    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    const emojis = [...(await guild.emojis.fetch()).values()].sort((a, b) => a.name.localeCompare(b.name));

    if (MODE === "inventory") {
      console.log(`TOTAL=${emojis.length}`);
      for (const e of emojis) console.log(`${e.name}=${e.id}${e.animated ? " (gif)" : ""}`);
      process.exit(0);
    }

    if (MODE === "render") {
      fs.rmSync(OUT_DIR, { recursive: true, force: true });
      fs.mkdirSync(OUT_DIR, { recursive: true });
      for (const e of emojis) {
        const ext = e.animated ? "gif" : "png";
        const res = await fetch(`https://cdn.discordapp.com/emojis/${e.id}.${ext}`);
        const tinted = await tintRaw(Buffer.from(await res.arrayBuffer()));
        fs.writeFileSync(path.join(OUT_DIR, `${e.name}.png`), tinted);
        console.log(`rendered ${e.name}`);
      }
      console.log("RENDER_DONE");
      process.exit(0);
    }

    if (MODE === "apply") {
      const done = fs.existsSync(CLIENTS) ? JSON.parse(fs.readFileSync(CLIENTS, "utf8")) : {};
      const files = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith(".png") && !done[path.basename(f, ".png")]);
      const batch = files.slice(0, LIMIT);
      for (const f of batch) {
        const name = path.basename(f, ".png");
        const old = emojis.find((e) => e.name === name);
        const temp = await guild.emojis.create({
          attachment: fs.readFileSync(path.join(OUT_DIR, f)),
          name: `zz${name}`,
        });
        if (old) await old.delete("Recolored to brand purple");
        const renamed = await temp.edit({ name });
        done[name] = renamed.id;
        console.log(`applied ${name}=${renamed.id}`);
        await new Promise((r) => setTimeout(r, 900));
      }
      fs.writeFileSync(CLIENTS, JSON.stringify(done, null, 2));
      const remaining = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith(".png")).length - Object.keys(done).length;
      console.log(`APPLY_BATCH_DONE remaining=${remaining}`);
      process.exit(0);
    }
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
  }
  process.exit(1);
});

client.login(process.env.DISCORD_TOKEN);