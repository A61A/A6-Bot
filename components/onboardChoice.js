import { buildRolePicker } from "./rolePicker.js";

export const onboardChoice = {
  async execute(interaction) {
    const [, choice, memberId] = interaction.customId.split(":");
    const { embed, row, file } = buildRolePicker(interaction.member);

    // These buttons are scoped to the member who was welcomed — nobody else
    // should be able to run the onboard picker off someone else's message.
    if (memberId && interaction.user.id !== memberId) {
      await interaction.reply({
        content: "That button isn't for you.",
        ephemeral: true,
      });
      return;
    }

    if (choice === "here") {
      // Ephemeral so the channel doesn't fill up with one role-picker
      // per new member — only the person who clicked sees this copy.
      await interaction.reply({ embeds: [embed], components: [row], files: [file], ephemeral: true });
      return;
    }

    if (choice === "dm") {
      try {
        await interaction.user.send({ embeds: [embed], components: [row], files: [file] });
        await interaction.reply({ content: "Sent — check your DMs.", ephemeral: true });
      } catch {
        // Most common cause: the user has DMs from server members/bots
        // turned off. Fall back to the in-channel picker instead of
        // leaving them with no way to set roles at all.
        const fallback = buildRolePicker(interaction.member);
        await interaction.reply({
          content: "I couldn't DM you — your privacy settings might be blocking it. Pick here instead:",
          embeds: [fallback.embed],
          components: [fallback.row],
          files: [fallback.file],
          ephemeral: true,
        });
      }
    }
  },
};
