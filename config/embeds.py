"""A6 design layer.

Every embed in the bot starts from `branded_embed`, so the eyebrow, banner,
border color, and footer stay uniform everywhere. Discord can only tint an
embed's left border via `color=`; the violet/blue banner strip is a real
image attached to the message and referenced as `attachment://banner.png`.

Button colors = meaning, kept consistent everywhere:
  primary   navigation / main action on a screen
  success   money moving only (adding funds, completing a purchase)
  secondary a valid but non-default path
  danger     irreversible actions
"""

from __future__ import annotations

import os

import discord

HERE = os.path.dirname(os.path.abspath(__file__))

# --- Palette (matches the mockup's :root tokens 1:1) ---
VIOLET = 0x8B5CF6
BLUE = 0x5B6EF5
SUCCESS = 0x3BA776
NEUTRAL = 0x2A2D3D

BRAND_NAME = "A6 - Custom Bot? DM Me!"
BANNER_FILENAME = "banner.png"
BANNER_PATH = os.path.join(HERE, "..", "assets", "banner.png")


def banner_file() -> discord.File:
    """Fresh attachment handle - discord.File objects are single-use per message."""
    return discord.File(BANNER_PATH, filename=BANNER_FILENAME)


def branded_embed(
    title: str | None = None,
    description: str | None = None,
    fields: list[tuple[str, str, bool]] | None = None,
    color: int = VIOLET,
    eyebrow: str | None = None,
    image: str | None = None,
    no_banner: bool = False,
    no_footer: bool = False,
) -> discord.Embed:
    """Build a themed embed: tinted border, banner strip, eyebrow, footer.

    Pass `image` when the screen needs the image slot for something else
    (e.g. a payment QR), `no_banner=True` to skip the strip entirely, or
    `no_footer=True` to drop the "A6 - Custom Bot? DM Me!" footer line.
    """
    embed = discord.Embed(color=color)
    if eyebrow:
        embed.set_author(name=eyebrow)
    if title:
        embed.title = title
    if description:
        embed.description = description
    if fields:
        for name, value, inline in fields:
            embed.add_field(name=name, value=value, inline=inline)
    if not no_footer:
        embed.set_footer(text=f"{BRAND_NAME} · updated live")
    if image:
        embed.set_image(url=image)
    elif not no_banner:
        embed.set_image(url=f"attachment://{BANNER_FILENAME}")
    return embed