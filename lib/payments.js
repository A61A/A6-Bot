import { ActionRowBuilder, ButtonBuilder, ButtonStyle, WebhookClient } from "discord.js";
import db from "../db.js";
import { addCredits, addPurchase } from "../balance.js";
import { brandedEmbed, bannerFile, VIOLET, SUCCESS } from "../config/embeds.js";
import { PRODUCTS } from "../config/products.js";

export const PAYMENT_TTL_MS = 20 * 60 * 1000; // checkout expires after 20 min
export const POLL_INTERVAL_MS = 3_000; // embed refresh tick. 3s is the fastest we can sustain: Discord caps webhook edits at 30/min, and the 10s status poll eats ~6 of them, so every 3s = ~20/min sits safely under.
const STATUS_CHECK_MS = 10_000; // how often we actually hit the provider API
export const REQUIRED_CONFIRMATIONS = 3;

const timers = new Map(); // payment id -> { timer, payment }

// Provider selection: Plisio (link-based invoice) → NowPayments (inline QR +
// address) → simulator (no keys configured, auto-completes for testing).
const PROVIDER = process.env.PLISIO_API_KEY
  ? "plisio"
  : process.env.NOWPAYMENTS_API_KEY
    ? "nowpayments"
    : "sim";

export function payCurrency() {
  return (process.env.PAYMENT_CURRENCY || "btc").toLowerCase();
}

// Coins the user can pick in the checkout dropdown. Values are Plisio coin
// cids passed straight to /invoices/new (generic USDT/USDC aren't accepted —
// it's USDT_TON / USDC_BASE).
export const SUPPORTED_COINS = [
  { value: "BTC", label: "Bitcoin" },
  { value: "LTC", label: "Litecoin" },
  { value: "ETH", label: "Ethereum" },
  { value: "ETH_BASE", label: "Ethereum (Base)" },
  { value: "SOL", label: "Solana" },
  { value: "USDC_BASE", label: "USD Coin (USDC)" },
  { value: "USDT_TON", label: "Tether (USDT)" },
];

function qrUrl(address, payAmount, currency) {
  const data = `${currency.toLowerCase()}:${address}?amount=${payAmount}`;
  return `https://api.qrserver.com/v1/create-qr-code/?size=320x320&margin=10&data=${encodeURIComponent(data)}`;
}

function fmtCrypto(amount) {
  return Number(amount ?? 0).toFixed(8).replace(/0+$/, "").replace(/\.$/, "") || "0";
}

function usdLabel(kind) {
  return kind === "buy" ? "product payment" : "credit top-up";
}

// ---------------------------------------------------------------------------
// Plisio provider — creates a hosted payment invoice (link the customer opens
// to pay). Free tier: status is pollable via txn_id; wallet/QR only appear on
// the hosted page (or via White Label, not needed here).
// ---------------------------------------------------------------------------

