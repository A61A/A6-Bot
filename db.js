import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

// Folder is configurable so it can point at the Railway volume (/app/data).
// Defaults to <cwd>/data so local dev keeps working.
const DB_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
fs.mkdirSync(DB_DIR, { recursive: true });

console.log(`[db] cwd=${process.cwd()} dir=${DB_DIR} file=${path.join(DB_DIR, "bot.db")}`);

const db = new Database(path.join(DB_DIR, "bot.db"));
// WAL frames don't reliably checkpoint into the main file on Windows/network
// volumes (writes vanished between processes during local dev). Use the plain
// rollback journal locally; production runs on Linux where WAL is fine.
db.pragma(process.platform === "win32" ? "journal_mode = DELETE" : "journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    credits INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS redeem_codes (
    code TEXT PRIMARY KEY,
    credits INTEGER NOT NULL,
    uses_left INTEGER NOT NULL DEFAULT 1,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS redemptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL,
    user_id TEXT NOT NULL,
    credits INTEGER NOT NULL,
    redeemed_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    type TEXT NOT NULL,
    ref TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    product_key TEXT NOT NULL,
    version_value TEXT NOT NULL,
    price INTEGER NOT NULL,
    purchased_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    channel_id TEXT,
    admin_channel_id TEXT,
    user_dm_channel_id TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    created_at INTEGER NOT NULL,
    last_message INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    product_key TEXT,
    version_value TEXT,
    product_label TEXT,
    version_label TEXT,
    credits INTEGER NOT NULL,
    usd_amount REAL NOT NULL,
    pay_currency TEXT NOT NULL,
    pay_amount REAL,
    pay_address TEXT,
    provider_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    message_channel_id TEXT,
    message_id TEXT,
    origin_channel_id TEXT,
    origin_message_id TEXT,
    origin_token TEXT,
    origin_webhook_id TEXT,
    checkout_url TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS web_accts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    pass_hash TEXT NOT NULL,
    credits INTEGER NOT NULL DEFAULT 0,
    balance REAL NOT NULL DEFAULT 0,
    discord_id TEXT UNIQUE,
    discord_name TEXT,
    discord_avatar TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS web_purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wid INTEGER NOT NULL,
    product_key TEXT NOT NULL,
    version_value TEXT NOT NULL,
    price REAL NOT NULL,
    qty INTEGER NOT NULL DEFAULT 1,
    product_label TEXT,
    version_label TEXT,
    purchased_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS site_analytics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    page_views INTEGER NOT NULL DEFAULT 0,
    unique_visitors INTEGER NOT NULL DEFAULT 0,
    total_sales_usd REAL NOT NULL DEFAULT 0,
    total_orders INTEGER NOT NULL DEFAULT 0,
    products_sold INTEGER NOT NULL DEFAULT 0,
    unique_customers INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(date)
  );

  CREATE TABLE IF NOT EXISTS page_visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL,
    referrer TEXT,
    user_agent TEXT,
    ip_hash TEXT,
    session_id TEXT,
    visited_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_page_visits_date ON page_visits (visited_at);
  CREATE INDEX IF NOT EXISTS idx_page_visits_path ON page_visits (path);
  CREATE INDEX IF NOT EXISTS idx_page_visits_session ON page_visits (session_id);

  CREATE TABLE IF NOT EXISTS delivery_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_key TEXT NOT NULL,
    version_value TEXT NOT NULL,
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'in_stock',
    order_ref TEXT,
    wid TEXT,
    sold_at INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_dei_pool ON delivery_items (product_key, version_value, status);
  CREATE INDEX IF NOT EXISTS idx_dei_wid ON delivery_items (wid, status);

  CREATE TABLE IF NOT EXISTS site_products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    desc TEXT,
    image TEXT,
    coming_soon INTEGER NOT NULL DEFAULT 0,
    once INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0,
    on_hold INTEGER NOT NULL DEFAULT 0,
    hot INTEGER NOT NULL DEFAULT 0,
    goal_usd REAL NOT NULL DEFAULT 0,
    sort INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS site_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_key TEXT NOT NULL,
    value TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    price REAL NOT NULL,
    orig_price REAL NOT NULL DEFAULT 0,
    cost REAL NOT NULL DEFAULT 0,
    stock INTEGER NOT NULL DEFAULT -1,
    min_qty INTEGER NOT NULL DEFAULT 1,
    max_qty INTEGER NOT NULL DEFAULT 0,
    sold INTEGER NOT NULL DEFAULT 0,
    sort INTEGER NOT NULL DEFAULT 0,
    visible INTEGER NOT NULL DEFAULT 1,
    details TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS web_codes (
    code TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    amount REAL NOT NULL,
    uses_left INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS web_code_uses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL,
    used_by TEXT NOT NULL,
    used_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS site_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    hidden INTEGER NOT NULL DEFAULT 0,
    sort INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS site_config (
    k TEXT PRIMARY KEY,
    v TEXT
  );

  CREATE TABLE IF NOT EXISTS emojis (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    animated INTEGER NOT NULL DEFAULT 0,
    guild_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );
`);

// Migration: web accounts kept a placeholder "credits" count in the very first
// web build; the site now uses a real dollar balance. Existing values carry over.
const webCols = db.prepare("PRAGMA table_info(web_accts)").all().map((c) => c.name);
if (!webCols.includes("balance")) {
  db.exec("ALTER TABLE web_accts ADD COLUMN balance REAL NOT NULL DEFAULT 0");
}
try {
  if (webCols.includes("credits")) {
    db.exec("UPDATE web_accts SET balance = credits WHERE credits > 0");
  }
} catch {
  // fresh table — nothing to migrate
}

// Migration: human_taken marks tickets where an admin has taken over so the
// AI stops responding. Added after the initial schema for existing databases.
const ticketCols = db.prepare("PRAGMA table_info(tickets)").all().map((c) => c.name);
if (!ticketCols.includes("human_taken")) {
  db.exec("ALTER TABLE tickets ADD COLUMN human_taken INTEGER NOT NULL DEFAULT 0");
}

// Migration for crypto checkouts added mid-life.
try {
  const paymentCols = db.prepare("PRAGMA table_info(payments)").all().map((c) => c.name);
  if (!paymentCols.includes("origin_webhook_id")) {
    db.exec("ALTER TABLE payments ADD COLUMN origin_webhook_id TEXT");
  }
  if (!paymentCols.includes("checkout_url")) {
    db.exec("ALTER TABLE payments ADD COLUMN checkout_url TEXT");
  }
  if (!paymentCols.includes("expires_at")) {
    db.exec("ALTER TABLE payments ADD COLUMN expires_at INTEGER");
  }
} catch {
  // payments table may not exist yet in brand-new DBs — the CREATE TABLE in
  // the schema block above already includes the column.
}

// Migration: seed purchases from existing buy transactions so double-buyers
// are correctly blocked going forward.
const existingBuys = db
  .prepare("SELECT DISTINCT user_id, ref FROM transactions WHERE ref LIKE 'buy:%'")
  .all();
const insertPurchase = db.prepare(
  "INSERT OR IGNORE INTO purchases (user_id, product_key, version_value, price, purchased_at) VALUES (?, ?, ?, 0, 0)"
);
for (const { user_id, ref } of existingBuys) {
  const [productKey, ...rest] = ref.replace("buy:", "").split(":");
  insertPurchase.run(user_id, productKey, rest.join(":") || productKey);
}

// Migration: SellAuth-style product options - on-hold visibility on products
// and per-variant compare-at price, unit cost and min/max quantity. Added for
// databases created before these fields existed.
try {
  const prodCols = db.prepare("PRAGMA table_info(site_products)").all().map((c) => c.name);
  if (!prodCols.includes("on_hold")) db.exec("ALTER TABLE site_products ADD COLUMN on_hold INTEGER NOT NULL DEFAULT 0");
  if (!prodCols.includes("hot")) db.exec("ALTER TABLE site_products ADD COLUMN hot INTEGER NOT NULL DEFAULT 0");
} catch {
  // table may not exist yet on the very first run
}
try {
  const verCols = db.prepare("PRAGMA table_info(site_versions)").all().map((c) => c.name);
  if (!verCols.includes("orig_price")) db.exec("ALTER TABLE site_versions ADD COLUMN orig_price REAL NOT NULL DEFAULT 0");
  if (!verCols.includes("cost")) db.exec("ALTER TABLE site_versions ADD COLUMN cost REAL NOT NULL DEFAULT 0");
  if (!verCols.includes("min_qty")) db.exec("ALTER TABLE site_versions ADD COLUMN min_qty INTEGER NOT NULL DEFAULT 1");
  if (!verCols.includes("max_qty")) db.exec("ALTER TABLE site_versions ADD COLUMN max_qty INTEGER NOT NULL DEFAULT 0");
} catch {}
try {
  const payCols = db.prepare("PRAGMA table_info(payments)").all().map((c) => c.name);
  if (!payCols.includes("qty")) db.exec("ALTER TABLE payments ADD COLUMN qty INTEGER NOT NULL DEFAULT 1");
} catch {}
try {
  const wpCols = db.prepare("PRAGMA table_info(web_purchases)").all().map((c) => c.name);
  if (!wpCols.includes("qty")) db.exec("ALTER TABLE web_purchases ADD COLUMN qty INTEGER NOT NULL DEFAULT 1");
} catch {}

// Migration: manual payment methods (PayPal/Zelle/Chime) let the buyer attach
// a reference note (e.g. their PayPal transaction id). Added for databases
// created before the checkout screen existed.
try {
  const noteCols = db.prepare("PRAGMA table_info(payments)").all().map((c) => c.name);
  if (!noteCols.includes("note")) db.exec("ALTER TABLE payments ADD COLUMN note TEXT");
} catch {}

// Migration: add items column for cart support
try {
  const payCols = db.prepare("PRAGMA table_info(payments)").all().map((c) => c.name);
  if (!payCols.includes("items")) db.exec("ALTER TABLE payments ADD COLUMN items TEXT");
} catch {}

// Migration: enforce the composite unique (product_key, value) on site_versions.
// This ONLY rebuilds when the live unique constraint is the legacy global
// UNIQUE(value) form. It never touches a correctly-composited table, and the
// rebuild is one transactional block with column-named inserts so a failure
// cannot lose data.
try {
  const dbIdx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='site_versions'").all();
  let composite = false;
  for (const i of dbIdx) {
    try {
      const cols = db.prepare(`PRAGMA index_xinfo(${JSON.stringify(i.name)})`).all().map((c) => c.name);
      if (cols.includes("product_key") && cols.includes("value")) composite = true;
    } catch {}
  }
  if (!composite && dbIdx.length) {
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
        visible INTEGER NOT NULL DEFAULT 1,
        details TEXT NOT NULL DEFAULT '',
        UNIQUE(product_key, value)
      );
      INSERT INTO site_versions_new (id, product_key, value, label, price, orig_price, cost, stock, min_qty, max_qty, sold, sort, visible, details)
        SELECT id, product_key, value, label, price, orig_price, cost, stock, min_qty, max_qty, sold, sort, visible, details FROM site_versions;
      DROP TABLE site_versions;
      ALTER TABLE site_versions_new RENAME TO site_versions;
      COMMIT;
    `);
  }
} catch {}

// Migration: per-variant visibility toggle (visible=0 hides it from the store).
try {
  const verCols = db.prepare("PRAGMA table_info(site_versions)").all().map((c) => c.name);
  if (!verCols.includes("visible")) db.exec("ALTER TABLE site_versions ADD COLUMN visible INTEGER NOT NULL DEFAULT 1");
} catch {}

// Migration: per-variant hover details shown as a popup on the store.
try {
  const verCols = db.prepare("PRAGMA table_info(site_versions)").all().map((c) => c.name);
  if (!verCols.includes("details")) db.exec("ALTER TABLE site_versions ADD COLUMN details TEXT NOT NULL DEFAULT ''");
} catch {}

console.log(`[db] users=${db.prepare("SELECT COUNT(*) c FROM users").pluck().get()} credits=${db.prepare("SELECT COALESCE(SUM(credits),0) s FROM users").pluck().get()}`);

export default db;