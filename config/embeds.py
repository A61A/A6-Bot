"""A6 design layer.

Every embed in the bot starts from `branded_embed`, so the banner strip, the
brand heading, the accent color and the shop footer stay uniform everywhere.

Panel anatomy (mirrors the theme.js V2 panel, adapted to classic embeds):

    [banner.png attachment]      thin wide image, Discord renders it on top
    A6 ・ Title                   embed title -> brand prefix, bold + large
    description                   optional line under the heading
    fields                        bold name + value, inline where it suits
    ───────────────────────       separator
    Shop                          full-width block of links at the bottom
    [hero.gif image]              big animated gif, bottom of the embed
    [buttons]

Discord's `-#` small-text markdown only exists in Components V2, so the
subtle-by-default look is approximated with italics here.

Button colors = meaning, kept consistent everywhere:
  primary   navigation / main action on a screen
  success   money moving only (adding funds, completing a purchase)
  secondary a valid but non-default path
  danger     irreversible actions
"""

from __future__ import annotations

import os
import re

import discord

HERE = os.path.dirname(os.path.abspath(__file__))

# --- Palette (matches the mockup's :root tokens 1:1) ---
VIOLET = 0x8B5CF6
BLUE = 0x5B6EF5
SUCCESS = 0x3BA776
NEUTRAL = 0x2A2D3D

# Friendly names accepted wherever a colour is typed in (the /admin edit
# form, the seeded product colors). Hex works too: #RRGGBB / 0xRRGGBB.
COLOR_NAMES: dict[str, int] = {
    "red": 0xE50914,
    "pink": 0xFF69B4,
    "black": 0x000000,
    "blue": 0x5865F2,
    "green": 0x1DB954,
    "white": 0xFFFFFF,
    "violet": VIOLET,
    "purple": 0x8B5CF6,
    "orange": 0xF59E0B,
    "yellow": 0xFACC15,
    "cyan": 0x22D3EE,
    "gray": 0x80848E,
    "grey": 0x80848E,
    "default": VIOLET,
}


def parse_color(raw: str) -> int | None:
    """Turn a typed colour into an RGB int. Blank -> None (means "use default").

    Accepts a name ("red"), #RRGGBB, RRGGBB or 0xRRGGBB. Raises ValueError
    with a human message when it's neither, so the caller can surface it.
    """
    s = (raw or "").strip()
    if not s:
        return None
    if s.lower() in COLOR_NAMES:
        return COLOR_NAMES[s.lower()]
    s = s.lstrip("#")
    if s[:2].lower() == "0x":
        s = s[2:]
    if re.fullmatch(r"[0-9a-fA-F]{6}", s):
        return int(s, 16)
    raise ValueError(
        "Color must be a name (red, pink, black, blue, green, white, violet…) "
        "or hex like `#E50914`."
    )

BRAND_NAME = "A6 - Custom Bot? DM Me!"
BRAND_SHORT = os.getenv("BRAND_SHORT", "A6")

BANNER_FILENAME = "banner.gif"
BANNER_PATH = os.path.join(HERE, "..", "assets", "banner.gif")

HERO_FILENAME = "hero.gif"
HERO_PATH = os.path.join(HERE, "..", "assets", "hero.gif")

# Thin rule used to separate the body from the shop block.
RULE = "▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬"

# Shop links shown in the bottom block. Empty values are dropped, so you can
# fill in only what you have without leaving dead links on screen.
SHOP_LINKS = {
    "Store": os.getenv("SHOP_URL", ""),
    "Pricing": os.getenv("SHOP_PRICING_URL", ""),
    "Dashboard": os.getenv("SHOP_DASHBOARD_URL", ""),
    "Support": os.getenv("SHOP_SUPPORT_URL", ""),
}


def banner_file() -> discord.File:
    """Fresh attachment handle - discord.File objects are single-use per message."""
    return discord.File(BANNER_PATH, filename=BANNER_FILENAME)


def hero_file() -> discord.File:
    """Fresh handle for the big animated gif - single-use per message, like banner."""
    return discord.File(HERO_PATH, filename=HERO_FILENAME)


def embed_files() -> list[discord.File]:
    """Every file a branded embed needs.

    Use this as `files=` on every fresh send of a branded embed. The embed
    references both attachments, so skipping one leaves a broken image box.
    Message edits inherit the original attachments and don't need this, with
    one exception: anything that passes `attachments=[]` wipes them and must
    pass `attachments=embed_files()` instead.
    """
    return [banner_file(), hero_file()]


def shop_block() -> tuple[str, str, bool] | None:
    """The bottom 'more about the shop' field, or None when nothing is configured.

    The rule rides along as the first line of the value rather than as its own
    field: Discord rejects an embed field with an empty value, so a standalone
    divider field would 400 and take the whole message down with it.
    """
    links = [f"[{name}]({url})" for name, url in SHOP_LINKS.items() if url]
    if not links:
        return None
    note = os.getenv("SHOP_FOOTER_NOTE", "").strip()
    body = "  ·  ".join(links)
    if note:
        body = f"{note}\n{body}"
    return ("Shop", f"{RULE}\n{body}", False)


def _heading(title: str) -> str:
    return f"{BRAND_SHORT} ・ {title}"


def branded_embed(
    title: str | None = None,
    description: str | None = None,
    fields: list[tuple[str, str, bool]] | None = None,
    color: int = VIOLET,
    subtitle: str | None = None,
    shop: bool = True,
    hero: bool = True,
) -> discord.Embed:
    """Build a themed embed: banner strip on top, brand heading, gif, shop block.

    Set `subtitle` for a quiet italic line under the heading, `shop=False`
    to drop the bottom link block (e.g. on the welcome embed, which already
    points people at /hub), and `hero=False` to drop the gif.

    When `hero` is on, the send MUST include `files=embed_files()` (fresh
    sends) or keep the original attachments (edits) - otherwise the image
    box breaks.
    """
    embed = discord.Embed(color=color)
    if title:
        embed.title = _heading(title)

    body = description or ""
    if subtitle:
        body = f"{body}\n*{subtitle}*" if body else f"*{subtitle}*"
    if body:
        embed.description = body

    if fields:
        for name, value, inline in fields:
            embed.add_field(name=name, value=value, inline=inline)

    block = shop_block() if shop else None
    if block:
        embed.add_field(name=block[0], value=block[1], inline=False)

    if hero:
        embed.set_image(url=f"attachment://{HERO_FILENAME}")

    return embed
