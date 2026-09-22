import { EmbedBuilder } from "discord.js";

export const AUTO_DELETE_MS = 2 * 60 * 1000;

// One active countdown/delete chain per message id, so rapid button clicks on
// the same message extend the deadline instead of stacking rival timers.
const chains = new Map();

function format(secs) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Writes the live countdown into the footer of every embed on the message,
// preserving any footer text the embed already had.
async function putCountdown(message, secs) {
  const embeds = (message.embeds ?? []).map((e) => {
    const old = e.footer?.text ?? "";
    const text = old ? `${old} · ⏳ Deletes in ${format(secs)}` : `⏳ Deletes in ${format(secs)}`;
    return EmbedBuilder.from(e).setFooter({ text, iconURL: e.footer?.iconURL });
  });
  if (!embeds.length) return;
  await message.edit({ content: message.content ?? "", embeds });
}

async function tick(key, message, chain) {
  const secs = Math.ceil(chain.remainingMs / 1000);
  if (secs <= 0) return;
  try {
    await putCountdown(message, secs);
  } catch {
    // Message no longer exists or got rate-limited — the delete timer still
    // fires at the deadline.
  }
  chain.remainingMs -= 1000;
  if (chain.remainingMs > 0) {
    chain.timer = setTimeout(() => tick(key, message, chain), 1000);
  }
}

// Countdown + deletion for a delivered message. Deleting goes through the
// caller's deleteFn: interaction.deleteReply() for reply/ephemeral messages,
// message.delete() for regular bot-sent messages.
function schedule(message, deleteFn) {
  const key = message.id;
  let chain = chains.get(key);
  if (!chain) {
    chain = { remainingMs: AUTO_DELETE_MS, timer: null, deleteTimer: null };
    chains.set(key, chain);
  } else {
    // The user interacted with the same message again — restart the deadline
    // at the full 2 minutes and cancel the previous timers.
    if (chain.timer) clearTimeout(chain.timer);
    if (chain.deleteTimer) clearTimeout(chain.deleteTimer);
    chain.remainingMs = AUTO_DELETE_MS;
  }

  chain.deleteTimer = setTimeout(async () => {
    chains.delete(key);
    if (chain.timer) clearTimeout(chain.timer);
    try {
      await deleteFn();
    } catch {
      // already deleted
    }
  }, AUTO_DELETE_MS);

  tick(key, message, chain);
}

export function scheduleReplyDeletion(interaction) {
  // Some flows (e.g. crypto checkout) intentionally keep the original embed
  // alive beyond the 2-min auto-delete so they can refresh it with the
  // completed transaction later. opt out via interaction.noAutoDelete = true.
  if (interaction.noAutoDelete === true) return;
  interaction
    .fetchReply()
    .then((message) => schedule(message, () => interaction.deleteReply()))
    .catch(() => {
      // Rewarded via showModal or already gone — nothing to schedule.
    });
}

export function scheduleMessageDeletion(message) {
  if (!message?.id) return;
  schedule(message, () => message.delete());
}