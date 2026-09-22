import db from "./db.js";

export function getCredits(userId) {
  const row = db.prepare("SELECT credits FROM users WHERE id = ?").get(userId);
  return row ? row.credits : 0;
}

export function setCredits(userId, amount, ref = null) {
  db.prepare(
    "INSERT INTO users (id, credits) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET credits = excluded.credits"
  ).run(userId, amount);
  logTx(userId, amount, "set", ref);
  return amount;
}

export function addCredits(userId, amount, ref = null) {
  const next = getCredits(userId) + amount;
  setCredits(userId, next, ref);
  return next;
}

export function spendCredits(userId, amount, ref = null) {
  const current = getCredits(userId);
  if (current < amount) return null;
  const next = current - amount;
  setCredits(userId, next, ref);
  return next;
}

function logTx(userId, amount, type, ref) {
  db.prepare(
    "INSERT INTO transactions (user_id, amount, type, ref, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(userId, amount, type, ref, Date.now());
}

export function redeemCode(userId, code) {
  const row = db.prepare("SELECT * FROM redeem_codes WHERE code = ?").get(code);
  if (!row) return { ok: false, reason: "invalid" };
  if (row.uses_left <= 0) return { ok: false, reason: "used" };

  const already = db
    .prepare("SELECT id FROM redemptions WHERE code = ? AND user_id = ?")
    .get(code, userId);
  if (already) return { ok: false, reason: "already" };

  db.prepare("UPDATE redeem_codes SET uses_left = uses_left - 1 WHERE code = ?").run(code);
  db.prepare(
    "INSERT INTO redemptions (code, user_id, credits, redeemed_at) VALUES (?, ?, ?, ?)"
  ).run(code, userId, row.credits, Date.now());

  const balance = addCredits(userId, row.credits, `redeem:${code}`);
  return { ok: true, credits: row.credits, balance };
}

export function createCode(code, credits, uses, createdBy) {
  db.prepare(
    "INSERT INTO redeem_codes (code, credits, uses_left, created_by, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(code, credits, uses, createdBy, Date.now());
}

export function codeExists(code) {
  return !!db.prepare("SELECT 1 FROM redeem_codes WHERE code = ?").get(code);
}

export function getBalanceUser(userId) {
  return db
    .prepare(
      "SELECT id, credits FROM users WHERE id = ?"
    )
    .get(userId);
}

export function hasPurchased(userId, productKey) {
  return !!db
    .prepare("SELECT id FROM purchases WHERE user_id = ? AND product_key = ?")
    .get(userId, productKey);
}

export function addPurchase(userId, productKey, versionValue, price) {
  db.prepare(
    "INSERT INTO purchases (user_id, product_key, version_value, price, purchased_at) VALUES (?, ?, ?, ?, ?)"
  ).run(userId, productKey, versionValue, price, Date.now());
  return true;
}