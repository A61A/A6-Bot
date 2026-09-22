import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { brandedEmbed } from "../config/embeds.js";

export function buildAdminPanel() {
  const embed = brandedEmbed({
    
    title: "INF — Admin Controls",
    description: "Manage balances and redeem codes.",
  });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("inf:btn:remove")
      .setLabel("Remove Credits")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("inf:btn:gen:5")
      .setLabel("Give 5")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("inf:btn:gen:10")
      .setLabel("Give 10")
      .setStyle(ButtonStyle.Secondary)
  );

  const backRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("hub:home")
      .setLabel("Back to Hub")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("inf:btn:products")
      .setLabel("Add/Remove")
      .setStyle(ButtonStyle.Secondary)
  );

  return { embed, row, backRow };
}