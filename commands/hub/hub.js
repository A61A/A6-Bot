import { SlashCommandBuilder } from "discord.js";
import { buildHub } from "../../components/hub.js";
import { bannerFile } from "../../config/embeds.js";

export default {
  data: new SlashCommandBuilder()
    .setName("hub")
    .setDescription("Open the hub"),

  async execute(interaction) {
    const user = interaction.user;
    const showInf = interaction.inGuild();
    const { embed, row } = buildHub(user, { showInf });
    await interaction.reply({ embeds: [embed], components: [row], files: [bannerFile()], ephemeral: true });
  },
};