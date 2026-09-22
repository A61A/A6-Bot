import db from "../db.js";
import { PRODUCTS } from "../config/products.js";
import QRCode from "qrcode";
import { paymentProvider as siteProvider, paymentCurrency as siteCurrency } from "./sitecatalog.js";
import { createPayPalOrder, getPayPalApprovalUrl } from "./paypal.js";

const PAYMENT_TTL_MS = 20 * 60 * 1000;

export const SUPPORTED_COINS = [
  { value: "BTC", label: "Bitcoin" },
  { value: "LTC", label: "Litecoin" },
  { value: "ETH", label: "Ethereum" },
  { value: "SOL", label: "Solana" },
  { value: "USDC_BASE", label: "USDC (Base)" },
  { value: "USDT_TON", label: "USDT (TON)" },
];

// QR codes render locally (instant) instead of an external QR image service.
let qrCache = new Map();
export async function qrDataUrlFor(payAddress, payAmount, payCurrency) {
  if (!payAddress) return null;
  const key = `${payAddress}|${payAmount}|${payCurrency}`;
  if (qrCache.has(key)) return qrCache.get(key);
  const text = `${payCurrency.toLowerCase()}:${payAddress}?amount=${payAmount}`;
  const url = await QRCode.toDataURL(text, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 280,
    color: { dark: "#0B048F", light: "#FFFFFF" },
  });
  if (qrCache.size > 200) qrCache.clear();
  qrCache.set(key, url);
  return url;
}

function fmtCrypto(amount) {
  return Number(amount ?? 0).toFixed(8).replace(/0+$/, "").replace(/\.$/, "") || "0";
}

