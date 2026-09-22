// Placeholder wiring for the "topic" string-select menu. The feature
// behind "/topics" isn't built yet; this keeps interactionCreate.js's
// routing complete so the bot boots. Replace with real logic later.
export const topicSelect = {
  async execute(interaction) {
    const [, ...topicParts] = interaction.customId.split(":");
    const topic = topicParts.join(":") || interaction.values[0];

    await interaction.reply({
      content: topic
        ? `Selected: **${topic}** (topic feature not built yet).`
        : "Something went wrong — please try again.",
      ephemeral: true,
    });
  },
};