import { redeemCode } from "../balance.js";
import { brandedEmbed, bannerFile } from "../config/embeds.js";

export const redeemHandler = {
  async execute(interaction) {
    const code = interaction.fields.getTextInputValue("code").trim().toUpperCase();
    const result = redeemCode(interaction.user.id, code);

    const embed = brandedEmbed({
      title: "Redeem",
      description: result.ok
        ? `Redeemed **${result.credits} credits**.\nNew balance: **${result.balance}**`
        : result.reason === "invalid"
          ? "That code isn't valid."
          : result.reason === "used"
            ? "That code has already been used up."
            : "You've already redeemed that code.",
    });

    await interaction.reply({ embeds: [embed], files: [bannerFile()], ephemeral: true });
  },
};