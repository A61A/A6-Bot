import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { brandedEmbed } from "../config/embeds.js";
import { getCredits } from "../balance.js";

export function buildHub(user, { showInf = true } = {}) {
  const credits = getCredits(user.id);
  const embed = brandedEmbed({
    title: "Customer Portal",
    fields: [
      {
        name: "User Info",
        value: `User: ${user.username}`,
        inline: true,
      },
      {
        name: "Status",
        value: "Tier: TBA\nMode: TBA\nExpires: ∞",
        inline: true,
      },
      {
        name: "Pocket",
        value: `Balance: **${credits}** credits`,
      },
    ],
  });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("hub:portal")
      .setLabel("Portal")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("hub:pocket")
      .setLabel("Pocket")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("hub:support")
      .setLabel("Support")
      .setStyle(ButtonStyle.Secondary),
    ...(showInf
      ? [
          new ButtonBuilder()
            .setCustomId("hub:inf")
            .setLabel("INF")
            .setStyle(ButtonStyle.Secondary),
        ]
      : [])
  );

  return { embed, row };
}