import { buildAdminPanel } from "./admin.js";
import { buildPortalPage } from "./portal.js";
import { buildCreditModal } from "./adminModals.js";
import { createCode, codeExists } from "../balance.js";
import { brandedEmbed, bannerFile } from "../config/embeds.js";
import { isStaff } from "../config/roles.js";

// One-shot randomized code generator. Pressing either Gen button creates
// 10 random 6-character alphanumeric codes (letters + numbers) worth the
// button's credit value and shows them on an embed the admin can copy.
// Collisions with existing codes are skipped.
const CODE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function randomCode() {
  let code = "";
  for (let i = 0; i < 6; i += 1) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

function genCodes(credits) {
  const codes = [];
  let guard = 0;
  while (codes.length < 10 && guard < 1000) {
    guard += 1;
    const code = randomCode();
    if (codeExists(code)) continue;
    codes.push(code);
  }
  return codes;
}

export const hubButtons = {
  async execute(interaction) {
    const [, which] = interaction.customId.split(":");
    const user = interaction.user;

    if (which === "portal") {
      const { row, navRow } = buildPortalPage(1);
      await interaction.update({ embeds: [], components: [row, navRow] });
      return;
    }

    if (which === "inf") {
      if (!interaction.inGuild()) {
        await interaction.reply({
          content: "You don't have access to INF.",
          ephemeral: true,
        });
        return;
      }
      const hasAccess = isStaff(interaction.member);
      if (!hasAccess) {
        await interaction.reply({
          content: "You don't have access to INF.",
          ephemeral: true,
        });
        return;
      }
      const { embed, row } = buildAdminPanel();
      await interaction.update({ embeds: [embed], components: [row] });
      return;
    }
  },
};

export const infButtons = {
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

    const [, , action, ...rest] = interaction.customId.split(":");

    // rand(6):5 / rand(6):10 quick generators
    if (action === "gen") {
      const credits = parseInt(rest[0], 10);
      if (![5, 10].includes(credits)) {
        await interaction.reply({ content: "Bad value.", ephemeral: true });
        return;
      }

      const codes = genCodes(credits);
      const codesNow = codes.map((code) => {
        createCode(code, credits, 1, interaction.user.id);
        return code;
      });

      const embed = brandedEmbed({
        title: `${codesNow.length} Codes Generated — ${credits} Cr`,
        description: `\`\`\`\n${codesNow.join("\n")}\n\`\`\``,
      });
      await interaction.reply({ embeds: [embed], files: [bannerFile()], ephemeral: true });
      return;
    }

    if (action === "give" || action === "remove") {
      await interaction.showModal(buildCreditModal(action));
      return;
    }

    if (action === "products") {
      await interaction.reply({
        content: "Add/Remove products isn't built yet.",
        ephemeral: true,
      });
      return;
    }
  },
};