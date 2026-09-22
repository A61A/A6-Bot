import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
import { getChannel } from "./config/channels.js";
import { brandedEmbed, bannerFile } from "./config/embeds.js";

const TARGET_USER = "446137348904714241";

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

client.once("ready", async () => {
  try {
    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    const member = await guild.members.fetch(TARGET_USER);

    const channel = await getChannel(client, "welcome");
    if (!channel) return;

    const roleSelect = await getChannel(client, "roleSelect");
    const where = roleSelect ? `${roleSelect}` : `**role-select**`;

    const embed = brandedEmbed({
      title: "One more step!",
      description: `Head over to ${where} to pick your role and unlock the matching channels.`,
    });

    await channel.send({ content: `Welcome to the server ${member}`, embeds: [embed], files: [bannerFile()] });
    console.log(`Welcome message sent to ${member.user.tag} in ${channel.name}`);
  } catch (err) {
    console.error(err);
  }
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);