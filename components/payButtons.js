import { cancelPayment } from "../lib/payments.js";

export const payButtons = {
  async execute(interaction) {
    const [, action, id] = interaction.customId.split(":");

    if (action === "cancel" && id) {
      await cancelPayment(interaction.client, Number(id), interaction);
      return;
    }
  },
};