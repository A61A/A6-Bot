import { AttachmentBuilder, EmbedBuilder } from "discord.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Theme palette (A7 kit) ---
export const VIOLET = 0x0b048f;
export const BLUE = 0x5b6ef5;
export const SUCCESS = 0x3ba776;
export const NEUTRAL = 0x2a2d3d;

const BRAND_NAME = "A7";
const BANNER_FILENAME = "banner.png";
const BANNER_PATH = path.join(__dirname, "..", "assets", "banner.png");

// Fresh AttachmentBuilder per send — Discord File/Attachment instances are
// single-use per message, so each caller gets its own handle.
export function bannerFile() {
  return new AttachmentBuilder(BANNER_PATH, { name: BANNER_FILENAME });
}

// Every themed screen starts here: the tinted left border, the violet/blue
// banner strip (an attached image — Discord can't paint an embed background),
// an optional "eyebrow" author line, and the brand footer.
// Pass `image` when a screen needs the image slot for something else (e.g. the
// crypto checkout QR), or `noBanner` to skip the strip entirely.
export function brandedEmbed({ title, description, fields, color = VIOLET, image, eyebrow, noBanner = false }) {
  const embed = new EmbedBuilder().setColor(color);
  if (eyebrow) embed.setAuthor({ name: eyebrow });
  if (title) embed.setTitle(title);
  if (description) embed.setDescription(description);
  if (fields?.length) embed.addFields(fields);
  embed.setFooter({ text: `${BRAND_NAME} · updated live` });
  if (image) {
    embed.setImage(image);
  } else if (!noBanner) {
    embed.setImage(`attachment://${BANNER_FILENAME}`);
  }
  return embed;
}