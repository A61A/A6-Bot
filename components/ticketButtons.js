import { getTicketByChannel, closeTicket, autoCloseTicket, getOpenTickets, createChatTicket, scheduleAutoClose, setAiEnabled } from "../lib/tickets.js";
import { INF_ROLE_ID, isStaff } from "../config/roles.js";

export const ticketButtons = {
  async execute(interaction) {
    const [, action, mode] = interaction.customId.split(":");

    // The single Support chat button: one AI + admin conversation in DMs.
    if (action === "mode") {
      console.log(`TICKET-BTN: customId=${interaction.customId} by ${interaction.user.tag} inGuild=${interaction.inGuild()}`);
      // Lock in the interaction token immediately — creating the DM chat can
      // outlive the response window, and stale (>15 min old) button presses
      // can arrive already-expired, which would throw 10062 on update().
      await interaction.deferUpdate().catch(() => {});
      // Starting a new chat auto-closes any previous open ones for this user
      // (some early tests left several). notify=false: the same person is
      // immediately starting a new chat, so a "closed" DM would be noise.
      const stale = getOpenTickets().filter((t) => t.user_id === interaction.user.id);
      for (const t of stale) {
        await autoCloseTicket(interaction.client, t, `Closed before opening a new chat`, false);
      }

      let dmChannel = interaction.channel?.isDMBased?.() ? interaction.channel : null;
      if (!dmChannel) {
        try {
          dmChannel = await interaction.user.createDM();
        } catch {
          await interaction.editReply({ content: "I couldn't open a DM with you. Enable DMs and try again.", embeds: [], components: [] }).catch(() => {});
          return;
        }
      }
      try {
        const { ticket } = await createChatTicket(interaction.client, interaction.user, dmChannel);
        scheduleAutoClose(interaction.client, ticket);
        await interaction.editReply({
          content: `Your chat (#${ticket.id}) is open — reply to **A7** in your DMs and support answers right there. If it can't help, a real person jumps in.`,
          embeds: [],
          components: [],
        });
      } catch (err) {
        console.error(`CHAT-FAIL for ${interaction.user.tag}: ${err?.message || err}`);
        await interaction.editReply({ content: "Couldn't start your chat. Try again.", embeds: [], components: [] }).catch(() => {});
      }
      return;
    }

    const ticket = getTicketByChannel(interaction.channel.id);
    if (!ticket) {
      await interaction.reply({
        content: "This chat is already closed or no longer exists.",
        ephemeral: true,
      });
      return;
    }

    if (action === "aitoggle") {
      // Admin-side control: the toggle button only appears in the ticket channel.
      if (!isStaff(interaction.member)) {
        await interaction.reply({ content: "Admins only.", ephemeral: true });
        return;
      }
      const newState = ticket.human_taken === 1 ? 0 : 1; // 1 = AI paused
      setAiEnabled(ticket.id, newState === 0);
      await interaction.reply({
        content:
          newState === 1
            ? "The bot's replies are now **paused** — a real person is handling this customer. Press the button again to bring replies back."
            : "Replies are back **on** — the bot answers the customer in their DMs again.",
        ephemeral: true,
      });
      return;
    }

    if (action === "pingadmin") {
      const hasAdmin = isStaff(interaction.member);
      const isOwner = interaction.user.id === ticket.user_id;
      if (!hasAdmin && !isOwner) {
        await interaction.reply({ content: "Only the ticket owner or admins can do that.", ephemeral: true });
        return;
      }
      if (ticket.mode === "dm-ai") {
        const adminChannel = await interaction.client.channels
          .fetch(ticket.admin_channel_id)
          .catch(() => null);
        if (adminChannel) {
          await adminChannel
            .send({ content: `<@&${INF_ROLE_ID}> A customer pinged for help in ticket #${ticket.id}.` })
            .catch(() => {});
        }
        await interaction.reply({ content: "A ping went out to the support team.", ephemeral: true });
      } else {
        await interaction.reply({ content: `<@&${INF_ROLE_ID}> Pinging an admin to help.`, ephemeral: true });
      }
      return;
    }

    if (action === "close") {
      const hasAdmin = isStaff(interaction.member);
      const isOwner = interaction.user.id === ticket.user_id;
      if (!hasAdmin && !isOwner) {
        await interaction.reply({ content: "Only the ticket owner or admins can close this.", ephemeral: true });
        return;
      }
      await interaction.update({ content: "Closing chat...", embeds: [], components: [] }).catch(() => {});
      await autoCloseTicket(interaction.client, ticket, `Ticket closed by ${interaction.user.tag}`);
      return;
    }
  },
};

export function closeTicketById(ticketId) {
  closeTicket(ticketId);
}