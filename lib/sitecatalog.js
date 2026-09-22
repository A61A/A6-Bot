import db from "../db.js";
import { PRODUCTS as SEED_PRODUCTS } from "../config/products.js";
import { ADMIN_USER_IDS } from "../config/roles.js";

// ---- Site storefront catalog: DB-driven, seeded from config/products.js ----

function now() {
  return Date.now();
}

export function seedSite() {
  const count = db.prepare("SELECT COUNT(*) c FROM site_products").pluck().get();
  if (!count) {
    const insP = db.prepare(
      "INSERT INTO site_products (key, label, desc, image, coming_soon, once, hidden, goal_usd, sort, created_at, updated_at) VALUES (?,?,?,?,?,?,?,0,?,?,?)"
    );
    const insV = db.prepare(
      "INSERT INTO site_versions (product_key, value, label, price, stock, sold, sort) VALUES (?,?,?,?,?,0,?)"
    );
    let sort = 0;
    for (const [key, p] of Object.entries(SEED_PRODUCTS)) {
      insP.run(key, p.label, p.desc ?? "", null, p.comingSoon ? 1 : 0, p.once ? 1 : 0, p.hidden ? 1 : 0, sort, now(), now());
      (p.versions || []).forEach((v, i) => insV.run(key, v.value, v.label, v.price, -1, i));
      sort++;
    }
    console.log(`[sitecatalog] seeded ${Object.keys(SEED_PRODUCTS).length} products`);
  }

  const seedCfg = (k, v) => {
    if (!db.prepare("SELECT 1 FROM site_config WHERE k = ?").get(k)) {
      db.prepare("INSERT INTO site_config (k, v) VALUES (?, ?)").run(k, v);
    }
  };
  seedCfg("payment_provider", process.env.PLISIO_API_KEY ? "plisio" : process.env.NOWPAYMENTS_API_KEY ? "nowpayments" : "sim");
  seedCfg("payment_currency", (process.env.PAYMENT_CURRENCY || "BTC").toUpperCase());
  seedCfg("reward_wall", "[]");
  seedCfg("paypal_client_id", "BAAtjuDEFOfHmk-PeVRPpPLXHYK75jtOh9Y8mTIWQTEuWOLCgU7EbZdf53Q-NRQqv3DFsbq7vrjezFAoi8");
  seedCfg("paypal_secret", "EEbxOdiGjTm6ndSQrMOEg1MTt9JjTyIMSsRKtHuPwv1kmEJbpKVN0yUGA6EyVKSkviJ2CqB9AvW1rTfm");
  seedCfg("paypal_mode", "sandbox");
  seedCfg("category_labels", JSON.stringify(DEFAULT_CATEGORY_LABELS));
}

export const DEFAULT_CATEGORY_LABELS = Object.freeze({
  streaming: "Streaming",
  music: "Music & Audio",
  utility: "Full Access Accounts",
});

export function getCategoryLabels() {
  const out = { ...DEFAULT_CATEGORY_LABELS };
  try {
    const stored = JSON.parse(getConfig("category_labels", "{}") || "{}");
    if (stored && typeof stored === "object") {
      for (const k of Object.keys(DEFAULT_CATEGORY_LABELS)) {
        if (typeof stored[k] === "string" && stored[k].trim()) out[k] = stored[k].trim().slice(0, 40);
      }
    }
  } catch {}
  return out;
}
export function setCategoryLabels(labels) {
  const clean = {};
  for (const k of Object.keys(DEFAULT_CATEGORY_LABELS)) {
    const v = labels && labels[k];
    clean[k] = typeof v === "string" && v.trim() ? String(v).trim().slice(0, 40) : DEFAULT_CATEGORY_LABELS[k];
  }
  setConfig("category_labels", JSON.stringify(clean));
}

