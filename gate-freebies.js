import "dotenv/config";
import { Client, GatewayIntentBits, PermissionFlagsBits } from "discord.js";

// Gates the "✰ freebies ✰" category behind the SOON role: @everyone loses
// View Channel, the SOON role gets in (plus the server owner + bot so
// structure stays workable). Runs the same overwrites on the category and
// every channel under it. Safe to rerun — overwrites are idempotent.
const CATEGORY_NAME = "✰ freebies ✰";
const SOON_ROLE_NAME = "SOON";

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

client.once("ready", async () => {
  try {
    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    const owner = await guild.members.fetch(guild.ownerId);
    const botRole = guild.members.me.roles.highest;

    const soonRole = guild.roles.cache.find((r) => r.name === SOON_ROLE_NAME);
    if (!soonRole) {
      console.error(`Role "${SOON_ROLE_NAME}" not found — run ensure-roles.js first.`);
      process.exit(1);
    }

    const category = guild.channels.cache.find((c) => c.name === CATEGORY_NAME && c.type === 4);
    if (!category) {
      console.error(`Category "${CATEGORY_NAME}" not found.`);
      process.exit(1);
    }

    const targets = [category];
    for (const ch of guild.channels.cache.values()) {
      if (ch.parentId === category.id) targets.push(ch);
    }

    for (const ch of targets) {
      await ch.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: false });
      await ch.permissionOverwrites.edit(soonRole, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
      });
      await ch.permissionOverwrites.edit(owner, { ViewChannel: true });
      if (botRole && botRole.id !== guild.roles.everyone.id) {
        await ch.permissionOverwrites.edit(botRole, { ViewChannel: true });
      }
      console.log(`Gated: ${ch.name}`);
    }

    console.log(`Done. Users who pick the ${SOON_ROLE_NAME} role can now view ${CATEGORY_NAME}.`);
  } catch (err) {
    console.error(err);
  }
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);