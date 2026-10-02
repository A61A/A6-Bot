"""Site kiosk: a minimal Components V2 panel for the site channel.

Just the banner, a heading, one Website link button, and the hero gif.
Posted with owner-only ``/sitekiosk``. Shares the V2 machinery in lib/v2.py
and the kiosk's SITE_URL.
"""

from __future__ import annotations

import os

import discord
from discord.ext import commands

from cogs.kiosk import SITE_URL
from config import embeds
from config.channels import CHANNELS
from config.roles import is_owner
from lib import v2


def build_site_container() -> dict:
    return v2.panel(
        title=os.getenv("SITEKIOSK_TITLE", "Website"),
        brand=embeds.BRAND_SHORT,
        buttons=[v2.link_button("Website", SITE_URL)],
        banner=f"attachment://{embeds.BANNER_FILENAME}",
        hero=f"attachment://{embeds.HERO_FILENAME}",
        accent=embeds.VIOLET,
    )


async def post_site_kiosk(bot, channel_id: int | str) -> dict:
    """Validate then POST the site panel. Returns Discord's message object."""
    return await v2.send_panel(bot, channel_id, build_site_container(), files=embeds.embed_files())


class SiteKioskCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    @discord.app_commands.command(name="sitekiosk", description="Staff: (re)post the site-channel panel")
    @discord.app_commands.describe(channel="Channel to post in (defaults to the site channel)")
    async def sitekiosk(self, interaction: discord.Interaction, channel: discord.TextChannel | None = None):
        if not is_owner(interaction.user.id):
            await interaction.response.send_message("Only the bot owner can do that.", ephemeral=True)
            return
        target = channel or (interaction.client.get_channel(int(CHANNELS["site"])) if CHANNELS.get("site") else None)
        if target is None:
            await interaction.response.send_message(
                "No site channel configured — set SITE_CHANNEL_ID first.", ephemeral=True
            )
            return
        await interaction.response.defer(ephemeral=True, thinking=True)
        try:
            await post_site_kiosk(interaction.client, target.id)
        except (ValueError, discord.DiscordException) as err:
            await interaction.edit_original_response(content=f"Site post failed: {err}")
            return
        await interaction.edit_original_response(content=f"Site panel posted in {target.mention}.")


async def setup(bot: commands.Bot):
    await bot.add_cog(SiteKioskCog(bot))
