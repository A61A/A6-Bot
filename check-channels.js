import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";

const TARGETS = ["Welcome", "Community", "Voice", "rules", "announcements", "role-select", "general", "bot-commands", "General VC", "Music"];

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("ready", async () => {
  const guild = await client.guilds.fetch(process.env.GUILD_ID);
  const channels = await guild.channels.fetch();
  const everyone = guild.roles.everyone;

  for (const name of TARGETS) {
    const ch = channels.find((c) => c.name === name);
    if (!ch) { console.log(`${name}: NOT FOUND`); continue; }
    const perm = ch.permissionsFor(everyone);
    console.log(`${name}: canView(@everyone)=${perm?.has("ViewChannel")}`);
  }
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);