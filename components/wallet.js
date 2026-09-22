import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { brandedEmbed } from "../config/embeds.js";
import { getCredits } from "../balance.js";

export function buildWallet(user) {
  const credits = getCredits(user.id);
  const embed = brandedEmbed({
    title: "Pocket",
    description: `Hello! You have **${credits}** credits.\n\nNeed more? Pick a payment method below!`,
  });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("portal:redeembtn")
      .setLabel("Redeem")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("portal:buycredits")
      .setLabel("Buy Credits - Crypto")
      .setStyle(ButtonStyle.Success)
  );

  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("hub:home")
      .setLabel("Back to Hub")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setLabel("Purchase Credits")
      .setURL("https://pleasers.mysellauth.com/")
      .setStyle(ButtonStyle.Link)
  );

  return { embed, row, navRow };
}