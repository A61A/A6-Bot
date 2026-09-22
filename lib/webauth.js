import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import db from "../db.js";

// ---- Web accounts + wallet (independent of Discord) ------------------------
export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const want = Buffer.from(hash, "hex");
  const got = scryptSync(password, salt, 64);
  return want.length === got.length && timingSafeEqual(want, got);
}

const USERNAME_RE = /^[a-zA-Z0-9_]{3,32}$/;

export function validateCredentials(username, password) {
  if (!USERNAME_RE.test(String(username || ""))) return "Username must be 3–32 characters (letters, numbers, _).";
  if (typeof password !== "string" || password.length < 6) return "Password must be at least 6 characters.";
  return null;
}

export function createWebAccount(username, password) {
  db.prepare(
    "INSERT INTO web_accts (username, pass_hash, credits, created_at) VALUES (?, ?, 0, ?)"
  ).run(username, hashPassword(password), Date.now());
  return db.prepare("SELECT * FROM web_accts WHERE username = ?").get(username);
}

export function findWebByUsername(username) {
  return db.prepare("SELECT * FROM web_accts WHERE username = ?").get(username);
}

export function getWebById(id) {
  return db.prepare("SELECT * FROM web_accts WHERE id = ?").get(id);
}

export function getWebByDiscord(discordId) {
  return db.prepare("SELECT * FROM web_accts WHERE discord_id = ?").get(discordId);
}

// ---- Wallet: a real dollar balance on the web account ----------------------
export function walletFor(acct) {
  return acct.balance;
}

export function addBalance(wid, amount) {
  db.prepare("UPDATE web_accts SET balance = balance + ? WHERE id = ?").run(amount, wid);
  db.prepare("INSERT INTO transactions (user_id, amount, type, ref, created_at) VALUES (?, ?, 'credit', ?, ?)")
    .run(`web:${wid}`, amount, "web:deposit", Date.now());
  return db.prepare("SELECT balance FROM web_accts WHERE id = ?").pluck().get(wid);
}

export function spendBalance(wid, amount) {
  const acct = getWebById(wid);
  if (!acct || acct.balance < amount) return null;
  const next = acct.balance - amount;
  db.prepare("UPDATE web_accts SET balance = ? WHERE id = ?").run(next, wid);
  db.prepare("INSERT INTO transactions (user_id, amount, type, ref, created_at) VALUES (?, ?, 'spend', ?, ?)")
    .run(`web:${wid}`, -amount, "web:buy", Date.now());
  return next;
}

// ---- Discord link ----------------------------------------------------------
export function linkDiscord(wid, { id, username, avatar }) {
  const taken = getWebByDiscord(String(id));
  if (taken && taken.id !== wid) return { ok: false, reason: "taken" };
  db.prepare("UPDATE web_accts SET discord_id = ?, discord_name = ?, discord_avatar = ? WHERE id = ?")
    .run(String(id), username, avatar || null, wid);
  return { ok: true };
}

export function unlinkDiscord(wid) {
  db.prepare("UPDATE web_accts SET discord_id = NULL, discord_name = NULL, discord_avatar = NULL WHERE id = ?").run(wid);
}

export function avatarUrl(acct) {
  if (!acct.discord_avatar) {
    const index = Number(BigInt(acct.discord_id) % 6n);
    return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
  }
  return `https://cdn.discordapp.com/avatars/${acct.discord_id}/${acct.discord_avatar}.png`;
}

export { linkDiscord as linkDiscordAccount };

// Site purchases are tracked independently of Discord.
export function spendFor(acct, amount, _ref = "web:buy") {
  return spendBalance(acct.id, amount);
}
export function hasWebPurchase(wid, productKey) {
  return !!db.prepare("SELECT 1 FROM web_purchases WHERE wid = ? AND product_key = ? LIMIT 1").get(wid, productKey);
}
export function addWebPurchase(wid, productKey, versionValue, price, productLabel, versionLabel, qty = 1) {
  db.prepare(
    "INSERT INTO web_purchases (wid, product_key, version_value, price, qty, product_label, version_label, purchased_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(wid, productKey, versionValue, price, Math.max(1, parseInt(qty, 10) || 1), productLabel, versionLabel, Date.now());
}
export function webPurchasesFor(wid) {
  return db.prepare("SELECT product_key, version_value, product_label, version_label, price, qty, purchased_at FROM web_purchases WHERE wid = ? ORDER BY id DESC").all(wid);
}