async function plisioFetchInvoice(txnId) {
  const res = await fetch(`https://api.plisio.net/api/v1/invoices/${txnId}?api_key=${process.env.PLISIO_API_KEY}`, {
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json();
  if (!res.ok || data.status !== "success" || !data.data) {
    throw new Error(`Plisio status failed (${res.status})`);
  }
  return data.data.invoice || data.data;
}

async function plisioCreateInvoice({ usdAmount, currency, orderId, description }) {
  const url = new URL("https://api.plisio.net/api/v1/invoices/new");
  const params = {
    api_key: process.env.PLISIO_API_KEY,
    source_currency: "USD",
    source_amount: String(usdAmount),
    currency: currency.toUpperCase(),
    order_number: orderId,
    order_name: description || "Pleasers order",
    expire_min: String(Math.ceil(PAYMENT_TTL_MS / 60_000)),
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  const data = await res.json();
  if (!res.ok || data.status !== "success" || !data.data?.txn_id) {
    const msg = data.data?.message || data.message || "unknown Plisio error";
    throw new Error(`Plisio create failed (${res.status}): ${msg}`);
  }
  const txnId = String(data.data.txn_id);

  // The /invoices/new call assigns the invoice, but the per-invoice deposit
  // wallet + exact crypto amount only come back on the detail endpoint right
  // after — fetch it so the checkout can mint its own QR + address inline.
  let payAddress = null;
  let payAmount = Number(data.data.invoice_total_sum ?? 0);
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const inv = await plisioFetchInvoice(txnId);
      if (inv.wallet_hash) {
        payAddress = inv.wallet_hash;
        if (inv.amount) payAmount = Number(inv.amount);
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }

  return {
    providerId: txnId,
    checkoutUrl: data.data.invoice_url || null,
    payAmount,
    payCurrency: currency.toUpperCase(),
    payAddress,
    status: "waiting",
  };
}

async function plisioGetStatus(providerId) {
  const inv = await plisioFetchInvoice(providerId);
  return { status: mapPlisioStatus(inv.status), actuallyPaid: Number(inv.pending_amount ?? 0) };
}

function mapPlisioStatus(s) {
  // completed = paid in full; the rest are states/terminal outcomes.
  if (s === "completed") return "finished";
  if (["pending", "pending internal"].includes(s)) return "confirming";
  if (["failed", "error"].includes(s)) return "failed";
  if (s === "expired") return "expired";
  if (s === "new" || s === "waiting") return "waiting";
  return "pending";
}

// ---------------------------------------------------------------------------
// NowPayments provider (real API when a key is set, simulator otherwise so the
// whole flow is testable end-to-end before keys are configured).
// ---------------------------------------------------------------------------

async function npCreatePayment({ amountUsd, currency, orderId, description }) {
  const res = await fetch("https://api.nowpayments.io/v1/payment", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.NOWPAYMENTS_API_KEY,
    },
    body: JSON.stringify({
      price_amount: amountUsd,
      price_currency: "usd",
      pay_currency: currency,
      order_id: orderId,
      order_description: description,
      is_fixed_rate: true,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json();
  if (!res.ok || !data.payment_id) {
    throw new Error(`NowPayments create failed (${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
  }
  return {
    providerId: String(data.payment_id),
    payAddress: data.pay_address,
    payAmount: Number(data.pay_amount),
    payCurrency: data.pay_currency,
    status: data.payment_status || "waiting",
  };
}

async function npGetStatus(providerId) {
  const res = await fetch(`https://api.nowpayments.io/v1/payment/${providerId}/status`, {
    headers: { "x-api-key": process.env.NOWPAYMENTS_API_KEY },
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`NowPayments status failed (${res.status})`);
  return {
    status: data.payment_status || "pending",
    payAmount: Number(data.pay_amount ?? 0),
    actuallyPaid: Number(data.actually_paid ?? 0),
  };
}

function mockAddress(currency) {
  const hex = () => Array.from({ length: 26 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
  return currency === "btc" ? `bc1q${hex()}` : `4${hex()}`;
}

function mockRates(currency) {
  return { xmr: 140, btc: 60000, usdttrc20: 1, usdt: 1 }[currency] || 140;
}

async function mockCreatePayment({ amountUsd, currency }) {
  return {
    providerId: `sim-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    payAddress: mockAddress(currency),
    payAmount: Number((amountUsd / mockRates(currency)).toFixed(8)),
    payCurrency: currency,
    status: "waiting",
  };
}

function mockGetStatus(payment) {
  const elapsed = Date.now() - payment.created_at;
  if (elapsed < 8_000) return { status: "waiting" };
  if (elapsed < 16_000) return { status: "confirming" };
  return { status: "finished" };
}

function mapNpStatus(s) {
  if (["finished", "sending"].includes(s)) return "finished";
  if (["failed", "expired"].includes(s)) return "failed";
  if (["partially_paid", "confirming", "confirmed"].includes(s)) return "confirming";
  if (["waiting", "awaiting_payment"].includes(s)) return "waiting";
  return "pending";
}

async function createPayment({ usdAmount, orderId, description, currency: coin }) {
  const currency = (coin || payCurrency()).toLowerCase();
  let created;
  if (PROVIDER === "plisio") {
    created = await plisioCreateInvoice({ usdAmount, currency, orderId, description });
  } else if (PROVIDER === "nowpayments") {
    created = await npCreatePayment({ amountUsd: usdAmount, currency, orderId, description });
  } else {
    created = await mockCreatePayment({ amountUsd: usdAmount, currency });
  }
  console.log(`PAY-CREATE ${created.providerId} ${usdAmount}usd -> ${fmtCrypto(created.payAmount)} ${created.payCurrency} (${PROVIDER})`);
  return created;
}

async function fetchStatus(payment) {
  if (PROVIDER === "plisio") return plisioGetStatus(payment.provider_id);
  if (PROVIDER === "nowpayments") {
    const s = await npGetStatus(payment.provider_id);
    return { status: mapNpStatus(s.status), actuallyPaid: s.actuallyPaid };
  }
  return mockGetStatus(payment);
}

// ---------------------------------------------------------------------------
// Embed builders
// ---------------------------------------------------------------------------

function buildCheckoutEmbed(payment) {
  const currency = payment.pay_currency?.toUpperCase() || "CRYPTO";
  const purpose = payment.kind === "buy"
    ? `${payment.product_label ?? "product"}${payment.version_label ? ` — ${payment.version_label}` : ""}`
    : `${payment.credits} credits`;

  // Plisio's free tier is link-based: we can't mint a wallet/QR ourselves, the
  // hosted payment page handles it. When an address IS available (white-label
  // or NowPayments), render the QR + address directly.
  const fields = [
    {
      name: "Amount to send",
      value: payment.pay_amount
        ? `**${fmtCrypto(payment.pay_amount)} ${currency}** (≈ $${payment.usd_amount})`
        : `≈ $${payment.usd_amount}`,
    },
  ];
  if (payment.pay_address) {
    fields.push({ name: "Address", value: `\`${payment.pay_address}\`` });
  } else if (payment.checkout_url) {
    fields.push({ name: "Pay", value: "Click the **Pay** button below — it opens the secure payment page with the QR code + address." });
  }
  fields.push({ name: "Status", value: statusLine(payment) });

  return brandedEmbed({
    title: "Crypto Checkout",
    color: VIOLET,
    description: `You're paying for **${purpose}** (≈ $${payment.usd_amount}).`,
    fields,
    // The image slot belongs to the QR here, so the banner strip is skipped.
    image: payment.pay_address ? qrUrl(payment.pay_address, payment.pay_amount, payment.pay_currency) : undefined,
    noBanner: Boolean(payment.pay_address),
  });
}

function statusLine(payment) {
  const now = Date.now();
  const left = Math.max(0, payment.created_at + PAYMENT_TTL_MS - now);
  const mm = Math.floor(left / 60_000);
  const ss = String(Math.floor((left % 60_000) / 1000)).padStart(2, "0");
  const countdown = `Expires in **${mm}:${ss}**`;

  switch (payment.status) {
    case "cancelled":
      return "❌ **Cancelled.**";
    case "finished":
      return "✅ **Payment confirmed** — credits/product on the way.";
    case "failed":
      return "❌ **Payment failed.** Start a new checkout.";
    case "expired":
      return "⚠️ **This checkout expired.** Start a new one.";
    case "confirming":
      return `✅ **Payment received!** Waiting for ${REQUIRED_CONFIRMATIONS} confirmations on the network.\n\n${countdown}`;
    case "waiting":
      return `⏳ **Awaiting payment** — open the payment page ${payment.pay_address ? "and send the exact amount to the address below" : "and pay there"}.\n\n${countdown}`;
    default:
      return `⏳ **Pending**…\n\n${countdown}`;
  }
}

function buildSuccessEmbed(payment) {
  const detail = payment.kind === "buy"
    ? `**${payment.product_label ?? "Product"}${payment.version_label ? ` — ${payment.version_label}` : ""}**\nPaid: ${fmtCrypto(payment.pay_amount)} ${payment.pay_currency.toUpperCase()} ($${payment.usd_amount})`
    : `**${payment.credits} credits** added to your Pocket.\nPaid: ${fmtCrypto(payment.pay_amount)} ${payment.pay_currency.toUpperCase()} ($${payment.usd_amount})`;
  return brandedEmbed({
    title: "Payment Complete",
    color: SUCCESS,
    description: detail,
  });
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

function checkoutWebhook(client, payment) {
  // The checkout and origin embeds are ephemeral follow-ups, so they can't be
  // fetched from the channel — every live edit goes through the interaction
  // webhook (applicationId + token + message id).
  if (!payment.origin_token || !payment.origin_webhook_id) return null;
  return new WebhookClient({ id: payment.origin_webhook_id, token: payment.origin_token });
}

export async function startCryptoCheckout({ client, interaction, kind, productKey, product, version, credits, usdAmount, purposeNote, currency }) {
  const user = interaction.user;

  // Lock in the interaction token: honoring it later lets the bot poll-edit
  // the checkout embed and refresh the original product/pocket embed.
  const originMessageId = interaction.message?.id ?? null;
  const originToken = interaction.token ?? null;
  const originWebhookId = interaction.applicationId ?? null;

  // Cancel any older open checkout so a user never juggles two.
  const older = db.prepare(
    "SELECT id FROM payments WHERE user_id = ? AND kind = ? AND status IN ('pending','waiting','confirming')"
  ).all(user.id, kind);
  for (const row of older) {
    clearPaymentTimer(row.id);
    db.prepare("UPDATE payments SET status = 'cancelled' WHERE id = ?").run(row.id);
  }

  const orderId = `${kind}-${user.id}-${Date.now()}`;
  const created = await createPayment({
    usdAmount,
    orderId,
    description: purposeNote || `${usdLabel(kind)}: ${kind === "buy" ? product?.label : `${credits} credits`}`,
    currency,
  });

  const now = Date.now();
  const info = db.prepare(
    `INSERT INTO payments
       (user_id, kind, product_key, version_value, product_label, version_label, credits, usd_amount,
        pay_currency, pay_amount, pay_address, provider_id, status, origin_channel_id, origin_message_id, origin_token, origin_webhook_id, checkout_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    user.id,
    kind,
    productKey ?? null,
    version?.value ?? null,
    product?.label ?? null,
    version?.label ?? null,
    credits,
    usdAmount,
    created.payCurrency,
    created.payAmount,
    created.payAddress,
    created.providerId,
    interaction.channel?.id ?? null,
    originMessageId,
    originToken,
    originWebhookId,
    created.checkoutUrl ?? null,
    now,
    now
  );

  const payment = db.prepare("SELECT * FROM payments WHERE id = ?").get(info.lastInsertRowid);

  const embed = buildCheckoutEmbed(payment);
  const row = new ActionRowBuilder();
  if (payment.checkout_url && !payment.pay_address) {
    // Link-based checkout (Plisio): the hosted payment page owns the QR/address.
    row.addComponents(
      new ButtonBuilder()
        .setLabel("Pay")
        .setStyle(ButtonStyle.Link)
        .setURL(payment.checkout_url)
    );
  }
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`pay:cancel:${payment.id}`)
      .setLabel("Cancel Checkout")
      .setStyle(ButtonStyle.Danger)
  );

  // The checkout (QR + address + live status) appears where the user clicked:
  // in a guild that's an ephemeral follow-up only they can see; in DMs it's
  // just another message in the conversation. Ephemeral follow-ups stay
  // editable through the interaction webhook (message id + token) for the
  // whole checkout window, so the poll can always refresh it.
  // Ephemeral follow-ups can return a message with a null .channel in v14, so
  // fall back to the payload's channelId instead of msg.channel.id.
  const msg = await interaction.followUp({
    embeds: [embed],
    components: [row],
    files: [bannerFile()],
    ephemeral: true,
  }).catch(() => null);
  if (!msg) {
    db.prepare("UPDATE payments SET status = 'cancelled' WHERE id = ?").run(payment.id);
    throw new Error("Couldn't post the checkout — try again.");
  }
  db.prepare("UPDATE payments SET message_channel_id = ?, message_id = ? WHERE id = ?").run(msg.channelId ?? msg.channel?.id ?? null, msg.id, payment.id);

  console.log(`CHECKOUT-OPEN #${payment.id} kind=${kind} user=${user.id} ${usdAmount}usd chan=${msg.channelId ?? msg.channel?.id ?? null} msg=${msg.id} [${PROVIDER}]`);
  schedulePoll(client, payment);
  return payment;
}

export function resumePendingPayments(client) {
  const rows = db.prepare("SELECT * FROM payments WHERE status IN ('pending','waiting','confirming')").all();
  let resumed = 0;
  for (const p of rows) {
    const age = Date.now() - p.created_at;
    if (age >= PAYMENT_TTL_MS) {
      db.prepare("UPDATE payments SET status = 'expired' WHERE id = ?").run(p.id);
      continue;
    }
    schedulePoll(client, p);
    resumed++;
  }
  console.log(`Resumed ${resumed} open payment checker(s)`);
}

export async function cancelPayment(client, paymentId, interaction) {
  clearPaymentTimer(paymentId);
  db.prepare("UPDATE payments SET status = 'cancelled' WHERE id = ?").run(paymentId);
  const p = db.prepare("SELECT * FROM payments WHERE id = ?").get(paymentId);
  if (!p) return;
  // The cancel button is on the checkout message itself, so interaction.update
  // rewrites that (ephemeral) message into a cancellation receipt.
  await interaction.update({ embeds: [buildCheckoutEmbed({ ...p, status: "cancelled" })], components: [] }).catch(() => {});
  console.log(`CHECKOUT-CANCEL #${paymentId}`);
}

function schedulePoll(client, payment) {
  clearPaymentTimer(payment.id);
  timers.set(payment.id, { timer: null, payment, lastStatus: 0 });
  const timer = setInterval(() => poll(client, payment.id).catch((err) => console.error(`PAY-POLL #${payment.id} error: ${err?.message || err}`)), POLL_INTERVAL_MS);
  timer.unref?.();
  timers.get(payment.id).timer = timer;
}

function clearPaymentTimer(paymentId) {
  const existing = timers.get(paymentId);
  if (existing) {
    clearInterval(existing.timer);
    timers.delete(paymentId);
  }
}

async function finalizePayment(client, payment) {
  clearPaymentTimer(payment.id);
  db.prepare("UPDATE payments SET status = 'finished', updated_at = ? WHERE id = ?").run(Date.now(), payment.id);
  const updated = { ...payment, status: "finished" };
  const successEmbed = buildSuccessEmbed(updated);

  // Fulfillment:
  if (payment.kind === "credits") {
    const balance = addCredits(payment.user_id, payment.credits, `pay:${payment.id}`);
    console.log(`PAY-FULFILL #${payment.id} +${payment.credits} credits -> balance ${balance}`);
  } else if (payment.kind === "buy") {
    const pair = [payment.product_key, payment.version_value].filter(Boolean).join(":");
    if (payment.version_value) addPurchase(payment.user_id, payment.product_key, pair, payment.credits);
    // Grant role on the guild side (works without an interaction context).
    if (payment.product_key) {
      const product = PRODUCTS[payment.product_key];
      const roleId = product?.roleId;
      if (roleId) {
        const guild = client.guilds.cache.get(process.env.GUILD_ID);
        const member = guild ? await guild.members.fetch(payment.user_id).catch(() => null) : null;
        if (member) {
          const role = guild.roles.cache.get(roleId);
          if (role) await member.roles.add(role).catch(() => {});
        }
      }
    }
    console.log(`PAY-FULFILL #${payment.id} buy ${payment.product_key} (${payment.version_value})`);
  }

  // 1) The checkout message gets replaced with the receipt (keeps the customer's
  //    permanent record clean and obvious). It's ephemeral, so edit via webhook.
  const webhook = checkoutWebhook(client, payment);
  if (webhook && payment.message_id) {
    await webhook.editMessage(payment.message_id, { embeds: [successEmbed], components: [] }).catch(() => {});
    // Close the paid checkout 5 minutes after completion so it doesn't clutter
    // the channel (the QR/address are no longer needed once payment cleared).
    setTimeout(() => webhook.deleteMessage(payment.message_id).catch(() => {}), 5 * 60 * 1000).unref?.();
  }

  // 2) Refresh the original product/pocket embed (ephemeral — webhook only)
  //    with the success info, per the requested "refreshes the old one".
  if (webhook && payment.origin_message_id) {
    await webhook.editMessage(payment.origin_message_id, { embeds: [successEmbed], components: [] }).catch(() => {});
  }
}

async function poll(client, paymentId) {
  const payment = db.prepare("SELECT * FROM payments WHERE id = ?").get(paymentId);
  if (!payment || !["pending", "waiting", "confirming"].includes(payment.status)) {
    clearPaymentTimer(paymentId);
    return;
  }

  // Absolute expiry check first.
  if (Date.now() - payment.created_at >= PAYMENT_TTL_MS) {
    clearPaymentTimer(paymentId);
    db.prepare("UPDATE payments SET status = 'expired', updated_at = ? WHERE id = ?").run(Date.now(), paymentId);
    await updateCheckoutEmbed(client, { ...payment, status: "expired" });
    console.log(`CHECKOUT-EXPIRED #${paymentId}`);
    return;
  }

  // Hit the provider only on STATUS_CHECK_MS boundaries; every other tick just
  // refreshes the embed so the 20:00 countdown keeps moving.
  const entry = timers.get(paymentId) || { lastStatus: 0 };
  if (Date.now() - entry.lastStatus >= STATUS_CHECK_MS) {
    entry.lastStatus = Date.now();
    let s;
    try {
      s = await fetchStatus(payment);
    } catch (err) {
      console.error(`PAY-STATUS #${paymentId} error: ${err?.message || err}`);
      await updateCheckoutEmbed(client, payment);
      return;
    }

    const newStatus = s.status || payment.status;
    if (newStatus !== payment.status) {
      db.prepare("UPDATE payments SET status = ?, updated_at = ? WHERE id = ?").run(newStatus, Date.now(), paymentId);
      payment.status = newStatus;
    }

    if (newStatus === "finished") {
      await finalizePayment(client, payment);
      return;
    }
    if (newStatus === "failed") {
      clearPaymentTimer(paymentId);
      await updateCheckoutEmbed(client, { ...payment, status: "failed" });
      return;
    }
  }

  await updateCheckoutEmbed(client, payment);
}

async function updateCheckoutEmbed(client, payment) {
  if (!payment.message_id) return;
  const webhook = checkoutWebhook(client, payment);
  if (!webhook) return;
  try {
    const embed = buildCheckoutEmbed(payment);
    await webhook.editMessage(payment.message_id, { embeds: [embed] });
  } catch (err) {
    // A transient Discord rate-limit (429) is not "message gone" — skip this
    // tick and keep polling. Only a genuinely missing message/token cancels.
    if (err?.status === 429 || err?.rateLimited) return;
    if (["pending", "waiting", "confirming"].includes(payment.status)) {
      clearPaymentTimer(payment.id);
      db.prepare("UPDATE payments SET status = 'cancelled' WHERE id = ?").run(payment.id);
    }
  }
}