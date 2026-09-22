import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } from "discord.js";
import { brandedEmbed, bannerFile } from "../config/embeds.js";
import { PRODUCTS } from "../config/products.js";
import { getCredits, spendCredits, hasPurchased, addPurchase } from "../balance.js";
import { buildPortalPage, buildProductPage } from "./portal.js";
import { buildWallet } from "./wallet.js";
import { buildHub } from "./hub.js";
import { buildRedeemModal } from "./redeemModal.js";
import { startCryptoCheckout, SUPPORTED_COINS } from "../lib/payments.js";

// Memoize each user's in-progress product pick (keyed by user id).
const pendingPick = new Map();

function findVersion(pair) {
  const [productKey] = pair.split(":");
  const product = PRODUCTS[productKey];
  const version = product?.versions.find((v) => v.value === pair);
  return { product, version };
}

function coinSelectRow(customId, placeholder, coins = SUPPORTED_COINS) {
  const select = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder)
    .addOptions(
      coins.map((c) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(c.label)
          .setValue(c.value)
          .setDescription(`Pay with ${c.value}`)
      )
    );
  return new ActionRowBuilder().addComponents(select);
}

// XMR has a 0.01 XMR floor (~$5.50) on Plisio, so it can't do a $5 invoice.
// Hide it below that amount; it returns at $6+.
function coinsForAmount(amount) {
  if (amount >= 6) return SUPPORTED_COINS;
  return SUPPORTED_COINS.filter((c) => c.value !== "XMR");
}

function backRow(customId, label = "Back") {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(ButtonStyle.Secondary)
  );
}

