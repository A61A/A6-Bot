import { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } from "discord.js";
import db from "../db.js";
import { INF_ROLE_ID, ADMIN_USER_IDS } from "../config/roles.js";

export const TICKET_TTL_MS = 24 * 60 * 60 * 1000; // 24h of inactivity
const timers = new Map();

function shortName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20) || "ticket";
}

function staffUserOverrides() {
  return ADMIN_USER_IDS.map((id) => ({
    id,
    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels],
  }));
}

// The unified chat: the AI replies in the user's DM, and a visible ticket
// channel mirrors both sides. User DM messages post to the ticket, AI replies
// post to both, and an admin replying in the ticket sends the message back to
// the user's DM. channel_id == admin_channel_id == the ticket channel, so a
// message or button press in either the DM or the ticket resolves this row.
export async function createChatTicket(client, user, dmChannel) {
  const guild = client.guilds.cache.get(process.env.GUILD_ID);
  if (!guild) throw new Error("Support relay couldn't find the server.");

  const category =
    guild.channels.cache.get(process.env.SUPPORT_CATEGORY_ID || "1513400828512174181") ??
    (await guild.channels.create({ name: "Support-Inbox", type: 4 }));

  const ticket = openTicket({ userId: user.id, mode: "dm-ai", userDmChannelId: dmChannel.id });

  const ticketChannel = await guild.channels.create({
    name: `ticket-${shortName(user.username)}-${ticket.id}`,
    type: 0,
    parent: category.id,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      { id: INF_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] },
      ...staffUserOverrides(),
    ],
  });

  // One channel does double duty: the visible ticket AND the admin inbox.
  db.prepare("UPDATE tickets SET channel_id = ?, admin_channel_id = ? WHERE id = ?").run(ticketChannel.id, ticketChannel.id, ticket.id);
  console.log(`CHAT-CREATED #${ticket.id} ticket=${ticketChannel.id} (${guild.name})`);

  // The AI toggle + close live in the ticket channel (admin side only) — the
  // customer gets a clean DM with no control buttons.
  const adminRow = new ActionRowBuilder().addComponents(
    buildAiToggleButton(ticket),
    new ButtonBuilder()
      .setCustomId("ticket:close")
      .setLabel("Close Chat")
      .setStyle(ButtonStyle.Danger)
  );

  try {
    await dmChannel.send({
      embeds: [
        {
          color: 0x0b048f,
          title: `Chat #${ticket.id} — Open`,
          description: `One chat with our support team, right here in DMs. Reply to this DM and support answers right back; a ticket was opened in the server so the team can follow along.\n\nJust say if you want to speak to a real person.`,
        },
      ],
    });
    console.log(`CHAT-INTRO sent to DM ${dmChannel.id} for #${ticket.id}`);
  } catch (err) {
    console.error(`CHAT-INTRO-DM failed for #${ticket.id}: ${err?.message || err}`);
  }

  try {
    await ticketChannel.send({
      embeds: [
        {
          color: 0x0b048f,
          title: `Ticket #${ticket.id} — ${user.username}`,
          description: `Admin view of the user's DM conversation. The customer's messages post here; **reply in this channel** to message them back in their DMs. Use **"🤖 Pause Replies"** below to pause the bot's replies if a human needs to take over.`,
        },
      ],
      components: [adminRow],
    });
    console.log(`CHAT-INTRO sent to ticket ${ticketChannel.id} for #${ticket.id}`);
  } catch (err) {
    console.error(`CHAT-INTRO-TICKET failed for #${ticket.id}: ${err?.message || err}`);
  }

  return { ticket: db.prepare("SELECT * FROM tickets WHERE id = ?").get(ticket.id), ticketChannel };
}

// "Pause/Resume" toggle for the bot's replies. human_taken = 1 means paused.
export function buildAiToggleButton(ticket) {
  const paused = ticket.human_taken === 1;
  return new ButtonBuilder()
    .setCustomId("ticket:aitoggle")
    .setStyle(ButtonStyle.Secondary)
    .setLabel(paused ? "🤖 Resume Replies" : "🤖 Pause Replies");
}

export function setAiEnabled(ticketId, enabled) {
  db.prepare("UPDATE tickets SET human_taken = ? WHERE id = ?").run(enabled ? 0 : 1, ticketId);
}

export function openTicket({ userId, mode, channelId = null, adminChannelId = null, userDmChannelId = null }) {
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO tickets (user_id, mode, channel_id, admin_channel_id, user_dm_channel_id, status, created_at, last_message)
       VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`
    )
    .run(userId, mode, channelId, adminChannelId, userDmChannelId, now, now);
  const ticket = db.prepare("SELECT * FROM tickets WHERE id = ?").get(info.lastInsertRowid);
  console.log(`TICKET-OPEN #${ticket.id} mode=${mode} user=${userId} chan=${channelId} admin=${adminChannelId} dm=${userDmChannelId}`);
  return ticket;
}

