import { addCredits, spendCredits, createCode } from "../balance.js";
import { brandedEmbed, bannerFile } from "../config/embeds.js";
import { isStaff } from "../config/roles.js";

export const adminModal = {
  async execute(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: "No access.", ephemeral: true });
      return;
    }
    const hasAccess = isStaff(interaction.member);
    if (!hasAccess) {
      await interaction.reply({ content: "No access.", ephemeral: true });
      return;
    }

    const [, , action] = interaction.customId.split(":");
    const fields = Object.fromEntries(interaction.fields.fields.map((f) => [f.customId, f.value]));

    if (action === "give" || action === "remove") {
      const target = fields.target.trim();
      const amount = Math.abs(parseInt(fields.amount, 10)) || 0;
      if (!target || amount <= 0) {
        await interaction.reply({ content: "Invalid User ID or amount.", ephemeral: true });
        return;
      }

      if (action === "give") {
        addCredits(target, amount, "admin:give");
      } else {
        spendCredits(target, amount, "admin:remove");
      }

      const embed = brandedEmbed({
        title: action === "give" ? "Credits Given" : "Credits Removed",
        description: `**${action === "give" ? "+" : "-"}${amount}** → \`${target}\``,
      });
      await interaction.reply({ embeds: [embed], files: [bannerFile()], ephemeral: true });
      return;
    }

    if (action === "createcode") {
      const code = fields.code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
      const credits = Math.abs(parseInt(fields.credits, 10)) || 0;
      const uses = Math.max(1, Math.abs(parseInt(fields.uses, 10) || 1));

      if (!code || credits <= 0) {
        await interaction.reply({ content: "Invalid code or credits.", ephemeral: true });
        return;
      }

      createCode(code, credits, uses, interaction.user.id);

      const embed = brandedEmbed({
        title: "Code Created",
        description: `**${code}** — ${credits} credits × ${uses} use(s)`,
      });
      await interaction.reply({ embeds: [embed], files: [bannerFile()], ephemeral: true });
      return;
    }
  },
};