export const portalButtons = {
  async execute(interaction) {
    const [, ...rest] = interaction.customId.split(":");
    const user = interaction.user;

    // Product dropdown -> open the product embed
    if (rest[0] === "select") {
      const choice = interaction.values?.[0];
      if (!choice) return;
      const page = pendingPick.get(user.id)?.page || 1;
      pendingPick.set(user.id, { key: choice, page });
      const { embed, row, actionRow } = buildProductPage(choice, user);
      await interaction.update({ embeds: [embed], components: [row, actionRow].filter(Boolean) });
      return;
    }

    // Back-to-list -> return to the product list page it came from
    if (rest[0] === "list") {
      const page = pendingPick.get(user.id)?.page || 1;
      const { row, navRow } = buildPortalPage(page);
      await interaction.update({ embeds: [], components: [row, navRow] });
      return;
    }

    // Page navigation (Next/Back between product pages)
    if (rest[0] === "page") {
      const page = Number(rest[1]) || 1;
      const pick = pendingPick.get(user.id) || { key: null };
      pendingPick.set(user.id, { ...pick, page });
      const { row, navRow } = buildPortalPage(page);
      await interaction.update({ embeds: [], components: [row, navRow] });
      return;
    }

    // Home -> back to the hub
    if (rest[0] === "home") {
      pendingPick.delete(user.id);
      const { embed, row } = buildHub(user, { showInf: interaction.inGuild() });
      await interaction.update({ embeds: [embed], components: [row] });
      return;
    }

    // Version dropdown -> update the product embed with the selected version
    if (rest[0] === "version") {
      const productKey = rest[2];
      const pair = interaction.values?.[0];
      if (!productKey || !pair) return;
      const { embed, row, actionRow } = buildProductPage(productKey, user, pair);
      await interaction.update({ embeds: [embed], components: [row, actionRow].filter(Boolean) });
      return;
    }

    if (rest[0] === "wallet") {
      const { embed, row, navRow } = buildWallet(user);
      await interaction.update({ embeds: [embed], components: [row, navRow] });
      return;
    }

    if (rest[0] === "redeembtn") {
      await interaction.showModal(buildRedeemModal());
      return;
    }

    // Buy Credits - Crypto: amount picker → coin picker → checkout.
    if (rest[0] === "buycredits") {
      const amount = Number(rest[1]);
      if (!amount) {
        if (rest[1] === "coin") {
          // Step 2 — the user picked a coin from the dropdown.
          const coin = interaction.values?.[0];
          const amt = Number(rest[2]);
          if (!coin || !amt) return;
          await interaction.deferUpdate().catch(() => {});
          interaction.noAutoDelete = true;
          try {
            await startCryptoCheckout({
              client: interaction.client,
              interaction,
              kind: "credits",
              credits: amt,
              usdAmount: amt,
              currency: coin,
              purposeNote: `Pleasers — ${amt} credits top-up`,
            });
          } catch (err) {
            console.error(`BUYCREDITS-FAIL for ${interaction.user.tag}: ${err?.message || err}`);
          }
          return;
        }
        // Step 0 — pick an amount (grey buttons, 2 rows of 2).
        const amounts = [5, 10, 25, 50];
        const rows = [];
        for (let i = 0; i < amounts.length; i += 2) {
          rows.push(
            new ActionRowBuilder().addComponents(
              amounts.slice(i, i + 2).map((a) =>
                new ButtonBuilder()
                  .setCustomId(`portal:buycredits:${a}`)
                  .setLabel(`$${a} = ${a} credits`)
                  .setStyle(ButtonStyle.Secondary)
              )
            )
          );
        }
        await interaction.update({ embeds: [brandedEmbed({ title: "Buy Credits", description: `Pick an amount. $1 = **1 credit**.` })], components: rows });
        return;
      }
      // Step 1 — amount chosen: show the coin dropdown.
      await interaction.deferUpdate().catch(() => {});
      await interaction
        .followUp({
          embeds: [
            brandedEmbed({
              title: "Choose a Coin",
              description: `Buy **$${amount} = ${amount} credits** — pick the coin you want to pay with.`,
            }),
          ],
          components: [coinSelectRow(`portal:buycredits:coin:${amount}`, "Pick a coin to pay with", coinsForAmount(amount)), backRow("portal:buycredits")],
          files: [bannerFile()],
          ephemeral: true,
        })
        .catch(() => {});
      return;
    }

    // Buy product short on credits — Back/Dismiss: close the coin dropdown.
    if (rest[0] === "buycoin" && rest[1] === "dismiss") {
      await interaction.update({
        embeds: [brandedEmbed({ title: "Checkout Cancelled", description: "No payment was started." })],
        components: [],
      });
      return;
    }

    // Buy product short on credits — Step 2: coin chosen, start checkout.
    if (rest[0] === "buycoin" && rest[1] === "coin") {
      const coin = interaction.values?.[0];
      const pair = rest.slice(2).join(":");
      if (!coin || !pair) return;
      const { product, version } = findVersion(pair);
      const [productKey] = pair.split(":");
      if (!product || !version) return;
      await interaction.deferUpdate().catch(() => {});
      interaction.noAutoDelete = true;
      try {
        await startCryptoCheckout({
          client: interaction.client,
          interaction,
          kind: "buy",
          productKey,
          product,
          version,
          credits: version.price,
          usdAmount: version.price,
          currency: coin,
          purposeNote: `Pleasers — ${product.label} (${version.label})`,
        });
      } catch (err) {
        console.error(`CHECKOUT-FAIL for ${interaction.user.tag}: ${err?.message || err}`);
      }
      return;
    }

    // Purchase button -> pays from credits, or starts a crypto checkout if the
    // user is short (same button, no dead-ended "Purchase Failed").
    if (rest[0] === "buy") {
      const pair = rest.slice(1).join(":");
      const [productKey] = pair.split(":");
      const { product, version } = findVersion(pair);
      if (!product || !version) return;

      if (product.once && hasPurchased(interaction.user.id, productKey)) {
        await interaction.update({
          embeds: [
            brandedEmbed({
              title: "Already Owned",
              description: `You already own **${product.label}** — you can't buy it twice.`,
            }),
          ],
          components: [],
        });
        return;
      }

      const before = getCredits(interaction.user.id);
      if (before < version.price) {
        // Short on credits -> crypto checkout. Offer a coin picker first (QR +
        // address + live timer show for whatever coin the user chose).
        interaction.noAutoDelete = true;
        await interaction.deferUpdate().catch(() => {});
        await interaction
          .followUp({
            embeds: [
              brandedEmbed({
                title: "Choose a Coin",
                description: `Pay for **${product.label} — ${version.label}** ($${version.price}) with:`,
              }),
            ],
            components: [coinSelectRow(`portal:buycoin:coin:${pair}`, "Pick a coin to pay with", coinsForAmount(version.price)), backRow("portal:buycoin:dismiss")],
            files: [bannerFile()],
            ephemeral: true,
          })
          .catch(() => {});
        return;
      }

      const remaining = spendCredits(interaction.user.id, version.price, `buy:${pair}`);

      if (product.once) addPurchase(interaction.user.id, productKey, pair, version.price);

      let roleNote = "";
      if (product.roleId && interaction.inGuild()) {
        const role = interaction.member.guild.roles.cache.get(product.roleId);
        if (role) {
          await interaction.member.roles.add(role);
          roleNote = `\n\n✅ Granted the **${role.name}** role.`;
        } else {
          roleNote = "\n\n⚠️ Purchase succeeded, but your role couldn't be found in the server.";
        }
      }

      const embed = brandedEmbed({
        title: "Purchase Complete",
        description: `Purchased **${product.label} — ${version.label}** for **${version.price} credits**.\n\nBalance: **${remaining}** credits.${roleNote}`,
      });

      const backRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("hub:portal")
          .setLabel("Back to Portal")
          .setStyle(ButtonStyle.Secondary)
      );

      await interaction.update({ embeds: [embed], components: [backRow] });
      return;
    }
  },
};