// ---- Config ----------------------------------------------------------------
export function getConfig(key, fallback = null) {
  const v = db.prepare("SELECT v FROM site_config WHERE k = ?").pluck().get(key);
  return v === undefined ? fallback : v;
}
export function setConfig(key, value) {
  db.prepare("INSERT INTO site_config (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(key, String(value));
}

export function paymentProvider() {
  const cfg = getConfig("payment_provider", "auto");
  if (cfg === "plisio" && !process.env.PLISIO_API_KEY) return "sim";
  if (cfg === "nowpayments" && !process.env.NOWPAYMENTS_API_KEY) return "sim";
  if (["plisio", "nowpayments", "paypal", "sim"].includes(cfg)) return cfg;
  return process.env.PLISIO_API_KEY ? "plisio" : process.env.NOWPAYMENTS_API_KEY ? "nowpayments" : "sim";
}
export function paymentCurrency() {
  return (getConfig("payment_currency") || "BTC").toUpperCase();
}

// ---- Manual payment methods (PayPal / Zelle / Chime) -----------------------
// Each is the human-readable details shown to buyers at checkout ("Send to
// paypalme/a6store - include your order # in the note"). Empty string hides
// the method from the checkout screen.
export function getPaymentDetails() {
  const read = (k) => {
    try {
      const v = getConfig(k, "");
      return typeof v === "string" ? v.trim() : "";
    } catch {
      return "";
    }
  };
  return { paypal: read("manual_paypal"), zelle: read("manual_zelle"), chime: read("manual_chime") };
}

// ---- PayPal checkout API (auto-capture, like SellAuth) ---------------------
export function paypalKeys() {
  const clientId = getConfig("paypal_client_id", "");
  const secret = getConfig("paypal_secret", "");
  const mode = getConfig("paypal_mode", "live") === "sandbox" ? "sandbox" : "live";
  const ready = Boolean(clientId && secret);
  return { clientId, secret, mode, ready };
}

// ---- Admin gate ------------------------------------------------------------
export function isWebAdmin(acct) {
  if (!acct) return false;
  if (acct.discord_id && ADMIN_USER_IDS.includes(String(acct.discord_id))) return true;
  const names = (process.env.WEB_ADMIN_USERNAMES || "").split(",").map((s) => s.trim()).filter(Boolean);
  return names.includes(acct.username);
}

// ---- Products --------------------------------------------------------------
function itemAvailMap() {
  const map = {};
  for (const r of db.prepare("SELECT product_key, version_value, COUNT(*) c FROM delivery_items WHERE status = 'in_stock' GROUP BY product_key, version_value").all()) {
    map[r.product_key + "::" + r.version_value] = r.c;
  }
  return map;
}

export function allSiteProducts() {
  const avail = itemAvailMap();
  return db
    .prepare("SELECT * FROM site_products ORDER BY sort ASC, id ASC")
    .all()
    .map((p) => ({
      ...p,
      versions: db.prepare("SELECT * FROM site_versions WHERE product_key = ? ORDER BY sort ASC, id ASC").all(p.key)
        .map((v) => ({ ...v, _avail: avail[p.key + "::" + v.value] || 0 })),
    }));
}

export function findSiteProduct(key) {
  const p = db.prepare("SELECT * FROM site_products WHERE key = ?").get(key);
  if (!p) return null;
  p.versions = db.prepare("SELECT * FROM site_versions WHERE product_key = ? ORDER BY sort ASC, id ASC").all(p.key);
  return p;
}

export function findSiteVersion(value) {
  const version = db.prepare("SELECT * FROM site_versions WHERE value = ?").get(value);
  if (!version) return { product: null, version: null };
  return { product: findSiteProduct(version.product_key), version };
}

export function totalRevenue() {
  return db.prepare("SELECT COALESCE(SUM(price), 0) s FROM web_purchases").pluck().get();
}

function rowToPublic(p, revenue) {
  const locked = p.goal_usd > 0 && revenue < p.goal_usd;
  return {
    key: p.key,
    label: p.label,
    desc: p.desc ?? "",
    image: p.image || null,
    comingSoon: !!p.coming_soon,
    once: !!p.once,
    hidden: !!p.hidden,
    onHold: !!p.on_hold,
    hot: !!p.hot,
    locked,
    goalUsd: p.goal_usd || 0,
    progress: revenue,
    versions: p.versions.filter((v) => v.visible !== 0).map((v) => ({
      value: v.value,
      label: v.label,
      price: v.price,
      origPrice: v.orig_price || 0,
      minQty: v.min_qty > 0 ? v.min_qty : 1,
      maxQty: v.max_qty || 0,
      stock: v.stock,
      sold: v.sold,
      details: v.details || "",
      inStock: v.stock === -1 || (v._avail || 0) > 0,
      hasItems: (v._avail || 0) > 0,
      left: v.stock === -1 ? null : (v._avail || 0),
    })),
  };
}

// Visible catalog for the storefront (hidden products excluded entirely; goal-locked ones included as locked).
export function siteProductsPublic() {
  const revenue = totalRevenue();
  return allSiteProducts()
    .filter((p) => !p.hidden)
    .map((p) => rowToPublic(p, revenue));
}

export function goalState() {
  const revenue = totalRevenue();
  let wall = [];
  try {
    wall = JSON.parse(getConfig("reward_wall", "[]") || "[]");
  } catch {}
  const normalized = Array.isArray(wall)
    ? wall.map((w) => ({ goal: Number(w.goal || 0), title: String(w.title || ""), reward: String(w.reward || "") }))
    : [];
  return {
    revenue,
    wall: normalized.map((w) => ({ ...w, unlocked: revenue >= w.goal })),
    lockedProducts: siteProductsPublic().filter((p) => p.locked),
  };
}

// Linked external sites.
export function siteLinks(includeHidden = false) {
  const rows = db.prepare("SELECT id, title, url, hidden, sort FROM site_links ORDER BY sort ASC, id ASC").all();
  return includeHidden ? rows : rows.filter((l) => !l.hidden);
}

// ---- Sale gating -----------------------------------------------------------
// Returns { ok:true, price, unitPrice, discount, qty, version, product, codeInfo }
// or { ok:false, reason, message }. price is the total payable (unit after any
// discount, times quantity). discount is the total discount across all units.
export function checkSale(value, code, qty = 1) {
  const { product, version } = findSiteVersion(String(value || ""));
  if (!product || !version) return { ok: false, reason: "bad", message: "Bad product." };
  if (product.coming_soon) return { ok: false, reason: "soon", message: "This product isn't available yet." };
  if (product.hidden) return { ok: false, reason: "hidden", message: "This product isn't available." };
  if (product.on_hold) return { ok: false, reason: "hold", message: "This product is on hold." };
  if (version.visible === 0) return { ok: false, reason: "hidden", message: "This option is hidden." };
  if (version.price <= 0) return { ok: false, reason: "unpriced", message: "This option is being set up - set a price in the admin panel." };
  const revenue = totalRevenue();
  if (product.goal_usd > 0 && revenue < product.goal_usd) {
    return { ok: false, reason: "locked", message: `This unlocks at $${product.goal_usd} in store sales.` };
  }
  const n = parseInt(qty, 10);
  const minQty = version.min_qty > 0 ? version.min_qty : 1;
  const maxQty = version.max_qty > 0 ? version.max_qty : Infinity;
  if (!Number.isFinite(n) || n < minQty || n > maxQty) {
    const range = maxQty === Infinity ? `at least ${minQty}` : minQty === maxQty ? `${minQty}` : `${minQty}-${maxQty}`;
    return { ok: false, reason: "qty", message: `Quantity must be ${range} for this plan.` };
  }
  // Stock is the live delivery-item pool: -1 = unlimited (no cap), otherwise the
  // number of in-stock items is the hard cap.
  const poolAvail = itemStock(version.product_key, version.value);
  const effective = version.stock === -1 ? Infinity : poolAvail;
  if (effective !== Infinity && n > effective) {
    return { ok: false, reason: "stock", message: `Only ${effective} left - reduce the quantity.` };
  }
  let unit = version.price;
  let discount = 0;
  let codeInfo = null;
  if (code) {
    const applied = applyCode(String(code), unit);
    if (!applied.ok) return { ok: false, reason: "code", message: applied.message };
    unit = applied.price;
    discount = version.price - unit;
    codeInfo = applied.codeRow;
  }
  const price = Math.round(unit * n * 100) / 100;
  return {
    ok: true,
    price,
    unitPrice: Math.round(unit * 100) / 100,
    discount: Math.round(discount * n * 100) / 100,
    qty: n,
    version,
    product,
    codeInfo,
  };
}

// ---- Discount codes --------------------------------------------------------
export function getCode(code) {
  return db.prepare("SELECT * FROM web_codes WHERE code = ?").get(String(code).trim().toUpperCase());
}

export function applyCode(code, price) {
  const row = getCode(code);
  if (!row) return { ok: false, message: "Code not found." };
  if (!row.active) return { ok: false, message: "Code is inactive." };
  if (row.uses_left !== -1 && row.uses_left <= 0) return { ok: false, message: "Code is used up." };
  let newPrice = price;
  if (row.kind === "percent") newPrice = Math.round(price * (1 - (row.amount / 100)) * 100) / 100;
  else if (row.kind === "fixed") newPrice = Math.max(0, price - row.amount);
  newPrice = Math.round(newPrice * 100) / 100;
  return { ok: true, price: newPrice, discount: Math.round((price - newPrice) * 100) / 100, codeRow: row };
}

export function useCode(code, who) {
  const row = getCode(code);
  if (!row || !row.active) return false;
  if (row.uses_left !== -1 && row.uses_left <= 0) return false;
  if (row.uses_left !== -1) {
    db.prepare("UPDATE web_codes SET uses_left = uses_left - 1 WHERE code = ?").run(row.code);
  }
  db.prepare("INSERT INTO web_code_uses (code, used_by, used_at) VALUES (?, ?, ?)").run(row.code, String(who), now());
  return true;
}

// ---- Stock & sales ---------------------------------------------------------
export function recordWebSale(productKey, versionValue, qty = 1) {
  const n = Math.max(1, parseInt(qty, 10) || 1);
  // Availability is derived from the delivery-item pool, so only track units sold.
  db.prepare("UPDATE site_versions SET sold = sold + ? WHERE value = ?").run(n, versionValue);
}

// ---- Delivery item pools (keys/accounts/credentials sold per unit) ----------
export function hasItemPool(productKey, versionValue) {
  return !!db.prepare("SELECT 1 FROM delivery_items WHERE product_key = ? AND version_value = ? LIMIT 1").get(productKey, versionValue);
}
export function itemStock(productKey, versionValue) {
  return db
    .prepare("SELECT COUNT(*) c FROM delivery_items WHERE product_key = ? AND version_value = ? AND status = 'in_stock'")
    .pluck()
    .get(productKey, versionValue);
}
export function deliveryItemsFor(productKey, versionValue) {
  return db
    .prepare("SELECT * FROM delivery_items WHERE product_key = ? AND version_value = ? ORDER BY id ASC")
    .all(productKey, versionValue)
    .map((r) => ({ id: r.id, content: r.content, status: r.status, orderRef: r.order_ref, wid: r.wid, soldAt: r.sold_at }));
}
export function addDeliveryItems(productKey, versionValue, contents) {
  const list = (Array.isArray(contents) ? contents : [])
    .map((c) => String(c ?? "").replace(/\r/g, "").trim())
    .filter(Boolean)
    .slice(0, 500);
  if (!productKey || !versionValue || !list.length) return 0;
  const before = itemStock(productKey, versionValue);
  const ins = db.prepare("INSERT INTO delivery_items (product_key, version_value, content, created_at) VALUES (?,?,?,?)");
  for (const c of list) ins.run(String(productKey), String(versionValue), c, now());
  try {
    onStockAdded(String(productKey), String(versionValue), { added: list.length, before, after: before + list.length });
  } catch (e) {
    console.error("stock notify:", e.message);
  }
  return list.length;
}
export function editDeliveryItem(id, content) {
  const c = String(content ?? "").trim();
  const res = db.prepare("UPDATE delivery_items SET content = ? WHERE id = ? AND status = 'in_stock'").run(c, Number(id));
  return res.changes > 0;
}
export function deleteDeliveryItem(id) {
  db.prepare("DELETE FROM delivery_items WHERE id = ?").run(Number(id));
}
export function allocateDeliveryItems(productKey, versionValue, qty, orderRef, wid) {
  const n = Math.max(1, parseInt(qty, 10) || 1);
  const rows = db
    .prepare("SELECT id, content FROM delivery_items WHERE product_key = ? AND version_value = ? AND status = 'in_stock' ORDER BY id ASC LIMIT ?")
    .all(productKey, versionValue, n);
  if (rows.length < n) return { ok: false, delivered: rows.map((r) => r.content), message: "Not enough stock right now." };
  const upd = db.prepare("UPDATE delivery_items SET status = 'sold', order_ref = ?, wid = ?, sold_at = ? WHERE id = ?");
  for (const r of rows) upd.run(orderRef || null, wid || null, now(), r.id);
  return { ok: true, delivered: rows.map((r) => r.content) };
}
export function deliveredContentsFor(wid, productKey, versionValue) {
  return db
    .prepare("SELECT content, sold_at FROM delivery_items WHERE wid = ? AND product_key = ? AND version_value = ? AND status = 'sold' ORDER BY id DESC")
    .all(String(wid), productKey, versionValue)
    .map((r) => ({ content: r.content, soldAt: r.sold_at }));
}

// Eight starter plans applied to every newly created product. The user prices
// them and toggles visibility in the admin panel.
export const DEFAULT_VARIANTS = [
  { value: "7d", label: "7 Days" },
  { value: "14d", label: "14 Days" },
  { value: "1m", label: "1 Month" },
  { value: "2m", label: "2 Months" },
  { value: "3m", label: "3 Months" },
  { value: "6m", label: "6 Months" },
  { value: "1y", label: "1 Year" },
  { value: "lifetime", label: "Lifetime" },
];

// Seeds the standard 8 variants for a product by inserting any that are
// missing (never overwrites an existing one). Returns how many were added.
export function seedDefaultVariants(key) {
  if (!findSiteProduct(key)) return 0;
  let added = 0;
  const insert = db.prepare(
    "INSERT OR IGNORE INTO site_versions (product_key, value, label, price, orig_price, cost, stock, min_qty, max_qty, sold, sort, visible) VALUES (?,?,?,0,0,0,-1,1,0,0,(SELECT COALESCE(MAX(sort),0)+1 FROM site_versions WHERE product_key = ?),1)"
  );
  for (const v of DEFAULT_VARIANTS) {
    const res = insert.run(key, `${key}:${v.value}`, v.label, key);
    if (res.changes) added++;
  }
  return added;
}

export function upsertProduct({ key, label, desc, image, comingSoon, once, hidden, onHold, goalUsd, sort }) {
  const existing = db.prepare("SELECT id FROM site_products WHERE key = ?").get(key);
  if (existing) {
    db.prepare(
      "UPDATE site_products SET label = ?, desc = ?, image = ?, coming_soon = ?, once = ?, hidden = ?, on_hold = ?, goal_usd = ?, sort = ?, updated_at = ? WHERE key = ?"
    ).run(
      String(label || key),
      desc ?? "",
      image ?? null,
      comingSoon ? 1 : 0,
      once ? 1 : 0,
      hidden ? 1 : 0,
      onHold ? 1 : 0,
      Number(goalUsd || 0),
      Number(sort || 0),
      now(),
      key,
    );
    return { created: false };
  }
  const maxSort = db.prepare("SELECT COALESCE(MAX(sort), 0) m FROM site_products").pluck().get();
  db.prepare(
    "INSERT INTO site_products (key, label, desc, image, coming_soon, once, hidden, on_hold, goal_usd, sort, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
  ).run(
    key,
    String(label || key),
    desc ?? "",
    image ?? null,
    comingSoon ? 1 : 0,
    once ? 1 : 0,
    hidden ? 1 : 0,
    onHold ? 1 : 0,
    Number(goalUsd || 0),
    Number(sort || maxSort + 1),
    now(),
    now(),
  );
  return { created: true };
}

export function deleteProduct(key) {
  db.prepare("DELETE FROM site_versions WHERE product_key = ?").run(key);
  db.prepare("DELETE FROM site_products WHERE key = ?").run(key);
}

export function upsertVersion({ productKey, value, label, price, origPrice, cost, stock, minQty, maxQty, visible, details }) {
  const existing = db.prepare("SELECT * FROM site_versions WHERE product_key = ? AND value = ?").get(productKey, value);
  if (existing) {
    const isSet = (v) => v !== undefined && v !== null && v !== "";
    db.prepare(
      "UPDATE site_versions SET label = ?, price = ?, orig_price = ?, cost = ?, stock = ?, min_qty = ?, max_qty = ?, visible = ?, details = ? WHERE id = ?"
    ).run(
      isSet(label) ? String(label) : existing.label,
      isSet(price) ? Number(price) : existing.price,
      isSet(origPrice) ? Number(origPrice) : existing.orig_price,
      isSet(cost) ? Number(cost) : existing.cost,
      isSet(stock) ? Number(stock) : existing.stock,
      isSet(minQty) ? Math.max(1, Number(minQty)) : existing.min_qty,
      isSet(maxQty) ? Math.max(0, Number(maxQty)) : existing.max_qty,
      visible === undefined || visible === null ? existing.visible : Number(visible) === 1 ? 1 : 0,
      details === undefined || details === null ? existing.details : String(details),
      existing.id,
    );
    return;
  }
  const maxSort = db.prepare("SELECT COALESCE(MAX(sort), 0) m FROM site_versions WHERE product_key = ?").pluck().get(productKey);
  db.prepare(
    "INSERT INTO site_versions (product_key, value, label, price, orig_price, cost, stock, min_qty, max_qty, sold, sort, visible, details) VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?)"
  ).run(
    productKey,
    value,
    String(label || value),
    Number(price || 0),
    Number(origPrice || 0),
    Number(cost || 0),
    Number(stock ?? -1),
    Math.max(1, Number(minQty || 1)),
    Math.max(0, Number(maxQty || 0)),
    maxSort + 1,
    visible === undefined || visible === null ? 1 : Number(visible) === 1 ? 1 : 0,
    details === undefined || details === null ? "" : String(details),
  );
}

export function deleteVersion(value) {
  db.prepare("DELETE FROM site_versions WHERE value = ?").run(value);
}

const DISCORD_API = "https://discord.com/api";
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_STOCK_CHANNEL_ID = process.env.DISCORD_STOCK_CHANNEL_ID || "1550862393230368808";
// SellHub-style: one standalone Discord webhook URL. Webhook URLs are
// self-authenticating (https://discord.com/api/webhooks/<id>/<token>) so we can
// POST stock embeds straight to it with zero bot-token/OAuth/WAL —” SellHub
// does exactly this: a single webhook URL in settings, embeds POSTed on every
// stock change. Self-contained: no channel slot, no message-id tracking.
// SellHub-style: one standalone Discord webhook URL. Webhook URLs are
// self-authenticating (https://discord.com/api/webhooks/<id>/<token>) so we can
// POST stock embeds straight to it with zero bot-token/OAuth/WAL —” SellHub
// does exactly this: a single webhook URL in settings, embeds POSTed on every
// stock change. Self-contained: no channel slot, no message-id tracking.
// SellHub-style: one standalone Discord webhook URL. Webhook URLs are
// self-authenticating (https://discord.com/api/webhooks/<id>/<token>) so we can
// POST stock embeds straight to it with zero bot-token/OAuth/WAL —” SellHub
// does exactly this: a single webhook URL in settings, embeds POSTed on every
// stock change. Self-contained: no channel slot, no message-id tracking.
const SITE_BASE = process.env.SITE_BASE_URL || "https://a6hub.cc";

const EMBED_EMOJI = "info~1";
const ROW_EMOJI = "double_checked";
// Hardcoded custom emojis (bot token invalid, can't fetch dynamically).
// Using static format <:name:id> - name must be valid Discord emoji name (alphanumeric + underscore).
const EMOJI_UNICODE_FALLBACK = {
  "info~1": "<:info:1550705722004869230>",
  "double_checked": "<:double_checked:1550705712135671890>",
  "money": "💰",
};
const BOARD_DEBOUNCE_MS = Math.max(500, Number(process.env.STOCK_BOARD_DEBOUNCE_MS) || 2000);

let emojiMap = null; // name -> "<:name:id>" (built once)
let boardTimer = null;

const escD = (s) => String(s ?? "").replace(/([*_~|`>])/g, "\\$1");
const fmtPrice = (n) => {
  n = Number(n);
  if (!Number.isFinite(n)) n = 0;
  return "$" + n.toFixed(Number.isInteger(n) ? 0 : 2);
};

const cfgGet = db.prepare("SELECT v FROM site_config WHERE k = ?");
const cfgSet = db.prepare("INSERT INTO site_config (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v");

function loadMsg(slot) {
  const row = cfgGet.get(slot);
  if (!row || !row.v) return null;
  try {
    const v = JSON.parse(row.v);
    if (v && v.channelId && v.messageId) return v;
  } catch {}
  return null;
}
function saveMsg(slot, channelId, messageId) {
  cfgSet.run(slot, JSON.stringify({ channelId, messageId }));
}

async function ensureEmojiMap() {
  if (emojiMap) return;
  emojiMap = new Map();
  if (!DISCORD_BOT_TOKEN) {
    console.log("[ensureEmojiMap] No DISCORD_BOT_TOKEN, skipping emoji fetch");
    return;
  }
  try {
    console.log("[ensureEmojiMap] Fetching guilds...");
    const guilds = await (await fetch(`${DISCORD_API}/users/@me/guilds`, {
      headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
    })).json();
    console.log(`[ensureEmojiMap] Found ${guilds?.length || 0} guilds`);
    for (const g of Array.isArray(guilds) ? guilds : []) {
      console.log(`[ensureEmojiMap] Fetching emojis for guild: ${g.name} (${g.id})`);
      const emojis = await (await fetch(`${DISCORD_API}/guilds/${g.id}/emojis`, {
        headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
      })).json();
      console.log(`[ensureEmojiMap] Guild ${g.name} has ${emojis?.length || 0} emojis`);
      for (const em of Array.isArray(emojis) ? emojis : []) {
        console.log(`[ensureEmojiMap]   Found emoji: ${em.name} (${em.id})`);
        if (!emojiMap.has(em.name)) {
          emojiMap.set(em.name, (em.animated ? "<a:" : "<:") + em.name + ":" + em.id + ">");
        }
      }
      await new Promise((r) => setTimeout(r, 350));
    }
  } catch (e) {
    console.error("Emoji fetch failed:", e.message);
  }
}

async function resolveEmoji(name) {
  await ensureEmojiMap();
  const custom = emojiMap ? emojiMap.get(name) : undefined;
  // SellHub renders plain Unicode emoji in its stock embeds —” custom guild
  // emoji only resolves via the bot-token emoji API (unavailable on the
  // webhook-only path), so fall back to the matching Unicode glyph.
  return custom ?? EMOJI_UNICODE_FALLBACK[name] ?? null;
}

export async function manualStockEmbed(productKey) {
  const p = db.prepare("SELECT * FROM site_products WHERE key = ?").get(productKey);
  if (!p) return { ok: false, message: "Product not found." };
  const vs = db.prepare("SELECT * FROM site_versions WHERE product_key = ? AND visible = 1 ORDER BY sort ASC, id ASC").all(productKey);
  if (!vs.length) return { ok: false, message: "Product has no visible plans." };
  const availMap = {};
  for (const r of db.prepare("SELECT version_value, COUNT(*) c FROM delivery_items WHERE status = 'in_stock' AND product_key = ? GROUP BY version_value").all(productKey)) {
    availMap[r.version_value] = r.c;
  }
  const rowEmojiKey = ROW_EMOJI;
  const r = await resolveEmoji(rowEmojiKey);
  const rowEmoji = (r || `:${rowEmojiKey}:`) + " ";
  const lines = vs.map((v) => {
    const left = v.stock === -1 ? "Unlimited" : availMap[v.value] || 0;
    return rowEmoji + "**" + escD(p.label) + "** · " + escD(v.label) +
      "\nStock: " + left + " | Price: " + fmtPrice(v.price);
  });
  await sendStockMessage({ title: p.label, desc: lines.join("\n\n"), color: 0x23a55a, ping: "none", slot: "stock_msg_manual" });
  return { ok: true, variants: lines.length };
}

// Posts a stock update. Uses webhook for text-mode (guild custom emojis work in text),
// falls back to REST embeds only if webhook URL missing.
async function sendStockMessage({ title, desc, embeds, color, ping, slot = "stock_msg" }) {
  if (!DISCORD_BOT_TOKEN && !STOCK_WEBHOOK_URL) return;
  try {
    const webhookUrl = STOCK_WEBHOOK_URL;
    if (webhookUrl) {
      await ensureEmojiMap();
      let content = ping === "everyone" ? "@everyone" : ping === "here" ? "@here" : "";
      const titleEmoji = emojiMap?.get(EMBED_EMOJI) || EMOJI_UNICODE_FALLBACK[EMBED_EMOJI] || "";
      const rowEmoji = emojiMap?.get(ROW_EMOJI) || EMOJI_UNICODE_FALLBACK[ROW_EMOJI] || "";
      const header = (titleEmoji ? titleEmoji + " " : "") + "Stock Update" + (title ? " —” " + title : "");
      const lines = (Array.isArray(embeds) && embeds.length) ? embeds : (desc ? [desc] : []);
      const body = lines.map(d => d.replace(/\*\*(.*?)\*\*/g, "$1")).join("\n");
      let text = content + (content ? " " : "") + (titleEmoji ? titleEmoji + " " : "") + header + "\n" + body;
      if (text.length > 2000) text = text.slice(0, 1997) + "—¦";
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text }),
      });
      if (!res.ok) {
        console.error("Discord stock webhook failed:", res.status, await res.text().catch(() => ""));
      }
      return;
    }
  } catch (e) {
    console.error("Discord stock embed failed:", e.message);
  }
}

// The board = every variant currently in stock on the site (same names, prices
// and counts the storefront shows). Rebuilt from the DB each flush, so nothing
// is ever "replaced" —” items just appear/update while they have stock.
function buildBoardRows() {
  const avail = itemAvailMap();
  const rows = [];
  for (const p of db.prepare("SELECT * FROM site_products ORDER BY sort ASC, id ASC").all()) {
    if (p.hidden) continue;
    for (const v of db.prepare("SELECT * FROM site_versions WHERE product_key = ? ORDER BY sort ASC, id ASC").all(p.key)) {
      if (v.visible !== 1) continue;
      const stock = v.stock === -1 ? "Unlimited" : avail[p.key + "::" + v.value] || 0;
      rows.push({
        p: p.label,
        v: v.label,
        price: v.price,
        stock: stock,
        key: p.key + "::" + v.value,
      });
    }
  }
  return rows;
}

// Get current stock state for change detection
function getCurrentStockState() {
  const rows = buildBoardRows();
  const state = {};
  for (const r of rows) {
    state[r.key] = {
      p: r.p,
      v: r.v,
      stock: r.stock,
      price: r.price,
    };
  }
  return state;
}

// Load/save previous stock state
function loadStockState() {
  const row = cfgGet.get("stock_board_state");
  if (!row || !row.v) return null;
  try {
    return JSON.parse(row.v);
  } catch {
    return null;
  }
}

function saveStockState(state) {
  cfgSet.run("stock_board_state", JSON.stringify(state));
}

// SellHub-style: a standalone Discord webhook URL. Webhook URLs are
// self-authenticating (https://discord.com/api/webhooks/<id>/<token>) so we
// POST stock embeds straight to it with zero bot-token/OAuth/WAL —” just a
// plain authenticated fetch (exactly like SellHub's webhook delivery).
const STOCK_WEBHOOK_URL =
  process.env.STOCK_WEBHOOK_URL ||
  process.env.DISCORD_STOCK_WEBHOOK_URL ||
  "https://discord.com/api/webhooks/1551377177075781634/f16jDNxn1Lvjdbs_IOUv6RzkFQeKUzS-G_hYffA88hUAX9nQ46nGrc_BP7c8cO-nyFRE";

// Purchase notifications webhook (separate channel for sales)
const PURCHASE_WEBHOOK_URL =
  process.env.PURCHASE_WEBHOOK_URL ||
  process.env.DISCORD_PURCHASE_WEBHOOK_URL ||
  "";

async function flushBoard() {
  boardTimer = null;
  const rows = buildBoardRows();
  if (!rows.length) return;
  await ensureEmojiMap();
  console.log(`[flushBoard] emojiMap size: ${emojiMap?.size || 0}, keys: ${Array.from(emojiMap?.keys() || []).join(", ")}`);
  console.log(`[flushBoard] rowEmoji raw: "${emojiMap?.get(ROW_EMOJI)}", titleEmoji raw: "${emojiMap?.get(EMBED_EMOJI)}", infoEmoji raw: "${emojiMap?.get("info")}"`);
  
  // Get current stock state and compare with previous
  const currentState = getCurrentStockState();
  
  // Check if any item has stock (unlimited or > 0)
  const hasAnyStock = rows.some(it => it.stock === "Unlimited" || (typeof it.stock === "number" && it.stock > 0));
  
  const webhookUrl = STOCK_WEBHOOK_URL;
  if (!webhookUrl) return;
  
  // Handle "all sold out" case
  if (!hasAnyStock) {
    const titleEmoji = emojiMap?.get(EMBED_EMOJI) || EMOJI_UNICODE_FALLBACK[EMBED_EMOJI] || "";
    const embed = {
      title: (titleEmoji ? titleEmoji + " " : "") + "Stock Update" + (titleEmoji ? " " + titleEmoji : ""),
      description: "**YOU GUYS BOUGHT EVERYTHING... more soon !**",
      color: 0xff4444,
      footer: { text: "A6 Store" },
      timestamp: new Date().toISOString(),
    };
    
    const content = "@everyone";
    const payload = JSON.stringify({ content, embeds: [embed] });
    
    const slot = "stock_msg";
    const stored = loadMsg(slot);
    let res;
    
    if (stored && stored.messageId) {
      console.log(`[flushBoard] Trying to edit stored message ID: ${stored.messageId}`);
      res = await fetch(`${webhookUrl}/messages/${stored.messageId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "@everyone", embeds: [embed] }),
      });
      console.log(`[flushBoard] PATCH stored message status: ${res.status}`);
    }
    
    if (!stored || !stored.messageId || res.status === 404) {
      console.log("[flushBoard] No stored message or 404, POSTing new");
      res = await fetch(webhookUrl + "?wait=true", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, embeds: [embed] }),
      });
      console.log(`[flushBoard] POST new status: ${res.status}`);
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data.id) {
          saveMsg(slot, "0", data.id);
        }
      }
    }
    
    if (!res.ok) {
      console.error("Discord stock webhook failed:", res.status, await res.text().catch(() => ""));
    }
    
    // Save current state even when all sold out
    const currentState = getCurrentStockState();
    saveStockState(currentState);
    return;
  }
  
  // Normal case: show items with stock > 0 (and unlimited)
  const displayRows = rows.filter(it => it.stock === "Unlimited" || (typeof it.stock === "number" && it.stock > 0));
  if (!displayRows.length) return;
  
  const rowEmoji = (emojiMap?.get(ROW_EMOJI) || EMOJI_UNICODE_FALLBACK[ROW_EMOJI] || "•") + " ";
  const titleEmoji = emojiMap?.get(EMBED_EMOJI) || EMOJI_UNICODE_FALLBACK[EMBED_EMOJI] || "";
  const infoEmoji = emojiMap?.get("info") || EMOJI_UNICODE_FALLBACK["info"] || "ℹ️";
  console.log(`[flushBoard] rowEmoji: "${rowEmoji}", titleEmoji: "${titleEmoji}", infoEmoji: "${infoEmoji}"`);
  console.log(`[flushBoard] rowEmoji raw: "${emojiMap?.get(ROW_EMOJI)}", titleEmoji raw: "${emojiMap?.get(EMBED_EMOJI)}", infoEmoji raw: "${emojiMap?.get("info")}"`);
  
  const EMBED_LIMIT = 25;
  const displayChunks = [];
  for (let i = 0; i < displayRows.length; i += EMBED_LIMIT) {
    displayChunks.push(displayRows.slice(i, i + EMBED_LIMIT));
  }
  
  for (let i = 0; i < displayChunks.length; i++) {
    const chunk = displayChunks[i];
    const embedLines = chunk.map(
      (it) => rowEmoji + "**" + escD(it.p) + "** · " + escD(it.v) +
        "\nStock: **" + it.stock + "** | Price: **" + fmtPrice(it.price) + "**"
    );
    
    const embed = {
      title: (titleEmoji ? titleEmoji + " " : "") + "Stock Update" + (titleEmoji ? " " + titleEmoji : ""),
      description: embedLines.join("\n\n"),
      color: 0x23a55a,
      footer: { text: "A6 Store" },
      timestamp: new Date().toISOString(),
    };
    
    const content = i === 0 ? "@everyone" : "";
    const payload = JSON.stringify({ content, embeds: [embed] });
    
    // Try to edit existing message using stored message ID
    const slot = i === 0 ? "stock_msg" : `stock_msg_${i}`;
    const stored = loadMsg(slot);
    let res;
    
    if (stored && stored.messageId) {
      console.log(`[flushBoard] Trying to edit stored message ID: ${stored.messageId}`);
      res = await fetch(`${webhookUrl}/messages/${stored.messageId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: payload,
      });
      console.log(`[flushBoard] PATCH stored message status: ${res.status}`);
    }
    
    // If no stored message or edit failed, POST new and save the message ID
    if (!stored || !stored.messageId || res.status === 404) {
      console.log("[flushBoard] No stored message or 404, POSTing new");
      res = await fetch(webhookUrl + "?wait=true", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      });
      console.log(`[flushBoard] POST new status: ${res.status}`);
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        console.log(`[flushBoard] POST response data:`, JSON.stringify(data));
        if (data.id) {
          console.log(`[flushBoard] Saving message ID: ${data.id} for slot: ${slot}`);
          saveMsg(slot, "0", data.id);
        }
      }
    }
    
    if (!res.ok) {
      console.error("Discord stock webhook failed:", res.status, await res.text().catch(() => ""));
    }
  }
  
  // Save current state for next comparison
  saveStockState(currentState);
}

 
// Send a purchase notification embed to the purchases webhook channel
export async function sendPurchaseEmbed({
  username,
  email,
  items,
  total,
  currency = "USD",
  paymentMethod = "Balance",
}) {
  if (!PURCHASE_WEBHOOK_URL) {
    console.log("[sendPurchaseEmbed] PURCHASE_WEBHOOK_URL not configured, skipping");
    return;
  }
 
  await ensureEmojiMap();
  const rowEmoji = (emojiMap?.get(ROW_EMOJI) || EMOJI_UNICODE_FALLBACK[ROW_EMOJI] || "•") + " ";
  const titleEmoji = emojiMap?.get(EMBED_EMOJI) || EMOJI_UNICODE_FALLBACK[EMBED_EMOJI] || "";
  const infoEmoji = emojiMap?.get("info") || EMOJI_UNICODE_FALLBACK["info"] || "ℹ️";
  const moneyEmoji = emojiMap?.get("money") || EMOJI_UNICODE_FALLBACK["money"] || "💰";
 
  const lines = items.map(
    (it) => rowEmoji + "**" + escD(it.productLabel) + "** · " + escD(it.versionLabel) +
      "\nQty: **" + it.qty + "** | Price: **" + fmtPrice(it.price) + "**"
  );
 
  const embed = {
    title: (infoEmoji ? infoEmoji + " " : "") + "New Purchase" + (infoEmoji ? " " + infoEmoji : ""),
    description: lines.join("\n\n"),
    color: 0x00a854,
    fields: [
      { name: moneyEmoji + " Total", value: "**" + fmtPrice(total) + " " + currency + "**", inline: true },
      { name: "💳 Payment", value: paymentMethod, inline: true },
      { name: "👤 Customer", value: username + (email ? " (" + email + ")" : ""), inline: false },
    ],
    footer: { text: "A6 Store" },
    timestamp: new Date().toISOString(),
  };
 
  const payload = JSON.stringify({
    content: "",
    embeds: [embed],
  });
 
  const res = await fetch(PURCHASE_WEBHOOK_URL + "?wait=true", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
  });
 
  if (!res.ok) {
    console.error("Discord purchase webhook failed:", res.status, await res.text().catch(() => ""));
  } else {
    console.log("[sendPurchaseEmbed] Purchase notification sent successfully");
  }
}
 
function scheduleBoard() {
  if (boardTimer) clearTimeout(boardTimer);
  boardTimer = setTimeout(() => void flushBoard(), BOARD_DEBOUNCE_MS);
}

// Periodic stock board refresh (every 10 minutes) to catch purchases
const PERIODIC_REFRESH_MS = 10 * 60 * 1000; // 10 minutes
let periodicTimer = null;

function startPeriodicRefresh() {
  if (periodicTimer) clearInterval(periodicTimer);
  periodicTimer = setInterval(() => {
    console.log("[flushBoard] Periodic 10-minute refresh triggered");
    void flushBoard();
  }, PERIODIC_REFRESH_MS);
  // Run immediately on start
  void flushBoard();
}

function stopPeriodicRefresh() {
  if (periodicTimer) clearInterval(periodicTimer);
  periodicTimer = null;
}

// Called after stock rows are inserted. Refreshes the live stock board in
// realtime (short debounce so rapid additions coalesce into one edit).
export function onStockAdded(productKey, versionValue, { added, before, after }) {
  if (!added || added <= 0) return;
  scheduleBoard();
}

// Start periodic refresh when module loads
startPeriodicRefresh();
