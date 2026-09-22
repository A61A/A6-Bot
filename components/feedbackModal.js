// Placeholder wiring for the feedback modal. The "/feedback" command
// that opens it isn't built yet; this keeps interactionCreate.js's
// routing complete so the bot boots. Replace with real logic later.
export const feedbackModal = {
  async execute(interaction) {
    const text = interaction.fields?.getTextInputValue?.("feedback_text");

    await interaction.reply({
      content: text ? "Thanks for your feedback — noted!" : "Thanks for reaching out!",
      ephemeral: true,
    });
  },
};