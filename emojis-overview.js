import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";

const SPAM_CHANNEL = "spam";

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

client.once("ready", async () => {
  const guild = await client.guilds.fetch(process.env.GUILD_ID);
  const serverEmojis = await guild.emojis.fetch();
  const channel = guild.channels.cache.find((c) => c.name === SPAM_CHANNEL);
  const messages = channel ? await channel.messages.fetch({ limit: 100 }) : new Map();

  const attCount = [...messages.values()].reduce((n, m) => n + m.attachments.size, 0);
  console.log(`Server emojis: ${serverEmojis.size}`);
  console.log(`#spam: ${messages.size} messages, ${attCount} attachments in oldest-100 scan`);

  console.log("--- Server emoji names ---");
  for (const e of serverEmojis.values()) console.log(e.name);
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);