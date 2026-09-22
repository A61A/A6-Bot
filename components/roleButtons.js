// Handles the "role:<name>" buttons from the role picker. Known roles resolve
// by fixed ID (config/roles.js); anything else falls back to a name match,
// which is how setup-server.js/ensure-roles.js roles ("Reseller", etc.) work.
import { SHOPPER_ROLE_ID } from "../config/roles.js";

const ROLE_IDS = { shopper: SHOPPER_ROLE_ID };

function resolveRole(guild, key) {
  const id = ROLE_IDS[key];
  if (id) return guild.roles.cache.get(id);
  return guild.roles.cache.find((r) => r.name.toLowerCase() === key.toLowerCase());
}

export const roleButtons = {
  async execute(interaction) {
    const [, roleName] = interaction.customId.split(":");
    if (!roleName) return;

    const guild = interaction.member.guild;
    const role = resolveRole(guild, roleName);

    if (!role) {
      await interaction.reply({
        content: `The \`${roleName}\` role doesn't exist yet — run setup-server.js first.`,
        ephemeral: true,
      });
      return;
    }

    await interaction.member.roles.add(role);
    await interaction.reply({
      content: `You now have the **${role.name}** role.`,
      ephemeral: true,
    });
  },
};