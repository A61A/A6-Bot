import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from "discord.js";
import { brandedEmbed } from "../config/embeds.js";
import { PRODUCTS } from "../config/products.js";
import { getCredits, hasPurchased } from "../balance.js";

const PAGE_SIZE = 6;

export function buildPortalPage(page, selectedLabel) {
  const keys = Object.keys(PRODUCTS);
  const totalPages = Math.ceil(keys.length / PAGE_SIZE);
  const pageKeys = keys.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const select = new StringSelectMenuBuilder()
    .setCustomId("portal:select")
    .setPlaceholder(selectedLabel ? `Selected: ${selectedLabel}` : "Pick a product")
    .addOptions(
      pageKeys.map((key) => ({
        label: PRODUCTS[key].label,
        value: key,
      }))
    );

  const row = new ActionRowBuilder().addComponents(select);

  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("portal:home")
      .setLabel("Home")
      .setStyle(ButtonStyle.Secondary),
    ...(page > 1
      ? [
          new ButtonBuilder()
            .setCustomId(`portal:page:${page - 1}`)
            .setLabel("Back")
            .setStyle(ButtonStyle.Secondary),
        ]
      : []),
    ...(page < totalPages
      ? [
          new ButtonBuilder()
            .setCustomId(`portal:page:${page + 1}`)
            .setLabel("Next")
            .setStyle(ButtonStyle.Secondary),
        ]
      : [])
  );

  return { row, navRow };
}

export function buildProductPage(productKey, user, selectedVersionValue) {
  const product = PRODUCTS[productKey];
  const credits = getCredits(user.id);
  const comingSoon = product.comingSoon;
  const multiVersion = product.versions.length > 1;
  const selected = selectedVersionValue
    ? product.versions.find((v) => v.value === selectedVersionValue)
    : multiVersion
      ? undefined
      : product.versions[0];

  const alreadyOwned = product.once && hasPurchased(user.id, productKey);

  const embed = brandedEmbed({
    title: product.label,
    description: comingSoon ? "🚧 **This product is coming soon!**" : buildProductDescription(product, credits, selected),
  });

  let row = null;
  if (multiVersion) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(`portal:version:select:${productKey}`)
      .setPlaceholder("Choose a version")
      .setDisabled(comingSoon)
      .addOptions(
        product.versions.map((v) => ({
          label: `${v.label} — $${v.price}`,
          value: v.value,
        }))
      );
    row = new ActionRowBuilder().addComponents(select);
  }

  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("portal:list")
      .setLabel("Back to List")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(selected ? `portal:buy:${selected.value}` : "portal:buy:none")
      .setLabel(alreadyOwned ? "Already Owned" : "Purchase")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(comingSoon || !selected || alreadyOwned)
  );

  return { embed, row, actionRow };
}

const DIVIDER = "──────────────────";
const COL_DIVIDER = "──────────────────";

function buildProductDescription(product, credits, selected) {
  const version = selected ?? product.versions[0];
  const price = version.price;
  const remaining = Math.max(0, credits - price);
  const label = selected?.label ?? version.label;

  return [
    product.desc ?? "Details coming soon.",
    "",
    DIVIDER,
    `★  **Plan: ${label}**`,
    COL_DIVIDER,
    `**In Your Pocket:** $${credits}`,
    COL_DIVIDER,
    "After purchase:",
    `__$${remaining.toFixed(2)} remaining__`,
  ].join("\n");
}