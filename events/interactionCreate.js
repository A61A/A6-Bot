import { feedbackModal } from "../components/feedbackModal.js";
import { topicSelect } from "../components/topicSelect.js";
import { roleButtons } from "../components/roleButtons.js";
import { onboardChoice } from "../components/onboardChoice.js";
import { hubButtons } from "../components/hubButtons.js";
import { infButtons } from "../components/infButtons.js";
import { portalButtons } from "../components/portalButtons.js";
import { adminModal } from "../components/adminModal.js";
import { redeemHandler } from "../components/redeem.js";
import { ticketButtons } from "../components/ticketButtons.js";
import { kioskButtons } from "../components/kioskButtons.js";
import { payButtons } from "../components/payButtons.js";
import { scheduleReplyDeletion } from "../utils/autoDelete.js";

// customId is the string you set when you BUILD a button/dropdown/modal
// (e.g. "role:developer"). We split on ":" so one handler file can serve
// several related buttons — "role:developer", "role:designer", etc.
export default {
  name: "interactionCreate",
  async execute(interaction) {
    try {
      if (interaction.isChatInputCommand()) {
        const command = interaction.client.commands.get(interaction.commandName);
        if (!command) return;
        await command.execute(interaction);
        scheduleReplyDeletion(interaction);
        return;
      }

      if (interaction.isButton()) {
        const [kind] = interaction.customId.split(":");
        if (kind === "role") return await dispatch(roleButtons, interaction);
        if (kind === "onboard") return await dispatch(onboardChoice, interaction);
        if (kind === "hub") return await dispatch(hubButtons, interaction);
        if (kind === "portal") return await dispatch(portalButtons, interaction);
        if (kind === "inf") return await dispatch(infButtons, interaction);
        if (kind === "ticket") return await dispatch(ticketButtons, interaction);
        if (kind === "kiosk") return await dispatch(kioskButtons, interaction);
        if (kind === "pay") return await dispatch(payButtons, interaction);
        return;
      }

      if (interaction.isStringSelectMenu()) {
        const [kind] = interaction.customId.split(":");
        if (kind === "topic") return await dispatch(topicSelect, interaction);
        if (kind === "portal") return await dispatch(portalButtons, interaction);
        return;
      }

      if (interaction.isModalSubmit()) {
        const [kind] = interaction.customId.split(":");
        if (kind === "feedback") return await dispatch(feedbackModal, interaction);
        if (kind === "inf") return await dispatch(adminModal, interaction);
        if (kind === "portal") return await dispatch(redeemHandler, interaction);
        return;
      }
    } catch (err) {
      console.error("Interaction error:", err?.message || err);
      // The original error may itself be an expired interaction (10062) — and
      // so may this catch-up. Swallow it; the process must never die here.
      try {
        const payload = { content: "Something went wrong running that.", ephemeral: true };
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp(payload);
        } else if (interaction.isRepliable?.()) {
          await interaction.reply(payload);
        }
      } catch (inner) {
        console.error("Could not respond after an interaction error:", inner?.message || inner);
      }
    }
  },
};

async function dispatch(handler, interaction) {
  await handler.execute(interaction);
  scheduleReplyDeletion(interaction);
}