// ---- Plisio provider -------------------------------------------------------
async function plisioFetchInvoice(txnId) {
  const res = await fetch(`https://api.plisio.net/api/v1/invoices/${txnId}?api_key=${process.env.PLISIO_API_KEY}`, {
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json();
  if (!res.ok || data.status !== "success" || !data.data) throw new Error(`Plisio status failed (${res.status})`);
  return data.data.invoice || data.data;
}

async function plisioCreateInvoice({ usdAmount, currency, orderId, description }) {
  const url = new URL("https://api.plisio.net/api/v1/invoices/new");
  for (const [k, v] of Object.entries({
    api_key: process.env.PLISIO_API_KEY,
    source_currency: "USD",
    source_amount: String(usdAmount),
    currency: currency.toUpperCase(),
    order_number: orderId,
    order_name: description || "A6 order",
    expire_min: String(Math.ceil(PAYMENT_TTL_MS / 60_000)),
  })) url.searchParams.set(k, v);

  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  const data = await res.json();
  if (!res.ok || data.status !== "success" || !data.data?.txn_id) {
    throw new Error(`Plisio create failed (${data.data?.message || data.message})`);
  }
  // Return fast — the wallet address arrives on the next status poll, so the
  // checkout page isn't blocked waiting for it here.
  return {
    providerId: String(data.data.txn_id),
    checkoutUrl: data.data.invoice_url || null,
    payAmount: Number(data.data.invoice_total_sum ?? 0),
    payCurrency: currency.toUpperCase(),
    payAddress: null,
  };
}

function mapPlisioStatus(s) {
  if (s === "completed") return "finished";
  if (["pending", "pending internal"].includes(s)) return "confirming";
  if (["failed", "error", "expired"].includes(s)) return "failed";
  if (s === "new" || s === "waiting") return "waiting";
  return "confirming";
}

// ---- NowPayments -----------------------------------------------------------
async function npCreatePayment({ amountUsd, currency, orderId, description }) {
  const res = await fetch("https://api.nowpayments.io/v1/payment", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": process.env.NOWPAYMENTS_API_KEY },
    body: JSON.stringify({ price_amount: amountUsd, price_currency: "usd", pay_currency: currency, order_id: orderId, order_description: description }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json();
  if (!res.ok || !data.payment_id) throw new Error(`NowPayments create failed (${res.status})`);
  return { providerId: String(data.payment_id), checkoutUrl: null, payAddress: data.pay_address, payAmount: Number(data.pay_amount), payCurrency: data.pay_currency };
}

async function npGetStatus(providerId) {
  const res = await fetch(`https://api.nowpayments.io/v1/payment/${providerId}/status`, {
    headers: { "x-api-key": process.env.NOWPAYMENTS_API_KEY },
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json();
  if (!res.ok) return { status: "confirming" };
  if (data.payment_status === "finished") return { status: "finished" };
  if (data.payment_status === "failed") return { status: "failed" };
  return { status: "confirming" };
}

// ---- Simulator (no keys configured) ----------------------------------------
const simTimers = new Map(); // paymentId -> created timestamp

// ---- Public ----------------------------------------------------------------
export function getProvider() { return siteProvider(); }
export function getPaymentCurrency() { return siteCurrency(); }

function findVersion(pair) {
  const [productKey] = pair.split(":");
  const product = PRODUCTS[productKey];
  const version = product?.versions?.find((v) => v.value === pair);
  return { product, version };
}

export async function createWebPayment({ userId, kind, productKey, versionValue, amountUsd, currency, productLabel, versionLabel, qty = 1, items = null }) {
  const provider = getProvider();
  const payCurrency = (currency || getPaymentCurrency()).toUpperCase();
  const orderId = `web-${userId}-${Date.now()}`;
  const now = Date.now();

  let created = { providerId: `sim-${orderId}`, checkoutUrl: null, payAmount: amountUsd, payCurrency, payAddress: null };

  // For deposits, allow PayPal when user selects it (currency = USD)
  const usePayPal = kind === "deposit" && payCurrency === "USD";
  const effectiveProvider = usePayPal ? "paypal" : provider;

  if (effectiveProvider === "plisio") {
    created = await plisioCreateInvoice({ usdAmount: amountUsd, currency: payCurrency, orderId, description: kind === "deposit" ? "Balance top-up" : "Product payment" });
  } else if (effectiveProvider === "nowpayments") {
    created = await npCreatePayment({ amountUsd, currency: payCurrency.toLowerCase(), orderId, description: kind === "deposit" ? "Balance top-up" : "Product payment" });
  } else if (effectiveProvider === "paypal" && kind === "deposit") {
    const baseUrl = process.env.SITE_BASE_URL || "https://a6hub.cc";
    const returnUrl = `${baseUrl}/deposit-success?paymentId=`;
    const cancelUrl = `${baseUrl}/deposit-cancelled`;
    const order = await createPayPalOrder({ usdAmount: amountUsd, reference: orderId, returnUrl, cancelUrl });
    created = {
      providerId: `paypal-${order.id}`,
      checkoutUrl: getPayPalApprovalUrl(order),
      payAmount: amountUsd,
      payCurrency: "USD",
      payAddress: null,
    };
  } else {
    simTimers.set(`sim-${orderId}`, now);
  }

  const { product, version } = productKey ? findVersion(`${productKey}:${versionValue}`) : { product: null, version: null };
  const lines = items || [];
  const info = db.prepare(
    `INSERT INTO payments (user_id, kind, product_key, version_value, product_label, version_label, credits, usd_amount, qty, pay_currency, pay_amount, pay_address, provider_id, status, note, items, created_at, updated_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    String(userId),
    kind,
    productKey || lines[0]?.product || null,
    versionValue || lines[0]?.version || null,
    productLabel || product?.label || null,
    versionLabel || version?.label || null,
    0,
    amountUsd,
    Math.max(1, parseInt(qty, 10) || 1),
    created.payCurrency,
    created.payAmount,
    created.payAddress,
    created.providerId,
    "waiting",
    null,
    lines.length ? JSON.stringify(lines) : null,
    now,
    now,
    now + PAYMENT_TTL_MS,
  );

  return {
    paymentId: info.lastInsertRowid,
    expiresAt: now + PAYMENT_TTL_MS,
    checkoutUrl: created.checkoutUrl,
    payAddress: created.payAddress,
    payAmount: created.payAmount,
    payCurrency: created.payCurrency,
    qr: created.payAddress ? await qrDataUrlFor(created.payAddress, created.payAmount, created.payCurrency) : null,
  };
}

export async function checkPaymentStatus(payment) {
  if (payment.status !== "waiting" && payment.status !== "confirming") return { status: payment.status };
  const pid = String(payment.provider_id);
  const provider = getProvider();

  if (provider === "plisio") {
    const inv = await plisioFetchInvoice(pid);
    return {
      status: mapPlisioStatus(inv.status),
      payAddress: inv.wallet_hash || null,
      payAmount: inv.amount ? Number(inv.amount) : null,
    };
  }
  if (provider === "nowpayments") {
    return await npGetStatus(pid);
  }
  if (provider === "paypal" && pid.startsWith("paypal-")) {
    const orderId = pid.replace("paypal-", "");
    try {
      const { capturePayPalOrder } = await import("./paypal.js");
      const data = await capturePayPalOrder(orderId);
      if (data.status === "COMPLETED") return { status: "finished" };
      if (["FAILED", "EXPIRED"].includes(data.status)) return { status: "failed" };
      return { status: "confirming" };
    } catch {
      return { status: "confirming" };
    }
  }
  // sim: auto-finish after 2s
  const created = simTimers.get(pid);
  if (!created) return { status: "confirming" };
  if (Date.now() - created > 2000) { simTimers.delete(pid); return { status: "finished" }; }
  return { status: "waiting" };
}

export function markPaymentStatus(paymentId, status) {
  db.prepare("UPDATE payments SET status = ?, updated_at = ? WHERE id = ?").run(status, Date.now(), paymentId);
}