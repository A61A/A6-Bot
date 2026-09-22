import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { buildAdminPanel } from "./admin.js";
import { buildPortalPage } from "./portal.js";
import { buildWallet } from "./wallet.js";
import { buildHub } from "./hub.js";
import { isStaff } from "../config/roles.js";

export const hubButtons = {
  async execute(interaction) {
    const [, which] = interaction.customId.split(":");
    const user = interaction.user;

    if (which === "home") {
      const { embed, row } = buildHub(user, { showInf: interaction.inGuild() });
      await interaction.update({ embeds: [embed], components: [row] });
      return;
    }

    if (which === "portal") {
      const { row, navRow } = buildPortalPage(1);
      await interaction.update({ embeds: [], components: [row, navRow] });
      return;
    }

    if (which === "pocket") {
      const { embed, row, navRow } = buildWallet(user);
      await interaction.update({ embeds: [embed], components: [row, navRow] });
      return;
    }

    if (which === "support") {
      const chatRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("ticket:mode:chat")
          .setLabel("💬 DM Relay")
          .setStyle(ButtonStyle.Primary)
      );
      await interaction.reply({
        content:
          `**💬 DM Relay** — one conversation with our support team, right here in your DMs.\n\n` +
          `A support agent picks up your chat from the ticket in the server and replies to you here — no need to wait around in a channel.`,
        ephemeral: true,
        components: [chatRow],
      });
      return;
    }

    if (which === "inf") {
      if (!interaction.inGuild()) {
        await interaction.reply({
          content: "You don't have access to INF.",
          ephemeral: true,
        });
        return;
      }
      const hasAccess = isStaff(interaction.member);
      if (!hasAccess) {
        await interaction.reply({
          content: "You don't have access to INF.",
          ephemeral: true,
        });
        return;
      }
      const { embed, row, backRow } = buildAdminPanel();
      await interaction.update({ embeds: [embed], components: [row, backRow] });
      return;
    }
  },
};