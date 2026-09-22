import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from "discord.js";

export function buildCreditModal(action) {
  const isGive = action === "give";

  const modal = new ModalBuilder()
    .setCustomId(`inf:modal:${action}`)
    .setTitle(isGive ? "Give Credits" : "Remove Credits");

  const userInput = new TextInputBuilder()
    .setCustomId("target")
    .setLabel("User ID")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const amountInput = new TextInputBuilder()
    .setCustomId("amount")
    .setLabel("Amount")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(userInput),
    new ActionRowBuilder().addComponents(amountInput)
  );

  return modal;
}

export function buildCodeModal() {
  const modal = new ModalBuilder()
    .setCustomId("inf:modal:createcode")
    .setTitle("Create Redeem Code");

  const codeInput = new TextInputBuilder()
    .setCustomId("code")
    .setLabel("Code (letters/numbers, no spaces)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const creditsInput = new TextInputBuilder()
    .setCustomId("credits")
    .setLabel("Credits per use")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const usesInput = new TextInputBuilder()
    .setCustomId("uses")
    .setLabel("Uses (default 1)")
    .setStyle(TextInputStyle.Short)
    .setRequired(false);

  modal.addComponents(
    new ActionRowBuilder().addComponents(codeInput),
    new ActionRowBuilder().addComponents(creditsInput),
    new ActionRowBuilder().addComponents(usesInput)
  );

  return modal;
}