// If a ticket channel survives a redeploy that lost its DB record (e.g. before
// the persistent volume was added), the channel becomes orphaned and messages
// in it stop hitting the AI. Recreate the row lazily so the ticket just works.
// The owner is recovered from the channel's permission overwrites, falling back
// to whoever triggered the recovery.
export function recoverChannelTicket(channel, fallbackUserId) {
  const channelId = channel.id;
  const existing = db
    .prepare("SELECT * FROM tickets WHERE channel_id = ? AND status = 'open' LIMIT 1")
    .get(channelId);
  if (existing) return existing;

  let ownerId = fallbackUserId;
  try {
    for (const [id, ovw] of channel.permissionOverwrites.cache) {
      if (id === channel.guild.roles.everyone.id || id === INF_ROLE_ID) continue;
      if (ovw.allow.has(PermissionFlagsBits.ViewChannel)) {
        ownerId = id;
        break;
      }
    }
  } catch {
    // fall back to whoever is messaging
  }

  const ticket = openTicket({ userId: ownerId, mode: "channel", channelId });
  console.log(`TICKET-RECOVER: recreated open ticket #${ticket.id} for channel ${channelId} (user ${ownerId})`);
  return ticket;
}

export function getOpenTicketByUser(userId) {
  return db.prepare("SELECT * FROM tickets WHERE user_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1").get(userId);
}

export function getOpenTickets() {
  return db.prepare("SELECT * FROM tickets WHERE status = 'open'").all();
}

export function getTicketByChannel(channelId) {
  return db
    .prepare("SELECT * FROM tickets WHERE status = 'open' AND (channel_id = ? OR admin_channel_id = ? OR user_dm_channel_id = ?) LIMIT 1")
    .get(channelId, channelId, channelId);
}

export function getOpenTicketByDm(userId, dmChannelId) {
  return db
    .prepare("SELECT * FROM tickets WHERE status = 'open' AND user_id = ? AND user_dm_channel_id = ? LIMIT 1")
    .get(userId, dmChannelId);
}

export function touch(ticketId) {
  db.prepare("UPDATE tickets SET last_message = ? WHERE id = ?").run(Date.now(), ticketId);
}

// Once an admin responds, the AI hands off and stops typing.
export function markHumanTaken(ticketId) {
  db.prepare("UPDATE tickets SET human_taken = 1 WHERE id = ?").run(ticketId);
}

export function closeTicket(ticketId) {
  db.prepare("UPDATE tickets SET status = 'closed' WHERE id = ?").run(ticketId);
  const timer = timers.get(ticketId);
  if (timer) {
    clearTimeout(timer);
    timers.delete(ticketId);
  }
}

export function getTimer(ticketId) {
  return timers.get(ticketId);
}

export function scheduleAutoClose(client, ticket, ttl = TICKET_TTL_MS) {
  const existing = timers.get(ticket.id);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(async () => {
    timers.delete(ticket.id);
    await autoCloseTicket(client, ticket, "Auto-closed after 24h of inactivity.");
  }, ttl);
  timer.unref?.();
  timers.set(ticket.id, timer);
}

async function deleteChannelIfExists(client, id, reason) {
  if (!id) return;
  try {
    const channel = await client.channels.fetch(id);
    if (channel && channel.deletable) await channel.delete(reason);
  } catch {
    // channel already gone
  }
}

export async function autoCloseTicket(client, ticket, reason, notify = true) {
  closeTicket(ticket.id);
  if (ticket.mode === "channel") {
    await deleteChannelIfExists(client, ticket.channel_id, reason);
  } else {
    await deleteChannelIfExists(client, ticket.admin_channel_id, reason);
    if (notify) {
      try {
        const dm = await client.users.fetch(ticket.user_id);
        await dm.send("Your chat has been closed. Thanks for reaching out!");
      } catch {
        // user DMs disabled
      }
    }
  }
}

// On boot: resume the idle timer for any tickets left open by a restart.
export function rescheduleOpenTickets(client) {
  for (const ticket of getOpenTickets()) {
    const elapsed = Date.now() - ticket.last_message;
    const remaining = TICKET_TTL_MS - elapsed;
    if (remaining <= 0) {
      autoCloseTicket(client, ticket, "Auto-closed after 24h of inactivity.").catch(() => {});
    } else {
      scheduleAutoClose(client, ticket, remaining);
    }
  }
}
