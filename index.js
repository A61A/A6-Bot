import "dotenv/config";
import { Client, GatewayIntentBits, Collection } from "discord.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startWebServer } from "./server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Intents = which event streams Discord will actually send you.
// Guilds is required for basically everything; GuildMessages + MessageContent
// are only needed because the AI module listens for plain messages, not
// just slash commands. DirectMessages is required for the support chat: the
// customer's DM replies relay to the ticket and the AI answers in their DMs.
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // required for guildMemberAdd — also a privileged
    // intent you must toggle on in the Developer Portal under Bot > Privileged Gateway Intents
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.DirectMessages,
  ],
});

// client.commands is a Map from command name -> command module, so the
// interactionCreate handler can look up "which code runs for /chat" in O(1)
// instead of an if/else chain that grows forever.
client.commands = new Collection();

async function loadCommands() {
  const commandsPath = path.join(__dirname, "commands");
  for (const folder of fs.readdirSync(commandsPath)) {
    const folderPath = path.join(commandsPath, folder);
    for (const file of fs.readdirSync(folderPath).filter((f) => f.endsWith(".js"))) {
      const command = (await import(`file://${path.join(folderPath, file)}`)).default;
      client.commands.set(command.data.name, command);
    }
  }
}

async function loadEvents() {
  const eventsPath = path.join(__dirname, "events");
  for (const file of fs.readdirSync(eventsPath).filter((f) => f.endsWith(".js"))) {
    const event = (await import(`file://${path.join(eventsPath, file)}`)).default;
    // once() for startup events like "ready", on() for everything recurring
    client[event.once ? "once" : "on"](event.name, (...args) => event.execute(...args, client));
  }
}

await loadCommands();
await loadEvents();

// The web storefront (public/) rides along on the same process — Railway
// exposes $PORT and serves index.html at the project URL.
startWebServer();

// Never let a single failing interaction or stale button click bring the bot
// down. Log it, then keep running — Railway restarts are disruptive mid-chat.
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection (bot keeps running):", err?.message || err);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (bot keeps running):", err?.message || err);
});
client.on("error", (err) => console.error("Client error:", err?.message || err));

client.login(process.env.DISCORD_TOKEN);
