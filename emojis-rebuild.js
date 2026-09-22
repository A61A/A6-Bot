import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";

const BRAND = { r: 0xa7, g: 0x6e, b: 0xff }; // #A76EFF
const OUT_DIR = path.join(process.cwd(), "purple_emojis");
const LOG = "C:\\Users\\itrap\\AppData\\Local\\Temp\\opencode\\recolor.log";

function log(line) {
  console.log(line);
  fs.appendFileSync(LOG, line + "\n", "utf8");
}

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
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
    fs.mkdirSync(OUT_DIR, { recursive: true });

    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    const emojis = [...(await guild.emojis.fetch()).values()];
    log(`Found ${emojis.length} emojis`);

    // STEP 1: render all purpled versions to disk. No server changes yet.
    for (const e of emojis) {
      try {
        const ext = e.animated ? "gif" : "png";
        const res = await fetch(`https://cdn.discordapp.com/emojis/${e.id}.${ext}`);
        const tinted = await tintRaw(Buffer.from(await res.arrayBuffer()));
        fs.writeFileSync(path.join(OUT_DIR, `${e.name}.png`), tinted);
        log(`Rendered ${e.name}.png (${e.animated ? "first frame of gif" : "png"})`);
      } catch (err) {
        log(`RENDER FAILED ${e.name}: ${err.message?.slice(0, 80) || err}`);
      }
    }

    // STEP 2: delete current set, then import purpled versions in one go.
    log("Deleting originals...");
    let i = 0;
    for (const e of emojis) {
      try {
        await e.delete("Recoloring to brand purple");
        i++;
        if (i % 5 === 0) log(`Deleted ${i}/${emojis.length}`);
      } catch (err) {
        log(`DELETE FAILED ${e.name}: ${err.message?.slice(0, 80) || err}`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    log("Deleted all. Importing purpled versions...");

    const names = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith(".png"));
    for (const f of names) {
      try {
        const name = path.basename(f, ".png");
        const created = await guild.emojis.create({ attachment: fs.readFileSync(path.join(OUT_DIR, f)), name });
        log(`Imported ${name}=${created.id}`);
      } catch (err) {
        log(`IMPORT FAILED ${f}: ${err.message?.slice(0, 80) || err}`);
      }
      await new Promise((r) => setTimeout(r, 900));
    }
    log("DONE");
  } catch (err) {
    log(`FATAL: ${err.message || err}`);
    console.error(err);
  }
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);