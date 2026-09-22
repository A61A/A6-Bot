import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { getAiReply } from "../lib/ai.js";
import {
  getTicketByChannel,
  getOpenTicketByDm,
  recoverChannelTicket,
  touch,
  scheduleAutoClose,
  markHumanTaken,
  buildAiToggleButton,
} from "../lib/tickets.js";
import { INF_ROLE_ID, isStaff } from "../config/roles.js";

// In-memory conversation history per ticket so the AI keeps context.
const history = new Map(); // ticketId -> [{role, content}]

// Cooldown so repeated DM guidance doesn't spam the user.
const lastGuidance = new Map(); // dmChannelId -> timestamp

function getHistory(ticketId) {
  if (!history.has(ticketId)) history.set(ticketId, []);
  return history.get(ticketId);
}

function pushHistory(ticketId, role, content) {
  const h = getHistory(ticketId);
  h.push({ role, content });
  if (h.length > 20) h.splice(0, h.length - 20);
}

function startTypingLoop(channel, ticketId) {
  // Discord typing indicators expire after ~10s, so re-pulse every 5s to keep
  // "A7 is typing..." visible in the customer's DM for the whole AI call.
  let first = true;
  const pulse = async () => {
    try {
      await channel.sendTyping();
      if (first) console.log(`TYPING ok #${ticketId} channel=${channel.id} kind=${channel.constructor.name}`);
    } catch (err) {
      console.error(`TYPING failed #${ticketId} channel=${channel.id} kind=${channel.constructor.name}: ${err?.message || err}`);
    }
    first = false;
  };
  pulse();
  const interval = setInterval(pulse, 5000);
  interval.unref?.();
  return () => clearInterval(interval);
}

async function sendAiReply(channel, ticket, userMessage, opts = {}) {
  const h = getHistory(ticket.id);
  const { reply, escalate } = await getAiReply(h, userMessage);
  pushHistory(ticket.id, "assistant", reply);
  console.log(`TICKET-AI reply#${ticket.id} escalate=${escalate}: ${reply.slice(0, 120)}`);

  const content = reply.length > 2000 ? `${reply.slice(0, 1997)}...` : reply;

  // Unified chat: the AI lives in the customer's DM. No buttons here — the AI
  // toggle is admin-only (in the ticket channel); escalation pings the ticket.
  if (ticket.mode === "dm" || ticket.mode === "dm-ai") {
    await channel.send({ content });
    if (escalate && opts.ticketSide) {
      await opts.ticketSide
        .send({ content: `<@&${INF_ROLE_ID}> The AI couldn't resolve ticket #${ticket.id} — a human is needed.` })
        .catch(() => {});
    }
    return { message: content, escalate };
  }

  // Legacy standalone ticket channel: AI replies in-place with controls.
  const row = new ActionRowBuilder().addComponents(
    buildAiToggleButton(ticket),
    new ButtonBuilder()
      .setCustomId("ticket:pingadmin")
      .setLabel("Ping an Admin")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("ticket:close")
      .setLabel("Close Chat")
      .setStyle(ButtonStyle.Danger)
  );

  let sent;
  if (escalate) {
    sent = await channel.send({
      content: `<@&${INF_ROLE_ID}> An admin is needed!`,
      embeds: [
        {
          color: 0xa76eff,
          description: `**AI couldn't resolve this.**\n\n${reply}`,
        },
      ],
      components: [row],
    });
  } else {
    sent = await channel.send({ content, components: [row] });
  }
  return { message: sent, escalate };
}

async function relayToAdmin(adminChannel, ticket, author, content) {
  const embed = {
    color: 0x57f287,
    author: { name: author.username, icon_url: author.displayAvatarURL() },
    description: content,
    timestamp: new Date().toISOString(),
  };
  // No "Reply" button: admins reply by just typing in the ticket channel.
  const row = new ActionRowBuilder().addComponents(
    buildAiToggleButton(ticket),
    new ButtonBuilder()
      .setCustomId("ticket:close")
      .setLabel("Close Chat")
      .setStyle(ButtonStyle.Danger)
  );
  try {
    await adminChannel.send({ embeds: [embed], components: [row] });
    console.log(`TICKET-DM-ADMIN channel#${adminChannel.id} got relayed message`);
  } catch (err) {
    console.error(`TICKET-DM relay failed: ${err?.message || err}`);
  }
}

