import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { brandedEmbed, bannerFile } from "../config/embeds.js";

// Pulled out on its own so guildMemberAdd (channel greeting), onboardChoice
// (DM path) and the permanent #role-select message all build the exact same
// picker. "who" is optional: pass a Member for a personalized greeting line,
// or omit it for the permanent channel copy.
export function buildRolePicker(who) {
  const embed = brandedEmbed({
    description: who
      ? `${who}, click the obvious..`
      : "click the obvious..",
  });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("role:shopper")
      .setLabel("Shopper")
      .setEmoji("<:file:1550345595183566960>")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("role:reseller")
      .setLabel("Reseller")
      .setEmoji("<:hand:1550368986309337129>")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true)
  );

  return { embed, row, file: bannerFile() };
}
