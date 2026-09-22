import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from "discord.js";

export function buildRedeemModal() {
  const modal = new ModalBuilder()
    .setCustomId("portal:redeemmodal")
    .setTitle("Redeem a Code");

  const codeInput = new TextInputBuilder()
    .setCustomId("code")
    .setLabel("Redeem code")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(codeInput));
  return modal;
}