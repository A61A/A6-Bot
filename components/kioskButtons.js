import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { brandedEmbed, bannerFile } from "../config/embeds.js";
import { buildPortalPage } from "./portal.js";
import { buildWallet } from "./wallet.js";

// A permanent message posted in a channel (see post-kiosk.js) that shows the
// bot's entry points for everyone. Every button replies EPHEMERALLY — the
// reply is private to the person who clicked, so two members can use Portal /
// Pocket / Support at the same time without ever rewriting each other's view.
export function buildKioskMessage() {
  const embed = brandedEmbed({
    title: "How To Use A7",
    description:
      "Pick a button — everything opens privately, just for you.\n\n" +
      "<:ARROW2:1550345589588496394> Portal — browse the catalog & spend your credits\n" +
      "<:ARROW2:1550345589588496394> Pocket — check your balance, redeem codes\n" +
      "<:ARROW2:1550345589588496394> Support — open a chat, we reply in your DMs",
  });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("kiosk:portal")
      .setLabel("Portal")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("kiosk:pocket")
      .setLabel("Pocket")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("kiosk:support")
      .setLabel("Support")
      .setStyle(ButtonStyle.Secondary)
  );

  return { embed, row1, row: row1, file: bannerFile() };
}

export const kioskButtons = {
  async execute(interaction) {
    const [, which] = interaction.customId.split(":");
    const user = interaction.user;

    if (which === "portal") {
      const menuEmbed = brandedEmbed({
        title: "Portal",
        description: "Pick a product below to view it and purchase.",
      });
      const { row, navRow } = buildPortalPage(1);
      await interaction.reply({ embeds: [menuEmbed], components: [row, navRow], files: [bannerFile()], ephemeral: true });
      return;
    }

    if (which === "pocket") {
      const { embed, row, navRow } = buildWallet(user);
      await interaction.reply({ embeds: [embed], components: [row, navRow], files: [bannerFile()], ephemeral: true });
      return;
    }

    if (which === "buycredits") {
      // Same amount picker the Pocket uses — reuse the portal:buycredits flow
      // (the buttons below reply ephemerally, so the kiosk stays untouched).
      const amounts = [5, 10, 25, 50];
      const pickRows = [];
      for (let i = 0; i < amounts.length; i += 2) {
        pickRows.push(
          new ActionRowBuilder().addComponents(
            amounts.slice(i, i + 2).map((a) =>
              new ButtonBuilder()
                .setCustomId(`portal:buycredits:${a}`)
                .setLabel(`$${a} = ${a} credits`)
                .setStyle(ButtonStyle.Secondary)
            )
          )
        );
      }
      await interaction.reply({
        embeds: [brandedEmbed({ title: "Buy Credits", description: `Pick an amount. $1 = **1 credit**. Pay with crypto (XMR/BTC/USDT/…) — pick your coin and the QR + address appear right there.` })],
        components: pickRows,
        files: [bannerFile()],
        ephemeral: true,
      });
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
  },
};