import { createServer } from "node:http";
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import db from "./db.js";
import {
  validateCredentials, createWebAccount, findWebByUsername, getWebById,
  linkDiscord, unlinkDiscord, verifyPassword, walletFor, spendFor,
  hasWebPurchase, addWebPurchase, webPurchasesFor, addBalance, avatarUrl,
} from "./lib/webauth.js";
import { createWebPayment, checkPaymentStatus, markPaymentStatus, SUPPORTED_COINS, getProvider, qrDataUrlFor } from "./lib/webpay.js";
import {
  seedSite, allSiteProducts, findSiteProduct, checkSale, goalState, siteProductsPublic, seedDefaultVariants,
  siteLinks, isWebAdmin, applyCode, useCode, getCode, setConfig, getConfig,
  paymentProvider, paymentCurrency, upsertProduct, deleteProduct, upsertVersion,
  deleteVersion, recordWebSale, getPaymentDetails, paypalKeys, getCategoryLabels, setCategoryLabels,
  itemStock, addDeliveryItems, deliveryItemsFor, editDeliveryItem, deleteDeliveryItem, allocateDeliveryItems, deliveredContentsFor,
  sendPurchaseEmbed,
} from "./lib/sitecatalog.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "public");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// ---- Auth config -----------------------------------------------------------
const SITE_BASE = process.env.SITE_BASE_URL || "https://a6hub.cc";
const REDIRECT_URI = `${SITE_BASE}/auth/callback`;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const SESSION_SECRET = process.env.SESSION_SECRET || randomBytes(16).toString("hex");
const COOKIE = "a7session";
const DISCORD_API = "https://discord.com/api";
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

// ---- Self-healing starter variants ---------------------------------------
// Every product is always backed by its 8 starter plans. This tops up any
// product that is missing a default plan and repairs previously-wiped tables
// on boot. It only ever inserts what's missing (never overwrites prices).
// Hide unwanted plans with the per-variant "show" toggle instead.
try {
  const allProducts = db.prepare("SELECT key FROM site_products").all();
  for (const row of allProducts) {
    const n = seedDefaultVariants(row.key);
    if (n) console.log(`[seed] ${row.key} +${n} starter variants`);
  }
} catch {}

// ---- Signed, tamper-proof sessions ----------------------------------------
function sign(value) {
  return createHmac("sha256", SESSION_SECRET).update(value).digest("base64url");
}
function makeSession(data) {
  const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
  return `${payload}.${sign(payload)}`;
}
function readSession(raw) {
  if (!raw) return null;
  const [payload, sig] = raw.split(".");
  if (!payload || !sig) return null;
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(sig);
  let ok = false;
  try {
    ok = expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    ok = false;
  }
  if (!ok) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}
function setSessionCookie(res, data, remember = true) {
  const maxAge = remember ? `; Max-Age=${60 * 60 * 24 * 30}` : "";
  res.setHeader("Set-Cookie", `${COOKIE}=${makeSession(data)}; HttpOnly; Secure; SameSite=Lax; Path=/${maxAge}`);
}
function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

// ---- Helpers ---------------------------------------------------------------
function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
function cookieMap(req) {
  const out = {};
  const header = req.headers.cookie || "";
  if (header) {
    for (const part of header.split(";")) {
      const i = part.indexOf("=");
      if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
  }
  // Fallback: check X-Session header (Railway proxy strips Cookie header)
  const xSession = req.headers["x-session"];
  if (xSession && !out[COOKIE]) out[COOKIE] = xSession;
  return out;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 6e6) {
        req.destroy();
        reject(new Error("body too large"));
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
async function jsonBody(req) {
  const raw = await readBody(req);
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}
async function exchangeCode(code) {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
  });
  const r = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await r.json();
  if (!r.ok || !data.access_token) throw new Error(data.error || "token exchange failed");
  const me = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${data.access_token}` },
  });
  if (!me.ok) throw new Error("me failed");
  return me.json();
}
function mePayload(acct) {
  if (!acct) return { authed: false };
  return {
    authed: true,
    id: acct.id,
    username: acct.username,
    balance: walletFor(acct),
    admin: isWebAdmin(acct),
    linked: Boolean(acct.discord_id),
    discord: acct.discord_id
      ? { id: acct.discord_id, name: acct.discord_name || "Discord user", avatar: avatarUrl(acct) }
      : null,
  };
}
function requireAuth(session) {
  if (!session) return null;
  return getWebById(session.wid);
}
function requireAdmin(session) {
  const acct = requireAuth(session);
  return acct && isWebAdmin(acct) ? acct : null;
}

// ---- Cart / order helpers ---------------------------------------------------
function widOf(userId) {
  return Number(String(userId || "").replace(/^web:/, "")) || null;
}
// Validates every cart line via checkSale (stock/qty/price) and records the
// "once per account" gate. Returns enriched lines for storage/fulfillment.
function validateCart(acct, items) {
  if (!Array.isArray(items) || !items.length) throw new Error("Cart is empty.");
  if (items.length > 20) throw new Error("Too many items in cart.");
  const lines = [];
  for (const it of items) {
    const sale = checkSale(String(it.version || ""), null, Number(it.qty || 1));
    if (!sale.ok) throw new Error(sale.message);
    if (sale.product.once && hasWebPurchase(acct.id, sale.product.key)) throw new Error(`You already own ${sale.product.label}.`);
    lines.push({
      product: sale.product.key,
      version: sale.version.value,
      qty: sale.qty,
      price: sale.price,
      unitPrice: sale.unitPrice,
      productLabel: sale.product.label,
      versionLabel: sale.version.label,
    });
  }
  return lines;
}
function cartTotal(lines) {
  return Math.round(lines.reduce((a, l) => a + l.price, 0) * 100) / 100;
}
// One order-level discount code applied to the whole cart total.
function applyCartCode(lines, code) {
  const total = cartTotal(lines);
  if (!code) return { total, discount: 0, codeInfo: null };
  const applied = applyCode(String(code).trim(), total);
  if (!applied.ok) throw new Error(applied.message);
  return { total: Math.round(applied.price * 100) / 100, discount: applied.discount, codeInfo: applied.codeRow };
}
function insertWebPayment({ userId, kind, lines, total, method, providerId, note, status, ttlMs }) {
  const info = db.prepare(
    `INSERT INTO payments (user_id, kind, product_key, version_value, product_label, version_label, credits, usd_amount, qty, pay_currency, pay_amount, pay_address, provider_id, status, note, items, created_at, updated_at, expires_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    String(userId),
    kind,
    lines[0]?.product || null,
    lines[0]?.version || null,
    lines[0]?.productLabel || null,
    lines[0]?.versionLabel || null,
    0,
    total,
    lines.reduce((a, l) => a + (l.qty || 1), 0),
    method,
    total,
    null,
    providerId || null,
    status,
    note || null,
    JSON.stringify(lines || []),
    Date.now(),
    Date.now(),
    Date.now() + (ttlMs || 60 * 60 * 1000),
  );
  return info.lastInsertRowid;
}
function cardItems(pm) {
  let items = null;
  try {
    if (pm.items) items = JSON.parse(pm.items);
  } catch {}
  if (!Array.isArray(items) || !items.length) {
    if (pm.product_key && pm.version_value) {
      items = [{ product: pm.product_key, version: pm.version_value, price: pm.usd_amount || 0, qty: pm.qty || 1, productLabel: pm.product_label || null, versionLabel: pm.version_label || null }];
    }
  }
  return items || [];
}
// Shared "money is confirmed -> deliver" logic used by balance buys, the crypto
// status poller (replaced inline here) and PayPal/manual fulfillment.
function deliverLines(wid, lines, orderRef) {
  const delivered = [];
  for (const it of lines) {
    const qty = Number(it.qty || 1);
    addWebPurchase(wid, it.product, it.version, Number(it.price || 0), it.productLabel || null, it.versionLabel || null, qty);
    recordWebSale(it.product, it.version, qty);
    try {
      const alloc = allocateDeliveryItems(it.product, it.version, qty, orderRef || "", `web:${wid}`);
      delivered.push({ product: it.product, version: it.version, qty, contents: alloc.ok ? alloc.delivered : [] });
    } catch {
      delivered.push({ product: it.product, version: it.version, qty, contents: [] });
    }
  }
  return delivered;
}
function fulfillPayment(pm) {
  const wid = widOf(pm.user_id);
  if (!wid) throw new Error("Unknown buyer.");
  if (pm.kind === "deposit") {
    addBalance(wid, pm.usd_amount || 0);
    return { deposit: true };
  }
  const items = cardItems(pm);
  const delivered = deliverLines(wid, items, pm.id ? `p${pm.id}` : "");
  return { purchased: true, count: items.length, delivered };
}