export default {
  name: "messageCreate",
  async execute(message) {
    try {
    if (message.author.bot) return;
    const client = message.client;

    // Determines what context this message is in.
    const isDm = message.channel.isDMBased?.();
    if (isDm) console.log(`DM-IN from ${message.author.tag} (channel=${message.channel.id})`);
    let ticket = isDm
      ? getOpenTicketByDm(message.author.id, message.channel.id)
      : getTicketByChannel(message.channel.id);

    // A DM with no open chat: tell the user how to start it once.
    if (isDm && !ticket) {
      const key = message.channel.id;
      const now = Date.now();
      if (now - (lastGuidance.get(key) || 0) > 60_000) {
        lastGuidance.set(key, now);
        await message.channel.send({
          embeds: [
            {
              color: 0xa76eff,
              title: "Chat with A7",
              description: "No open chat yet. Open **Customer Portal → Support → 💬 DM Relay** and this DM becomes your support conversation with the team.",
            },
          ],
        }).catch(() => {});
      }
      return;
    }

    // A message in a guild ticket channel with no open record is an orphaned
    // ticket (its row was lost by an old ephemeral DB, or an admin deleted the
    // channel). Recreate the record so the AI + admin relay both work again.
    if (!ticket && !isDm && /^(ticket|ai-ticket)-/.test(message.channel.name ?? "")) {
      ticket = recoverChannelTicket(message.channel, message.author.id);
    }

    if (!ticket) return;

    console.log(`TICKET-MSG: ticket #${ticket.id} (mode=${ticket.mode}) msg from ${message.author.tag} in ${message.channel.name || "DM"}`);

    // Refresh the 24h inactivity timer.
    touch(ticket.id);
    scheduleAutoClose(client, ticket);

    // ----- Unified chat (dm / dm-ai): customer DMs <-> ticket channel. -----
    if (ticket.mode === "dm" || ticket.mode === "dm-ai") {
      let dmSide = ticket.user_dm_channel_id ? await client.channels.fetch(ticket.user_dm_channel_id).catch(() => null) : null;
      // channels.fetch can miss DM channels after a redeploy; fall back to
      // resolving the user's DM so the bot can always reach the customer.
      if (!dmSide && ticket.user_id) {
        dmSide = await client.users.fetch(ticket.user_id).then((u) => u.createDM()).catch(() => null);
      }
      const ticketSide = ticket.admin_channel_id ? await client.channels.fetch(ticket.admin_channel_id).catch(() => null) : null;

      // Admin replying in the ticket channel -> the reply goes to the customer's
      // DM. This does NOT pause the AI (it only pauses via the admin toggle).
      if (message.channel.id === ticket.admin_channel_id && hasAdminRole(message)) {
        console.log(`CHAT-RELAY #${ticket.id} admin->DM`);
        try {
          const dm = await client.users.fetch(ticket.user_id);
          const dmChannel = await dm.createDM();
          const embed = {
            color: 0x5865f2,
            author: { name: `Support (${message.author.username})`, icon_url: message.author.displayAvatarURL() },
            description: message.content,
            timestamp: new Date().toISOString(),
          };
          await dmChannel.send({ embeds: [embed] });
        } catch (err) {
          console.error(`CHAT-RELAY #${ticket.id} admin->DM failed: ${err?.message || err}`);
        }
        return;
      }

      const isFromDm = message.channel.id === ticket.user_dm_channel_id;
      const isFromTicket = message.channel.id === ticket.channel_id;
      if (!isFromDm && !isFromTicket) return;

      // Mirror the customer's message to whichever side it didn't come from,
      // so the full conversation is visible in both places.
      if (isFromDm && ticketSide) {
        console.log(`CHAT-RELAY #${ticket.id} DM->ticket`);
        await relayToAdmin(ticketSide, ticket, message.author, message.content).catch(() => {});
      } else if (isFromTicket && dmSide) {
        console.log(`CHAT-RELAY #${ticket.id} ticket->DM`);
        const embed = {
          color: 0x57f287,
          author: { name: message.author.username, icon_url: message.author.displayAvatarURL() },
          description: message.content,
          timestamp: new Date().toISOString(),
        };
        await dmSide.send({ embeds: [embed] }).catch((err) => {
          console.error(`CHAT-RELAY #${ticket.id} ticket->DM failed: ${err?.message || err}`);
        });
      }

      // AI switched off (admin toggle)? Let them know a real person is on it.
      if (ticket.human_taken) {
        const key = `resume-${ticket.id}`;
        const now = Date.now();
        if (now - (lastGuidance.get(key) || 0) > 120_000) {
          lastGuidance.set(key, now);
          const target = dmSide ?? message.channel;
          await target
            .send({ content: "A real person is handling this chat now." })
            .catch(() => {});
        }
        return;
      }

      pushHistory(ticket.id, "user", message.content);
      // The AI only ever replies in the customer's DM.
      const aiChannel = dmSide ?? message.channel;
      console.log(`CHAT-REPLY #${ticket.id} AI -> DM (${aiChannel.id})`);
      const stopTyping = startTypingLoop(aiChannel, ticket.id);
      try {
        await sendAiReply(aiChannel, ticket, message.content, { ticketSide });
      } finally {
        stopTyping();
      }
      return;
    }

    // Legacy standalone open ticket channel in the server: AI replies in-place.
    if (ticket.mode === "channel") {
      // An admin (not the owner) speaking here = human takes over.
      if (hasAdminRole(message) && message.author.id !== ticket.user_id) {
        markHumanTaken(ticket.id);
        console.log(`TICKET-ADMIN ticket #${ticket.id}: ${message.author.tag} took over (AI silenced)`);
        return;
      }
      // Only the ticket owner talks to the AI. Admins (including the owner if
      // they hold an admin role) don't get AI replies — the owner's own
      // messages must still trigger it for testing/marking-in.
      if (message.author.id !== ticket.user_id) return;

      pushHistory(ticket.id, "user", message.content);
      await message.channel.sendTyping();
      await sendAiReply(message.channel, ticket, message.content);
      return;
    }
  } catch (err) {
    console.error("TICKET-AI failed:", err?.message || err);
    try {
      await message.channel.send({
        content: "I hit an error responding. An admin has been notified.",
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("ticket:pingadmin").setLabel("Ping an Admin").setStyle(ButtonStyle.Secondary)
        )],
      });
    } catch {
      // nothing sensible to fall back to
    }
  }
  }
};

function hasAdminRole(message) {
  return isStaff(message.member);
}