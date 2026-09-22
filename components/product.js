import { brandedEmbed } from "../config/embeds.js";

const PRODUCT_DETAILS = {
  nsfw_vip: {
    title: "SOON",
    desc: "Coming soon.",
  },
  spotify: {
    title: "Lifetime Spotify Premium",
    desc: "Lifetime Spotify Premium on your account — ad-free music, offline downloads, and skip-anywhere access.",
  },
  netflix: {
    title: "HD Netflix Accounts",
    desc: "High-definition Netflix account access with stable credentials and long-term validity.",
  },
  hbomax: {
    title: "HBO Max",
    desc: "HBO Max account access — every series, movie, and premiere in streaming quality.",
  },
  disney: {
    title: "Disney+",
    desc: "Disney+ account access — all the classics, Marvel, Star Wars, and new releases.",
  },
  prime: {
    title: "Prime Video",
    desc: "Prime Video account access — exclusive Originals and a huge on-demand library.",
  },
};

export function buildProductPage(value, member) {
  const product = PRODUCT_DETAILS[value] ?? {
    title: "Unknown",
    desc: "That option is still being set up.",
  };

  const embed = brandedEmbed({
    title: product.title,
    description: `${member}\n\n${product.desc}`,
  });

  return { embed, row: undefined };
}