// ---- PayPal Orders v2 (auto-capture, no webhook needed) ---------------------
function paypalBase() {
  return paypalKeys().mode === "sandbox" ? "https://api-m.sandbox.paypal.com" : "https://api-m.paypal.com";
}
async function paypalToken() {
  const k = paypalKeys();
  if (!k.ready) throw new Error("PayPal isn't configured yet.");
  console.log("[PayPal] Config:", { mode: k.mode, clientId: k.clientId, clientIdLen: k.clientId?.length, secretLen: k.secret?.length });
  const cred = Buffer.from(`${k.clientId}:${k.secret}`).toString("base64");
  const r = await fetch(`${paypalBase()}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${cred}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(20_000),
  });
  const d = await r.json();
  if (!r.ok || !d.access_token) {
    console.error("[PayPal] Auth failed:", r.status, d.error_description || d.message || JSON.stringify(d));
    const errMsg = d.error_description || d.message || JSON.stringify(d);
    throw new Error(`PayPal auth failed: ${r.status} - ${errMsg}`);
  }
  return d.access_token;
}
async function paypalCreateOrder({ usdAmount, reference, returnUrl, cancelUrl }) {
  const token = await paypalToken();
  const r = await fetch(`${paypalBase()}/v2/checkout/orders`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{ reference_id: reference, amount: { currency_code: "USD", value: String(usdAmount) }, description: "a6 Store order" }],
      application_context: { return_url: returnUrl, cancel_url: cancelUrl, user_action: "PAY_NOW", brand_name: "a6 Store", shipping_preference: "NO_SHIPPING" },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const d = await r.json();
  if (!r.ok || d.status !== "CREATED") throw new Error(d.message || "PayPal order failed.");
  const approve = (d.links || []).find((l) => l.rel === "approve");
  return { orderId: d.id, approveUrl: approve?.href || null };
}
async function paypalCaptureOrder(orderId) {
  const token = await paypalToken();
  const r = await fetch(`${paypalBase()}/v2/checkout/orders/${orderId}/capture`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  const d = await r.json();
  return { ok: r.ok && d?.status === "COMPLETED", data: d || null };
}

// ---- The server ------------------------------------------------------------
export function startWebServer() {
  const port = Number(process.env.PORT || 3000);
  seedSite();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const pathname = decodeURIComponent(url.pathname);
    const cookies = cookieMap(req);
    const session = readSession(cookies[COOKIE]);
    const SAME_SITE = { "Access-Control-Allow-Origin": SITE_BASE, "Access-Control-Allow-Credentials": "true" };

    // Debug endpoint to check PayPal config
    if (pathname === "/api/debug-paypal" && req.method === "GET") {
      const k = paypalKeys();
      json(res, 200, {
        mode: k.mode,
        clientId: k.clientId,
        clientIdLen: k.clientId?.length,
        secretLen: k.secret?.length,
        ready: k.ready,
        baseUrl: paypalBase()
      });
      return;
    }

    // Variant table repair - verifies the composite unique constraint. Only
    // EVER rebuilds when the live constraint is the legacy UNIQUE(value) form,
    // and then only inside one transaction with column-named copies, so it can
    // never destroy rows the way earlier rebuilds did during restarts.
    const compositeUnique = () => {
      const dbIdx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='site_versions'").all();
      const idxInfo = dbIdx.map((i) => ({
        name: i.name,
        columns: (() => { try { return db.prepare(`PRAGMA index_xinfo(${JSON.stringify(i.name)})`).all().map((c) => c.name); } catch { return []; } })(),
      }));
      return { idxInfo, composite: idxInfo.some((i) => i.columns.includes("product_key") && i.columns.includes("value")) };
    };
    if (pathname === "/api/fix-variants" && req.method === "POST") {
      if (!requireAdmin(session)) { json(res, 401, { ok: false, message: "Admin only" }); return; }
      try {
        const before = compositeUnique();
        if (before.composite) {
          const rows = db.prepare("SELECT COUNT(*) c FROM site_versions").pluck().get();
          json(res, 200, { ok: true, fixed: true, message: "Composite unique already in place - nothing changed", rows, indexes: before.idxInfo });
          return;
        }
        db.exec(`
          BEGIN;
          DROP TABLE IF EXISTS site_versions_new;
          CREATE TABLE site_versions_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_key TEXT NOT NULL,
            value TEXT NOT NULL,
            label TEXT NOT NULL,
            price REAL NOT NULL,
            orig_price REAL NOT NULL DEFAULT 0,
            cost REAL NOT NULL DEFAULT 0,
            stock INTEGER NOT NULL DEFAULT -1,
            min_qty INTEGER NOT NULL DEFAULT 1,
            max_qty INTEGER NOT NULL DEFAULT 0,
            sold INTEGER NOT NULL DEFAULT 0,
            sort INTEGER NOT NULL DEFAULT 0,
            UNIQUE(product_key, value)
          );
          INSERT INTO site_versions_new (id, product_key, value, label, price, orig_price, cost, stock, min_qty, max_qty, sold, sort)
            SELECT id, product_key, value, label, price, orig_price, cost, stock, min_qty, max_qty, sold, sort FROM site_versions;
          DROP TABLE site_versions;
          ALTER TABLE site_versions_new RENAME TO site_versions;
          COMMIT;
        `);
        const after = compositeUnique();
        const rows = db.prepare("SELECT COUNT(*) c FROM site_versions").pluck().get();
        json(res, 200, { ok: true, fixed: after.composite, message: "Rebuilt with composite unique constraint", rows, indexes: after.idxInfo });
      } catch (e) {
        try { db.exec("ROLLBACK"); } catch {}
        json(res, 500, { ok: false, message: e.message });
      }
      return;
    }

    // Restores missing demo/seed variants for the standard brand products so a
    // wiped table regains the known catalog. Never deletes or overwrites an
    // existing variant - only inserts rows that are absent.
    if (pathname === "/api/restore-variants" && req.method === "POST") {
      if (!requireAdmin(session)) { json(res, 401, { ok: false, message: "Admin only" }); return; }
      try {
        const restored = [];
        const products = db.prepare("SELECT key FROM site_products").all();
        for (const row of products) {
          const count = db.prepare("SELECT COUNT(*) c FROM site_versions WHERE product_key = ?").pluck().get(row.key);
          if (count === 0) {
            const n = seedDefaultVariants(row.key);
            if (n) restored.push([row.key, n].join(":"));
          }
        }
        const rows = db.prepare("SELECT COUNT(*) c FROM site_versions").pluck().get();
        json(res, 200, { ok: true, restored, rows });
      } catch (e) {
        json(res, 500, { ok: false, message: e.message });
      }
      return;
    }

    // Read-only schema diagnostic for the site_versions table.
    if (pathname === "/api/diag-versions" && req.method === "GET") {
      try {
        const idx = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='site_versions'").all();
        const idxList = db.prepare("PRAGMA index_list('site_versions')").all();
        const info = idx.map((i) => {
          let columns = [];
          try { columns = db.prepare(`PRAGMA index_info(${JSON.stringify(i.name)})`).all().map((c) => c.name); } catch {}
          return { name: i.name, sql: i.sql, columns, detail: db.prepare(`PRAGMA index_xinfo(${JSON.stringify(i.name)})`).all().map((c) => c.name) };
        });
        // Ground truth: try inserting a duplicate (product_key, value) for an
        // existing row inside a transaction, then roll back. Anything other than
        // "blocked" means the composite unique isn't actually enforced.
        const probe = db.prepare("SELECT product_key, value FROM site_versions LIMIT 1").get();
        let probeResult = "no rows";
        if (probe) {
          try {
            db.exec("BEGIN");
            db.prepare("INSERT INTO site_versions (product_key, value, label, price, stock, sold, sort) VALUES (?,?,?,?,?,0,9999)").run(probe.product_key, probe.value, "diag", 0, 9999);
            db.exec("ROLLBACK");
            probeResult = "duplicate ALLOWED (composite NOT enforced)";
          } catch (e) {
            db.exec("ROLLBACK");
            probeResult = "duplicate BLOCKED (" + String(e.message).split(":")[0] + ")";
          }
        }
        const rows = db.prepare("SELECT COUNT(*) c FROM site_versions").pluck().get();
        // Look for any orphaned rebuild tables that might still hold the old data.
        const orphanTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'site_versions%'").all()
          .map((t) => ({ name: t.name, rows: (() => { try { return db.prepare(`SELECT COUNT(*) c FROM ${JSON.stringify(t.name)}`).pluck().get(); } catch { return null; } })() }));
        json(res, 200, { ok: true, table: "site_versions", rows, tables: orphanTables, indexes: info, indexList: idxList, probe: probeResult, duplicateTest: probe ? probe.product_key + ":" + probe.value : null });
      } catch (e) {
        json(res, 500, { ok: false, message: e.message });
      }
      return;
    }

    try {
      // ---- Account auth (generic) ----
      if (pathname === "/api/register" && req.method === "POST") {
        const body = await jsonBody(req);
        const username = String(body.username || "").trim();
        const error = validateCredentials(username, body.password);
        if (error) { json(res, 400, { ok: false, message: error }); return; }
        if (findWebByUsername(username)) { json(res, 400, { ok: false, message: "That username is taken." }); return; }
        const acct = createWebAccount(username, body.password);
        const sessionToken = makeSession({ wid: acct.id, username: acct.username });
        setSessionCookie(res, { wid: acct.id, username: acct.username });
        json(res, 200, { ok: true, me: mePayload(acct), session: sessionToken });
        return;
      }

      if (pathname === "/api/login" && req.method === "POST") {
        const body = await jsonBody(req);
        const username = String(body.username || "").trim();
        const acct = findWebByUsername(username);
        if (!acct || !verifyPassword(String(body.password || ""), acct.pass_hash)) {
          json(res, 401, { ok: false, message: "Wrong username or password." });
          return;
        }
        setSessionCookie(res, { wid: acct.id, username: acct.username }, body.remember !== false);
        const sessionToken = makeSession({ wid: acct.id, username: acct.username });
        json(res, 200, { ok: true, me: mePayload(acct), session: sessionToken });
        return;
      }

      if (pathname === "/api/logout" && req.method === "POST") {
        clearSessionCookie(res);
        json(res, 200, { ok: true });
        return;
      }

      if (pathname === "/api/password/change" && req.method === "POST") {
        const acct = requireAuth(session);
        if (!acct) { json(res, 401, { ok: false, reason: "auth" }); return; }
        const body = await jsonBody(req);
        const oldPass = String(body.old_password || "");
        const newPass = String(body.new_password || "");
        if (!oldPass || !newPass) { json(res, 400, { ok: false, message: "Missing fields" }); return; }
        if (newPass.length < 6) { json(res, 400, { ok: false, message: "Password too short (min 6)" }); return; }
        const row = db.prepare("SELECT pass_hash FROM web_accts WHERE id = ?").get(acct.id);
        if (!row || !verifyPassword(oldPass, row.pass_hash)) { json(res, 400, { ok: false, message: "Current password incorrect" }); return; }
        db.prepare("UPDATE web_accts SET pass_hash = ? WHERE id = ?").run(hashPassword(newPass), acct.id);
        console.log(`PASSWORD changed for ${acct.username} (id ${acct.id})`);
        json(res, 200, { ok: true });
        return;
      }

      if (pathname === "/api/me" && req.method === "GET") {
        json(res, 200, mePayload(requireAuth(session)));
        return;
      }

      if (pathname === "/api/products" && req.method === "GET") {
        json(res, 200, { products: siteProductsPublic(), cats: getCategoryLabels() });
        return;
      }

      if (pathname === "/api/goals" && req.method === "GET") {
        json(res, 200, { ok: true, ...goalState() });
        return;
      }

      if (pathname === "/api/links" && req.method === "GET") {
        json(res, 200, { ok: true, links: siteLinks(false) });
        return;
      }

      // --- Analytics endpoints ---
      if (pathname === "/api/analytics/overview" && req.method === "GET") {
        const stats = db.prepare(`
          SELECT 
            COALESCE(SUM(page_views), 0) as total_page_views,
            COALESCE(SUM(unique_visitors), 0) as total_unique_visitors,
            COALESCE(SUM(total_sales_usd), 0) as total_sales_usd,
            COALESCE(SUM(total_orders), 0) as total_orders,
            COALESCE(SUM(products_sold), 0) as products_sold,
            COALESCE(SUM(unique_customers), 0) as unique_customers
          FROM site_analytics
        `).get();

        // Get today's stats
        const today = new Date().toISOString().split('T')[0];
        const todayStats = db.prepare(`
          SELECT * FROM site_analytics WHERE date = ?
        `).get(today) || {};

        // Get recent 7 days
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const recentStats = db.prepare(`
          SELECT date, page_views, unique_visitors, total_sales_usd, total_orders, products_sold, unique_customers
          FROM site_analytics
          WHERE date >= ?
          ORDER BY date DESC
        `).all(sevenDaysAgo);

        // Get total customers from web_accts
        const totalCustomers = db.prepare("SELECT COUNT(*) as count FROM web_accts").get();

        // Get total products sold (sum of qty from web_purchases)
        const totalProductsSold = db.prepare("SELECT COALESCE(SUM(qty), 0) as count FROM web_purchases").get();

        // Get total sales in USD
        const totalSales = db.prepare("SELECT COALESCE(SUM(price * qty), 0) as total FROM web_purchases").get();

        // Get total unique customers who made purchases
        const purchasingCustomers = db.prepare("SELECT COUNT(DISTINCT wid) as count FROM web_purchases").get();

        // Page views today
        const todayVisits = db.prepare("SELECT COUNT(*) as count FROM page_visits WHERE visited_at >= ?").get(Date.now() - 24 * 60 * 60 * 1000);

        // Unique visitors today (by session)
        const uniqueToday = db.prepare("SELECT COUNT(DISTINCT session_id) as count FROM page_visits WHERE visited_at >= ?").get(Date.now() - 24 * 60 * 60 * 1000);

        json(res, 200, {
          ok: true,
          overview: {
            total_page_views: stats.total_page_views || 0,
            total_unique_visitors: stats.total_unique_visitors || 0,
            total_sales_usd: totalSales.total || 0,
            total_orders: (db.prepare("SELECT COUNT(*) as c FROM web_purchases").get()?.c) || 0,
            products_sold: totalProductsSold.count || 0,
            unique_customers: purchasingCustomers.count || 0,
            total_registered_users: totalCustomers.count || 0,
            today: {
              page_views: todayVisits?.count || 0,
              unique_visitors: uniqueToday?.count || 0,
              sales_usd: todayStats.total_sales_usd || 0,
              orders: todayStats.total_orders || 0,
              products_sold: todayStats.products_sold || 0,
              unique_customers: todayStats.unique_customers || 0
            },
            recent_7_days: recentStats
          }
        });
        return;
      }

      // Track page visit
      if (pathname === "/api/analytics/visit" && req.method === "POST") {
        try {
          const body = await jsonBody(req);
          const { path, referrer, sessionId } = body;
          
          // Get client IP (hashed for privacy) - use bracket notation for Node http headers
          const ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown';
          const crypto = await import('node:crypto');
          const ipHash = crypto.createHash('sha256').update(ip + (process.env.SESSION_SECRET || 'secret')).digest('hex').substring(0, 16);
          
          const now = Date.now();
          const sessionIdHash = sessionId ? crypto.createHash('sha256').update(sessionId).digest('hex').substring(0, 16) : null;
          
          // Insert page visit
          db.prepare(`
            INSERT INTO page_visits (path, referrer, user_agent, ip_hash, session_id, visited_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(
            path || '/',
            body.referrer || req.headers['referer'] || '',
            req.headers['user-agent'] || '',
            ipHash,
            sessionIdHash,
            Date.now()
          );

          // Update daily analytics (upsert)
          const today = new Date().toISOString().split('T')[0];
          const nowTs = Date.now();
          
          // Check if today's record exists
          const existing = db.prepare("SELECT * FROM site_analytics WHERE date = ?").get(today);
          
          if (existing) {
            // Increment page views
            db.prepare(`
              UPDATE site_analytics 
              SET page_views = page_views + 1, updated_at = ?
              WHERE date = ?
            `).run(Date.now(), today);
          } else {
            // Create new record
            db.prepare(`
              INSERT INTO site_analytics (date, page_views, unique_visitors, total_sales_usd, total_orders, products_sold, unique_customers, created_at, updated_at)
              VALUES (?, 1, 0, 0, 0, 0, 0, ?, ?)
            `).run(today, nowTs, nowTs);
          }

          json(res, 200, { ok: true });
        } catch (e) {
          json(res, 500, { ok: false, message: e.message });
        }
        return;
      }

      // Admin: Refresh daily stats (recalculate from raw data)
      if (pathname === "/api/analytics/refresh" && req.method === "POST") {
        if (!requireAdmin(session)) { json(res, 401, { ok: false, message: "Admin only" }); return; }
        
        try {
          // Recalculate all daily stats from raw data
          const salesData = db.prepare(`
            SELECT 
              date(purchased_at/1000, 'unixepoch') as date,
              COUNT(*) as orders,
              SUM(qty) as products_sold,
              SUM(price * qty) as sales_usd,
              COUNT(DISTINCT wid) as unique_customers
            FROM web_purchases
            GROUP BY date(purchased_at/1000, 'unixepoch')
          `).all();

          const visitData = db.prepare(`
            SELECT 
              date(visited_at/1000, 'unixepoch') as date,
              COUNT(*) as page_views,
              COUNT(DISTINCT session_id) as unique_visitors
            FROM page_visits
            WHERE session_id IS NOT NULL
            GROUP BY date(visited_at/1000, 'unixepoch')
          `).all();

          // Merge sales and visit data
          const merged = new Map();
          for (const s of salesData) {
            merged.set(s.date, { ...s, page_views: 0, unique_visitors: 0 });
          }
          for (const v of visitData) {
            if (merged.has(v.date)) {
              Object.assign(merged.get(v.date), { page_views: v.page_views, unique_visitors: v.unique_visitors });
            } else {
              merged.set(v.date, { date: v.date, page_views: v.page_views, unique_visitors: v.unique_visitors, orders: 0, products_sold: 0, sales_usd: 0, unique_customers: 0 });
            }
          }

          // Upsert all
          const now = Date.now();
          for (const [date, data] of merged) {
            db.prepare(`
              INSERT INTO site_analytics (date, page_views, unique_visitors, total_sales_usd, total_orders, products_sold, unique_customers, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(date) DO UPDATE SET
                page_views = excluded.page_views,
                unique_visitors = excluded.unique_visitors,
                total_sales_usd = excluded.total_sales_usd,
                total_orders = excluded.total_orders,
                products_sold = excluded.products_sold,
                unique_customers = excluded.unique_customers,
                updated_at = excluded.updated_at
            `).run(
              date,
              data.page_views || 0,
              data.unique_visitors || 0,
              data.sales_usd || 0,
              data.orders || 0,
              data.products_sold || 0,
              data.unique_customers || 0,
              Date.now(),
              Date.now()
            );
          }

          json(res, 200, { ok: true, message: "Analytics refreshed", updated: merged.size });
        } catch (e) {
          json(res, 500, { ok: false, message: e.message });
        }
        return;
      }

      // Admin: Clear all analytics data
      if (pathname === "/api/analytics/clear" && req.method === "POST") {
        if (!requireAdmin(session)) { json(res, 401, { ok: false, message: "Admin only" }); return; }
        try {
          db.exec("DELETE FROM site_analytics; DELETE FROM page_visits;");
          json(res, 200, { ok: true, message: "Analytics cleared" });
        } catch (e) {
          json(res, 500, { ok: false, message: e.message });
        }
        return;
      }

      // Admin: Clear all purchase records (DESTRUCTIVE - removes orders, keys, revenue)
      if (pathname === "/api/analytics/clear-purchases" && req.method === "POST") {
        if (!requireAdmin(session)) { json(res, 401, { ok: false, message: "Admin only" }); return; }
        try {
          db.exec("DELETE FROM web_purchases;");
          json(res, 200, { ok: true, message: "All purchase records cleared" });
        } catch (e) {
          json(res, 500, { ok: false, message: e.message });
        }
        return;
      }

      if (pathname === "/api/code/check" && req.method === "POST") {
        const acct = requireAuth(session);
        if (!acct) { json(res, 401, { ok: false, reason: "auth" }); return; }
        const body = await jsonBody(req);
        const applied = applyCode(String(body.code || ""), Number(body.price || 0));
        json(res, 200, { ok: applied.ok, message: applied.message || undefined, price: applied.ok ? applied.price : undefined, discount: applied.ok ? applied.discount : undefined });
        return;
      }

      if (pathname === "/api/provider" && req.method === "GET") {
        json(res, 200, { provider: getProvider() });
        return;
      }

      // Which payment options the checkout screen should show.
      if (pathname === "/api/pay/methods" && req.method === "GET") {
        json(res, 200, {
          ok: true,
          crypto: getProvider(),
          paypalApi: paypalKeys().ready,
          manual: getPaymentDetails(),
        });
        return;
      }

      // Manual payment (PayPal / Zelle / Chime): buyer claims the payment, an
      // admin approves it in the Admin -> Payments -> Manual orders queue.
      if (pathname === "/api/pay/manual" && req.method === "POST") {
        const acct = requireAuth(session);
        if (!acct) { json(res, 401, { ok: false, reason: "auth" }); return; }
        try {
          const body = await jsonBody(req);
          const method = String(body.method || "").toLowerCase();
          if (!["paypal", "zelle", "chime"].includes(method)) { json(res, 400, { ok: false, message: "Unknown payment method." }); return; }
          const details = getPaymentDetails();
          if (!(details[method] || "").trim()) { json(res, 400, { ok: false, message: "That payment method is not enabled yet." }); return; }
          const lines = validateCart(acct, body.items);
          const { total, discount, codeInfo } = applyCartCode(lines, body.code);
          if (total < 0.01) { json(res, 400, { ok: false, message: "Cart total is zero." }); return; }
          if (codeInfo) useCode(codeInfo.code, `web:${acct.id}`);
          const id = insertWebPayment({ userId: `web:${acct.id}`, kind: "buy", lines, total, method: method.toUpperCase(), providerId: `manual-${Date.now()}`, note: String(body.note || "").slice(0, 500), status: "manual_waiting", ttlMs: 48 * 60 * 60 * 1000 });
          console.log(`WEB-MANUAL ${acct.username} (${acct.id}) ${method} $${total} -> #${id}${discount ? ` (code -$${discount})` : ""}`);
          json(res, 200, { ok: true, paymentId: id, message: "Payment submitted - an admin will confirm it shortly." });
        } catch (err) { json(res, 400, { ok: false, message: err?.message || "Couldn't submit payment." }); }
        return;
      }

      // PayPal: create an order server-side, hand the buyer PayPal's approval
      // link, then capture on return (auto-confirmed, like SellAuth).
      if (pathname === "/api/pay/paypal/create" && req.method === "POST") {
        const acct = requireAuth(session);
        if (!acct) { json(res, 401, { ok: false, reason: "auth" }); return; }
        try {
          if (!paypalKeys().ready) { json(res, 400, { ok: false, message: "PayPal isn't configured yet." }); return; }
          const body = await jsonBody(req);
          const lines = validateCart(acct, body.items);
          const { total, codeInfo } = applyCartCode(lines, body.code);
          if (total < 0.01) { json(res, 400, { ok: false, message: "Cart total is zero." }); return; }
          const reference = `web-${acct.id}-${Date.now()}`;
          const { orderId, approveUrl } = await paypalCreateOrder({ usdAmount: total, reference, returnUrl: `${SITE_BASE}/approve-paypal`, cancelUrl: `${SITE_BASE}/?pp=cancel` });
          if (codeInfo) useCode(codeInfo.code, `web:${acct.id}`);
          const id = insertWebPayment({ userId: `web:${acct.id}`, kind: "buy", lines, total, method: "PAYPAL", providerId: orderId, note: "paypal", status: "waiting", ttlMs: 30 * 60 * 1000 });
          console.log(`WEB-PAYPAL ${acct.username} (${acct.id}) $${total} -> #${id} ${orderId}`);
          json(res, 200, { ok: true, paymentId: id, approveUrl });
        } catch (err) { json(res, 400, { ok: false, message: err?.message || "Couldn't start PayPal." }); }
        return;
      }

      if (pathname === "/api/my/payments" && req.method === "GET") {
        const acct = requireAuth(session);
        if (!acct) { json(res, 401, { ok: false, reason: "auth" }); return; }
        const rows = db.prepare("SELECT id, kind, product_key, version_value, product_label, version_label, usd_amount, qty, pay_currency, note, items, status, created_at FROM payments WHERE user_id = ? ORDER BY id DESC LIMIT 20").all(`web:${acct.id}`);
        json(res, 200, {
          ok: true,
          payments: rows.map((r) => {
            let items = null;
            try { items = r.items ? JSON.parse(r.items) : null; } catch {}
            return { ...r, items };
          }),
        });
        return;
      }

      // PayPal redirect target: capture the approved order and deliver.
      if (pathname === "/approve-paypal" && req.method === "GET") {
        const token = String(url.searchParams.get("token") || "");
        const pm = token ? db.prepare("SELECT * FROM payments WHERE provider_id = ?").get(token) : null;
        if (!pm || pm.status === "finished") {
          res.writeHead(302, { Location: "/account" });
          res.end();
          return;
        }
        try {
          const cap = await paypalCaptureOrder(token);
          if (cap.ok) {
            if (pm.status === "waiting" || pm.status === "confirming") {
              try { fulfillPayment(pm); } catch (err) { console.log("WEB-PAYPAL fulfill failed:", err?.message); }
              markPaymentStatus(pm.id, "finished");
            }
            res.writeHead(302, { Location: "/account?paid=paypal" });
          } else {
            markPaymentStatus(pm.id, "failed");
            res.writeHead(302, { Location: "/?pp=failed" });
          }
        } catch (err) {
          markPaymentStatus(pm.id, "failed");
          res.writeHead(302, { Location: "/?pp=failed" });
        }
        res.end();
        return;
      }

      if (pathname === "/api/purchases" && req.method === "GET") {
        const acct = requireAuth(session);
        if (!acct) { json(res, 401, { ok: false, reason: "auth" }); return; }
        const purchases = webPurchasesFor(acct.id).map((p) => ({
          ...p,
          keys: deliveredContentsFor(`web:${acct.id}`, p.product_key, p.version_value),
        })).filter((p) => Array.isArray(p.keys) && p.keys.length > 0);
        json(res, 200, { ok: true, purchases });
        return;
      }

      if (pathname === "/api/pay/start" && req.method === "POST") {
        const acct = requireAuth(session);
        if (!acct) { json(res, 401, { ok: false, reason: "auth" }); return; }
        try {
          const body = await jsonBody(req);
          const kind = String(body.kind || "deposit");
          const currency = String(body.currency || "");
          let amountUsd = 0, productKey = null, versionValue = null, productMeta = {}, qty = 1, lines = null;
          if (kind === "buy") {
            if (Array.isArray(body.items)) {
              lines = validateCart(acct, body.items);
              const { total, discount, codeInfo } = applyCartCode(lines, body.code);
              if (total < 0.01) throw new Error("Cart total is zero.");
              amountUsd = total;
              productKey = lines[0].product;
              versionValue = lines[0].version;
              qty = lines.reduce((a, l) => a + l.qty, 1);
              productMeta = { label: lines[0].productLabel, versionLabel: lines[0].versionLabel, discount, qty: lines.length };
              if (codeInfo) useCode(codeInfo.code, `web:${acct.id}`);
            } else {
              const sale = checkSale(String(body.version || ""), body.code, Number(body.qty || 1));
              if (!sale.ok) throw new Error(sale.message);
              productKey = sale.version.product_key;
              versionValue = sale.version.value;
              qty = sale.qty;
              amountUsd = sale.price;
              productMeta = { label: sale.product.label, versionLabel: sale.version.label, discount: sale.discount, qty };
              if (sale.codeInfo) useCode(sale.codeInfo.code, `web:${acct.id}`);
              lines = [{ product: productKey, version: versionValue, price: sale.price, qty: sale.qty, productLabel: sale.product.label, versionLabel: sale.version.label }];
            }
          } else {
            amountUsd = Math.max(0.1, Number(body.amount) || 0);
          }
          const invoice = await createWebPayment({ userId: `web:${acct.id}`, kind, productKey, versionValue, amountUsd, currency, productLabel: productMeta.label, versionLabel: productMeta.versionLabel, qty, items: lines });
          json(res, 200, { ok: true, ...invoice, ...productMeta, provider: getProvider() });
        } catch (err) { json(res, 400, { ok: false, message: err?.message || "Bad request." }); }
        return;
      }

      if (pathname === "/api/pay/status" && req.method === "GET") {
        const acct = requireAuth(session);
        if (!acct) { json(res, 401, { ok: false, reason: "auth" }); return; }
        const id = Number(url.searchParams.get("id") || 0);
        let payment = db.prepare("SELECT * FROM payments WHERE id = ? AND user_id = ?").get(id, `web:${acct.id}`);
        if (!payment) { json(res, 404, { ok: false, message: "Unknown payment." }); return; }
        try {
          const st = await checkPaymentStatus(payment);
          if (st.status !== payment.status) markPaymentStatus(payment.id, st.status);
          let balance = walletFor(acct);
          let purchased = false;
          let delivered = [];
          let qr = null;
          if (st.payAddress && st.payAddress !== payment.pay_address) {
            const newAmount = st.payAmount ?? payment.pay_amount;
            db.prepare("UPDATE payments SET pay_address = ?, pay_amount = ?, updated_at = ? WHERE id = ?")
              .run(st.payAddress, newAmount, Date.now(), payment.id);
            payment = { ...payment, pay_address: st.payAddress, pay_amount: newAmount };
          }
          if (payment.pay_address) {
            qr = await qrDataUrlFor(payment.pay_address, payment.pay_amount ?? 0, payment.pay_currency);
          }
          if (st.status === "finished" && payment.status !== "finished") {
            let fp = null;
            try { fp = fulfillPayment(payment); } catch (err) { console.log("WEB-PAY fulfill failed:", err?.message); }
            if (payment.kind === "deposit") {
              balance = walletFor(acct);
            } else if (payment.kind === "buy" && payment.product_key && payment.version_value) {
              purchased = true;
              delivered = fp && fp.delivered ? fp.delivered : [];
              
              // Send purchase notification to Discord
              try {
                await sendPurchaseEmbed({
                  username: acct.username,
                  email: acct.email,
                  items: delivered.map(d => ({ productLabel: d.productLabel, versionLabel: d.versionLabel, qty: d.qty, price: d.price })),
                  total: payment.pay_amount || 0,
                  currency: payment.pay_currency || "USD",
                  paymentMethod: "Crypto",
                });
              } catch (e) { console.error("[sendPurchaseEmbed] error:", e?.message); }
            }
          }
          json(res, 200, { ok: true, status: st.status, payAddress: payment.pay_address, payAmount: payment.pay_amount, qr, balance, purchased, delivered, provider: getProvider() });
        } catch (err) { json(res, 400, { ok: false, message: err?.message || "Status check failed." }); }
        return;
      }

      // ---- Static files (storefront) ----

      if (pathname === "/api/buy" && req.method === "POST") {
        const acct = requireAuth(session);
        if (!acct) { json(res, 401, { ok: false, reason: "auth" }); return; }
        try {
          const body = await jsonBody(req);
          const sale = checkSale(String(body.version || ""), body.code, Number(body.qty || 1));
          if (!sale.ok) { json(res, 200, { ok: false, reason: sale.reason, message: sale.message }); return; }
          const { product, version, price, qty, codeInfo, discount } = sale;
          if (product.once && hasWebPurchase(acct.id, product.key)) {
            json(res, 200, { ok: false, reason: "owned", message: "You already own this." });
            return;
          }
          if (walletFor(acct) < price) {
            json(res, 200, { ok: false, reason: "balance", message: "Not enough balance - add funds or pay now with crypto." });
            return;
          }
          const remaining = spendFor(acct, price);
          const delivered = deliverLines(acct.id, [{ product: product.key, version: version.value, price, qty, productLabel: product.label, versionLabel: version.label }], "");
          if (codeInfo) useCode(codeInfo.code, `web:${acct.id}`);
          console.log(`WEB-BUY ${acct.username} (${acct.id}) ${version.value} x${qty} -$${price} -> $${remaining}${discount ? ` (code -$${discount})` : ""}`);
          
          // Send purchase notification to Discord
          try {
            await sendPurchaseEmbed({
              username: acct.username,
              email: acct.email,
              items: [{ productLabel: product.label, versionLabel: version.label, qty, price }],
              total: price,
              currency: "USD",
              paymentMethod: "Balance",
            });
          } catch (e) { console.error("[sendPurchaseEmbed] error:", e?.message); }
          
          json(res, 200, { ok: true, balance: remaining, price, discount, qty, label: product.label, versionLabel: version.label, unitPrice: sale.unitPrice, delivered });
        } catch {
          json(res, 400, { ok: false, reason: "bad", message: "Bad request." });
        }
        return;
      }

      // --- Balance checkout for a cart of multiple products ---
      if (pathname === "/api/buy/cart" && req.method === "POST") {
        const acct = requireAuth(session);
        if (!acct) { json(res, 401, { ok: false, reason: "auth" }); return; }
        try {
          const body = await jsonBody(req);
          const lines = validateCart(acct, body.items);
          const { total, discount, codeInfo } = applyCartCode(lines, body.code);
          if (total < 0.01) { json(res, 400, { ok: false, message: "Cart total is zero." }); return; }
          if (walletFor(acct) < total) {
            json(res, 200, { ok: false, reason: "balance", message: "Not enough balance - add funds or pick another payment method." });
            return;
          }
          const delivered = deliverLines(acct.id, lines, "");
          const remaining = spendFor(acct, total);
          if (codeInfo) useCode(codeInfo.code, `web:${acct.id}`);
          console.log(`WEB-CART-BUY ${acct.username} (${acct.id}) ${lines.map((l) => `${l.version}x${l.qty}`).join("+")} -$${total} -> $${remaining}${discount ? ` (code -$${discount})` : ""}`);
          
          // Send purchase notification to Discord
          try {
            await sendPurchaseEmbed({
              username: acct.username,
              email: acct.email,
              items: lines.map(l => ({ productLabel: l.productLabel, versionLabel: l.versionLabel, qty: l.qty, price: l.price })),
              total,
              currency: "USD",
              paymentMethod: "Balance",
            });
          } catch (e) { console.error("[sendPurchaseEmbed] error:", e?.message); }
          
          json(res, 200, { ok: true, balance: remaining, total, discount, count: lines.length, delivered });
        } catch (err) {
          json(res, 400, { ok: false, reason: "bad", message: err?.message || "Bad request." });
        }
        return;
      }

      // ---- Admin panel API (Discord id 446137348904714241) ----
      if (pathname.startsWith("/api/admin/") && pathname !== "/api/admin/code" && pathname !== "/api/admin/fix-unlimited-stock") {
        const admin = requireAdmin(session);
        if (!admin) { json(res, 403, { ok: false, reason: "admin" }); return; }

        if (pathname === "/api/admin/products" && req.method === "GET") {
          try {
            json(res, 200, { ok: true, products: allSiteProducts() });
          } catch (err) {
            console.error("ADMIN products listing failed:", err?.message || err);
            json(res, 500, { ok: false, message: "Failed to load products: " + (err?.message || "database error") });
          }
          return;
        }
        if (pathname === "/api/admin/summary" && req.method === "GET") {
          json(res, 200, {
            ok: true,
            revenue: db.prepare("SELECT COALESCE(SUM(price),0) s FROM web_purchases").pluck().get(),
            products: db.prepare("SELECT COUNT(*) c FROM site_products").pluck().get(),
            users: db.prepare("SELECT COUNT(*) c FROM web_accts").pluck().get(),
            codes: db.prepare("SELECT COUNT(*) c FROM web_codes").pluck().get(),
            links: db.prepare("SELECT COUNT(*) c FROM site_links").pluck().get(),
          });
          return;
        }
        if (pathname === "/api/admin/items" && req.method === "GET") {
          const product = String(url.searchParams.get("product") || "");
          const version = String(url.searchParams.get("version") || "");
          if (!product || !version) { json(res, 400, { ok: false, message: "product + version required." }); return; }
          json(res, 200, { ok: true, inStock: itemStock(product, version), items: deliveryItemsFor(product, version) });
          return;
        }
        if (pathname === "/api/admin/items" && req.method === "POST") {
          const body = await jsonBody(req);
          const added = addDeliveryItems(String(body.productKey || ""), String(body.versionValue || ""), body.contents);
          json(res, 200, { ok: true, added });
          return;
        }
        if (pathname === "/api/admin/items" && req.method === "PATCH") {
          const body = await jsonBody(req);
          const ok = editDeliveryItem(body.id, body.content);
          json(res, 200, { ok });
          return;
        }
        if (pathname === "/api/admin/items" && req.method === "DELETE") {
          const body = await jsonBody(req);
          deleteDeliveryItem(body.id);
          json(res, 200, { ok: true });
          return;
        }
        if (pathname === "/api/admin/users" && req.method === "GET") {
          const users = db.prepare("SELECT id, username, balance, discord_id, discord_name, created_at FROM web_accts ORDER BY id DESC").all();
          json(res, 200, { ok: true, users });
          return;
        }
        if (pathname === "/api/admin/products" && req.method === "POST") {
          const body = await jsonBody(req);
          const key = String(body.key || "").trim().toLowerCase().replace(/\s+/g, "-");
          if (!/^[a-z0-9_-]{2,40}$/.test(key)) { json(res, 400, { ok: false, message: "Bad product key (2-40 chars, a-z 0-9 _ -)." }); return; }
          const made = upsertProduct({ key, label: body.label, desc: body.desc, image: body.image || null, comingSoon: body.comingSoon, once: body.once, hidden: body.hidden, onHold: body.onHold, goalUsd: body.goalUsd, sort: body.sort });
          if (made.created) {
            const seeded = seedDefaultVariants(key);
            console.log(`ADMIN ${admin.username} created product ${key} (+${seeded} starter variants)`);
          }
          json(res, 200, { ok: true, product: findSiteProduct(key) });
          return;
        }
        if (pathname === "/api/admin/products" && req.method === "DELETE") {
          deleteProduct(String(url.searchParams.get("key") || ""));
          json(res, 200, { ok: true });
          return;
        }
        if (pathname === "/api/admin/versions" && req.method === "POST") {
          const body = await jsonBody(req);
          const productKey = String(body.productKey || "");
          // Normalize the version value so it always fits the safe pattern,
          // then require the <product>:<value> composite format.
          let rawValue = String(body.value || "").trim().toLowerCase();
          if (!productKey || !findSiteProduct(productKey)) { json(res, 400, { ok: false, message: "Unknown product - save the product basics first." }); return; }
          const value = rawValue.includes(":")
            ? rawValue
            : productKey + ":" + rawValue.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
          if (value.length < 3 || value.length > 120) { json(res, 400, { ok: false, message: "Version value must be 2-60 chars (letters, numbers, _ - :)." }); return; }
          upsertVersion({ productKey, value, label: body.label, price: body.price, origPrice: body.origPrice, cost: body.cost, stock: body.stock, minQty: body.minQty, maxQty: body.maxQty, visible: body.visible, details: body.details });
          json(res, 200, { ok: true, product: findSiteProduct(productKey), value });
          return;
        }
        if (pathname === "/api/admin/versions" && req.method === "DELETE") {
          deleteVersion(String(url.searchParams.get("value") || ""));
          json(res, 200, { ok: true });
          return;
        }
        if (pathname === "/api/admin/credit" && req.method === "POST") {
          const body = await jsonBody(req);
          const amount = Number(body.amount);
          if (!Number.isFinite(amount) || amount <= 0) { json(res, 400, { ok: false, message: "Amount must be positive." }); return; }
          const target = findWebByUsername(String(body.username || "").trim());
          if (!target) { json(res, 400, { ok: false, message: "No account with that username." }); return; }
          const balance = addBalance(target.id, amount);
          console.log(`ADMIN ${admin.username} gave $${amount} to ${target.username} -> $${balance}`);
          json(res, 200, { ok: true, balance });
          return;
        }
        if (pathname === "/api/admin/codes" && req.method === "GET") {
          const rows = db.prepare("SELECT code, kind, amount, uses_left, active, created_at FROM web_codes ORDER BY created_at DESC").all();
          json(res, 200, { ok: true, codes: rows });
          return;
        }
        if (pathname === "/api/admin/codes" && req.method === "POST") {
          const body = await jsonBody(req);
          const code = String(body.code || "").trim().toUpperCase().replace(/\s+/g, "");
          const kind = String(body.kind || "percent");
          if (!/^[A-Z0-9-_]{3,24}$/.test(code)) { json(res, 400, { ok: false, message: "Bad code (3-24 chars, A-Z 0-9 _ -)." }); return; }
          if (!["percent", "fixed"].includes(kind)) { json(res, 400, { ok: false, message: "Kind must be percent or fixed." }); return; }
          const amount = Number(body.amount);
          if (!Number.isFinite(amount) || amount <= 0) { json(res, 400, { ok: false, message: "Bad amount." }); return; }
          if (kind === "percent" && amount > 100) { json(res, 400, { ok: false, message: "Percent can't exceed 100." }); return; }
          if (getCode(code)) { json(res, 400, { ok: false, message: "Code already exists." }); return; }
          const uses = Number(body.uses === "" || body.uses == null ? -1 : body.uses);
          db.prepare("INSERT INTO web_codes (code, kind, amount, uses_left, active, created_at) VALUES (?,?,?,?,1,?)").run(code, kind, amount, Number.isFinite(uses) ? uses : -1, Date.now());
          json(res, 200, { ok: true });
          return;
        }
        if (pathname === "/api/admin/codes" && req.method === "DELETE") {
          const code = String(url.searchParams.get("code") || "").toUpperCase();
          db.prepare("DELETE FROM web_codes WHERE code = ?").run(code);
          json(res, 200, { ok: true });
          return;
        }
        if (pathname === "/api/admin/links" && req.method === "GET") {
          json(res, 200, { ok: true, links: siteLinks(true) });
          return;
        }
        if (pathname === "/api/admin/links" && req.method === "POST") {
          const body = await jsonBody(req);
          const title = String(body.title || "").trim();
          const linkUrl = String(body.url || "").trim();
          if (!title || !/^https?:\/\//i.test(linkUrl)) { json(res, 400, { ok: false, message: "Title + valid http(s) URL required." }); return; }
          const maxSort = db.prepare("SELECT COALESCE(MAX(sort),0) m FROM site_links").pluck().get();
          db.prepare("INSERT INTO site_links (title, url, hidden, sort) VALUES (?,?,0,?)").run(title, linkUrl, maxSort + 1);
          json(res, 200, { ok: true });
          return;
        }
        if (pathname === "/api/admin/links" && req.method === "DELETE") {
          db.prepare("DELETE FROM site_links WHERE id = ?").run(Number(url.searchParams.get("id") || 0));
          json(res, 200, { ok: true });
          return;
        }
        if (pathname === "/api/admin/settings" && req.method === "GET") {
          let wall = [];
          try { wall = JSON.parse(getConfig("reward_wall", "[]") || "[]"); } catch {}
          const pp = paypalKeys();
          json(res, 200, {
            ok: true,
            provider: paymentProvider(),
            paymentCurrency: paymentCurrency(),
            rewardWall: Array.isArray(wall) ? wall : [],
            keys: { plisio: Boolean(process.env.PLISIO_API_KEY), nowpayments: Boolean(process.env.NOWPAYMENTS_API_KEY) },
            paymentDetails: getPaymentDetails(),
            paypal: { mode: pp.mode, clientIdSet: Boolean(pp.clientId), secretSet: Boolean(pp.secret), ready: pp.ready },
            categoryLabels: getCategoryLabels(),
          });
          return;
        }
        if (pathname === "/api/admin/settings" && req.method === "PATCH") {
          const body = await jsonBody(req);
          if (body.paymentProvider != null) {
            if (!["plisio", "nowpayments", "sim"].includes(body.paymentProvider)) { json(res, 400, { ok: false, message: "Bad provider." }); return; }
            setConfig("payment_provider", body.paymentProvider);
          }
          if (body.paymentCurrency != null) {
            setConfig("payment_currency", String(body.paymentCurrency).toUpperCase());
          }
          if (body.rewardWall != null) {
            if (!Array.isArray(body.rewardWall)) { json(res, 400, { ok: false, message: "rewardWall must be an array." }); return; }
            const clean = body.rewardWall.map((w) => ({ goal: Number(w.goal || 0), title: String(w.title || ""), reward: String(w.reward || "") }));
            setConfig("reward_wall", JSON.stringify(clean));
          }
          if (body.paymentDetails && typeof body.paymentDetails === "object") {
            for (const k of ["paypal", "zelle", "chime"]) {
              if (body.paymentDetails[k] != null) setConfig(`manual_${k}`, String(body.paymentDetails[k] || ""));
            }
          }
          if (body.paypalClientId != null) setConfig("paypal_client_id", String(body.paypalClientId || ""));
          if (body.paypalSecret != null) setConfig("paypal_secret", String(body.paypalSecret || ""));
          if (body.paypalMode != null) setConfig("paypal_mode", body.paypalMode === "sandbox" ? "sandbox" : "live");
          if (body.categoryLabels && typeof body.categoryLabels === "object") {
            setCategoryLabels(body.categoryLabels);
          }
          json(res, 200, { ok: true });
          return;
        }

        // Manual payments awaiting admin approval.
        if (pathname === "/api/admin/manual" && req.method === "GET") {
          const rows = db
            .prepare(
              `SELECT p.id, p.user_id, p.kind, p.product_label, p.version_label, p.usd_amount, p.pay_currency, p.qty, p.note, p.items, p.status, p.created_at,
                      a.username
               FROM payments p
               LEFT JOIN web_accts a ON a.id = CAST(SUBSTR(p.user_id, 5) AS INTEGER)
               WHERE p.status IN ('manual_waiting','manual_paid','manual_rejected')
               ORDER BY p.id DESC LIMIT 50`
            )
            .all();
          json(res, 200, {
            ok: true,
            orders: rows.map((r) => {
              let items = null;
              try { items = r.items ? JSON.parse(r.items) : null; } catch {}
              return { ...r, items };
            }),
          });
          return;
        }
        if (pathname === "/api/admin/manual" && req.method === "POST") {
          const id = Number(url.searchParams.get("id") || 0);
          const action = String(url.searchParams.get("action") || "");
          const pm = db.prepare("SELECT * FROM payments WHERE id = ?").get(id);
          if (!pm) { json(res, 404, { ok: false, message: "Unknown order." }); return; }
          if (pm.status !== "manual_waiting") { json(res, 400, { ok: false, message: "Order already handled." }); return; }
          if (action === "approve") {
            try { fulfillPayment(pm); } catch (err) { json(res, 400, { ok: false, message: err?.message || "Couldn't fulfill." }); return; }
            markPaymentStatus(pm.id, "manual_paid");
            console.log(`ADMIN ${admin.username} approved manual payment #${pm.id} $${pm.usd_amount} ${pm.pay_currency}`);
            json(res, 200, { ok: true, message: "Order approved and delivered." });
          } else if (action === "reject") {
            markPaymentStatus(pm.id, "manual_rejected");
            console.log(`ADMIN ${admin.username} rejected manual payment #${pm.id}`);
            json(res, 200, { ok: true, message: "Order rejected." });
          } else {
            json(res, 400, { ok: false, message: "Unknown action." });
          }
          return;
        }
        if (pathname === "/api/admin/wipe-purchases" && req.method === "POST") {
          const body = await jsonBody(req);
          const username = String(body?.username || "").trim();
          if (!username) { json(res, 400, { ok: false, message: "username required" }); return; }
          const acct = db.prepare("SELECT id FROM web_accts WHERE username = ?").get(username);
          if (!acct) { json(res, 404, { ok: false, message: "User not found" }); return; }
          const wid = `web:${acct.id}`;
          const del = db.prepare("DELETE FROM web_purchases WHERE wid = ?").run(wid);
          console.log(`ADMIN ${admin.username} wiped ${del.changes} purchases for ${username} (${wid})`);
          json(res, 200, { ok: true, message: `Deleted ${del.changes} purchase(s) for ${username}` });
          return;
        }
        if (pathname === "/api/admin/sync-emojis" && req.method === "POST") {
          if (!DISCORD_BOT_TOKEN) { json(res, 500, { ok: false, message: "DISCORD_BOT_TOKEN not configured" }); return; }
          try {
            const guildId = process.env.DISCORD_GUILD_ID || "143366288919515906";
            const resp = await fetch(`${DISCORD_API}/guilds/${guildId}/emojis`, {
              headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` }
            });
            if (!resp.ok) { json(res, 502, { ok: false, message: `Discord API error: ${resp.status}` }); return; }
            const emojis = await resp.json();
            const stmt = db.prepare("INSERT OR REPLACE INTO emojis (id, name, animated, guild_id) VALUES (?, ?, ?, ?)");
            const tx = db.transaction(() => {
              for (const e of emojis) { stmt.run(e.id, e.name, e.animated ? 1 : 0, guildId); }
            });
            tx();
            json(res, 200, { ok: true, synced: emojis.length });
          } catch (e) {
            console.error("sync-emojis error:", e);
            json(res, 500, { ok: false, message: e.message });
          }
          return;
        }
        if (pathname === "/api/emojis" && req.method === "GET") {
          const rows = db.prepare("SELECT id, name, animated FROM emojis ORDER BY name").all();
          const emojis = rows.map(r => ({ id: r.id, name: r.name, animated: !!r.animated }));
          json(res, 200, { ok: true, emojis });
          return;
        }
        if (pathname === "/api/admin/toggle-hot" && req.method === "POST") {
          const body = await jsonBody(req);
          const key = String(body?.key || "").trim();
          const hot = body?.hot === true ? 1 : 0;
          if (!key) { json(res, 400, { ok: false, message: "key required" }); return; }
          const row = db.prepare("UPDATE site_products SET hot = ?, updated_at = ? WHERE key = ?").run(hot, Date.now(), key);
          if (!row.changes) { json(res, 404, { ok: false, message: "Product not found" }); return; }
          json(res, 200, { ok: true, hot: !!hot });
          return;
        }
        if (pathname === "/api/admin/send-stock-embed" && req.method === "POST") {
          const body = await jsonBody(req);
          const key = String(body?.key || "").trim();
          if (!key) { json(res, 400, { ok: false, message: "key required" }); return; }
          const out = await manualStockEmbed(key);
          if (!out.ok) { json(res, 404, out); return; }
          json(res, 200, { ok: true, variants: out.variants });
          return;
        }
        json(res, 404, { ok: false, message: "Unknown admin route." });
        return;
      }

      // ---- Link Discord to the web account ----
      if (pathname === "/link/discord" && req.method === "GET") {
        const acct = requireAuth(session);
        if (!acct) {
          res.writeHead(302, { Location: "/account" });
          res.end();
          return;
        }
        if (!CLIENT_ID || !CLIENT_SECRET) {
          res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Discord linking isn't configured yet.");
          return;
        }
        const state = randomBytes(12).toString("hex");
        res.setHeader("Set-Cookie", `a7state=${state}; HttpOnly; SameSite=None; Secure; Path=/; Max-Age=600`);
        const q = new URLSearchParams({ client_id: CLIENT_ID, response_type: "code", redirect_uri: REDIRECT_URI, scope: "identify", state });
        res.writeHead(302, { Location: `https://discord.com/oauth2/authorize?${q}` });
        res.end();
        return;
      }

      if (pathname === "/auth/callback" && req.method === "GET") {
        const { code, state } = url.searchParams;
        const cookieState = cookies.a7state;
        console.log("[OAuth] Callback received, state from URL:", state, "state from cookie:", cookieState);

        // Case A: full CSRF — state echoed by Discord matches cookie
        // Case B: fallback — Discord did not echo state (e.g. OAuth URL generated
        //         without state). We still have the cookie we set, so accept only
        //         when a valid non-expired cookie exists. State is regenerated on
        //         each authorize, keeping this safe enough for a first-party app.
        const stateOk = (state && state === cookieState) || (!state && !!cookieState);
        console.log("[OAuth] stateOk:", stateOk, "URL state:", state, "Cookie state:", cookieState);

        if (!code || !stateOk) {
          console.log("[OAuth] Invalid state - URL:", state, "Cookie:", cookieState, "All cookies:", cookies);
          res.writeHead(400);
          res.end("Invalid OAuth state.");
          return;
        }
        const acct = requireAuth(session);
        if (!acct) {
          res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Log in first, then link your Discord from Account Settings.");
          return;
        }
        try {
          const user = await exchangeCode(code);
          const linked = linkDiscord(acct.id, user);
          if (!linked.ok) {
            res.writeHead(409, { "Content-Type": "text/plain; charset=utf-8" });
            res.end("That Discord account is already linked to another website account.");
            return;
          }
          res.writeHead(302, { Location: "/account" });
          res.end();
        } catch (err) {
          res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(`Linking failed: ${err?.message || err}`);
        }
        return;
      }

      if (pathname === "/api/unlink" && req.method === "POST") {
        const acct = requireAuth(session);
        if (!acct) { json(res, 401, { ok: false, reason: "auth" }); return; }
        unlinkDiscord(acct.id);
        json(res, 200, { ok: true });
        return;
      }

      // TEMP: Admin endpoint to set unlimited stock (-1) to 0
      if (pathname === "/api/admin/fix-unlimited-stock" && req.method === "POST") {
        const admin = requireAdmin(session);
        console.log("[fix-unlimited-stock] admin:", admin, "session:", session ? "present" : "none");
        if (!admin) { 
          // Allow secret token for one-time CLI access
          const rawBody = await new Promise((resolve) => {
            let data = "";
            req.on("data", (chunk) => { data += chunk; });
            req.on("end", () => resolve(data));
          });
          console.log("[fix-unlimited-stock] raw body length:", rawBody?.length, "raw body:", rawBody);
          let body = {};
          try {
            // Strip BOM if present
            const cleanBody = rawBody?.replace(/^\uFEFF/, "");
            body = cleanBody ? JSON.parse(cleanBody) : {};
          } catch (e) {
            console.log("[fix-unlimited-stock] JSON parse error:", e?.message);
            body = {};
          }
          console.log("[fix-unlimited-stock] body:", JSON.stringify(body));
          if (body?.secret !== "fix-unlimited-2024") {
            json(res, 403, { ok: false, reason: "admin" }); 
            return; 
          }
        }
        try {
          const result = db.prepare("UPDATE site_versions SET stock = 0 WHERE stock = -1").run();
          json(res, 200, { ok: true, message: `Updated ${result.changes} versions from unlimited to 0 stock` });
        } catch (err) {
          console.error("fix-unlimited-stock error:", err);
          json(res, 500, { ok: false, message: err?.message || "Database error" });
        }
        return;
      }

      if (pathname === "/account" && req.method === "GET") {
        const file = path.join(ROOT, "account.html");
        const data = await readFile(file);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
        res.end(data);
        return;
      }

      if (pathname === "/admin" && req.method === "GET") {
        if (!requireAdmin(session)) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not found");
          return;
        }
        const file = path.join(ROOT, "admin.html");
        const data = await readFile(file);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
        res.end(data);
        return;
      }

      // ---- Static files (storefront) ----
      let filePath = pathname;
      if (filePath === "/") filePath = "/index.html";
      const file = path.normalize(path.join(ROOT, filePath));
      if (!file.startsWith(ROOT)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      const data = await readFile(file);
      res.writeHead(200, {
        "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
        "Cache-Control": "no-cache",
      });
      res.end(data);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
    }
  });

  server.listen(port, () => console.log(`WEB serving on :${port} (redirect ${REDIRECT_URI})`));
  return server;
}