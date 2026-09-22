import { ActivityType } from "discord.js";
import db from "../db.js";
import { rescheduleOpenTickets } from "../lib/tickets.js";
import { resumePendingPayments } from "../lib/payments.js";

// Runs once after the gateway connection is established. This is where
// startup-time work belongs: a visible log line, the custom-status
// emoji (the <:name:id> string is resolved by emoji ID only), and
// registering the bot's slash commands for each guild it's in.
export default {
  name: "ready",
  once: true,
  async execute(client) {
    console.log(`Logged in as ${client.user.tag}`);

    await client.user.setPresence({
      status: "online",
      activities: [
        {
          type: ActivityType.Custom,
          name: "Managing Hustlers",
          state: "Managing Hustlers",
        },
      ],
    });

    const commands = [...client.commands.values()].map((c) => c.data);
    await client.application.commands.set(commands);
    for (const guild of client.guilds.cache.values()) {
      await guild.commands.set([]);
    }
    console.log(`Registered ${commands.length} command(s) globally (works in DMs)`);

    // A redeploy shouldn't leave every chat AI-paused because an earlier build
    // auto-paused tickets when an admin typed. AI is only paused via the
    // explicit "Stop the AI" button, so clear stale flags on boot.
    db.prepare("UPDATE tickets SET human_taken = 0 WHERE status = 'open'").run();

    rescheduleOpenTickets(client);
    const open = db.prepare("SELECT * FROM tickets WHERE status = 'open'").all();
    for (const t of open) {
      console.log(
        `OPEN-TICKET #${t.id} mode=${t.mode} user=${t.user_id} human=${t.human_taken} chan=${t.channel_id} admin=${t.admin_channel_id} dm=${t.user_dm_channel_id}`
      );
    }
    console.log(`Resumed timers for ${open.length} open ticket(s)`);

    resumePendingPayments(client);
  },
};