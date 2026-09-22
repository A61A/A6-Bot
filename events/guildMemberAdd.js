import { getChannel } from "../config/channels.js";
import { brandedEmbed, bannerFile } from "../config/embeds.js";

// If two bot connections are briefly alive together (e.g. during a Railway
// deploy, the old instance drains while the new one connects), both receive
// the same guildMemberAdd event. Dedupe by member ID within a short window
// so the welcome message only ever posts once per join.
const recentlyGreeted = new Map();

export default {
  name: "guildMemberAdd",
  async execute(member) {
    // Guard against double delivery from overlapping connections.
    const last = recentlyGreeted.get(member.id);
    if (last && Date.now() - last < 30_000) return;
    recentlyGreeted.set(member.id, Date.now());

    // Base role first — every member gets this immediately, independent
    // of whether they ever pick a specialty. If the role doesn't exist
    // on the member's side, this logs and continues instead of crashing
    // the join flow for the user.
    const baseRoleId = process.env.BASE_ROLE_ID || "1550358014916165712";
    const baseRole = member.guild.roles.cache.get(baseRoleId);
    if (baseRole) {
      await member.roles.add(baseRole);
    } else {
      console.warn(`Base role "${baseRoleId}" not found — skipping auto-assign`);
    }

    // Greet in the welcome channel and point the member at #role-select,
    // which holds the permanent role picker. Keeping the picker in one
    // place instead of re-posting it per join keeps the welcome channel
    // clean and avoids duplicate/confusing role buttons.
    const channel = await getChannel(member.client, "welcome");
    if (!channel) return;

    const roleSelect = await getChannel(member.client, "roleSelect");
    const where = roleSelect ? `${roleSelect}` : `**role-select**`;

    const embed = brandedEmbed({
      title: "One more step!",
      description: `Head over to ${where} to pick your role and unlock the matching channels.`,
    });

    await channel.send({ content: `Welcome to the server ${member}`, embeds: [embed], files: [bannerFile()] });
    // No auto-delete: the welcome is meant to stay so latecomers can still
    // find the role-select channel. (Other bot replies still use the countdown flow.)
  },
};
