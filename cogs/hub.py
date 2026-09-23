"""The /hub command and its menu buttons."""

from __future__ import annotations

import discord
from discord.ext import commands

from cogs import router, views
from config import embeds
from config.roles import is_owner


class HubCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    @discord.app_commands.command(name="hub", description="Open the hub menu")
    async def hub(self, interaction: discord.Interaction):
        embed, view = views.hub_menu(interaction.user)
        await interaction.response.send_message(
            embeds=[embed], view=view, files=[embeds.banner_file()], ephemeral=True
        )

    @discord.app_commands.command(name="sync", description="Staff: re-sync slash commands")
    @discord.app_commands.describe(guild_id="Optional guild ID to sync instantly (defaults to global)")
    async def sync(self, interaction: discord.Interaction, guild_id: str | None = None):
        if not is_owner(interaction.user.id):
            await interaction.response.send_message("Only the bot owner can do that.", ephemeral=True)
            return
        await interaction.response.defer(ephemeral=True, thinking=True)
        try:
            if guild_id:
                guild = discord.Object(id=int(guild_id))
                cmds = await self.bot.tree.sync(guild=guild)
                msg = f"synced {len(cmds)} commands to guild {guild_id}"
            else:
                cmds = await self.bot.tree.sync()
                msg = f"synced {len(cmds)} global commands"
            print(f"[nodeline] manual sync: {msg}")
            await interaction.edit_original_response(content=f"Done — {msg}.")
        except Exception as err:
            print(f"[nodeline] manual sync failed: {err}")
            await interaction.edit_original_response(content=f"Sync failed: {err}")


@router.button("hub:home")
async def hub_home(interaction: discord.Interaction, _rest: list[str]):
    embed, view = views.hub_menu(interaction.user)
    # The banner attachment from the original send is kept automatically on edits.
    await interaction.response.edit_message(embeds=[embed], view=view)


@router.button("hub:portal")
async def hub_portal(interaction: discord.Interaction, _rest: list[str]):
    embed, view = views.portal_menu(interaction.user)
    await interaction.response.edit_message(embeds=[embed], view=view)


@router.button("hub:pocket")
async def hub_pocket(interaction: discord.Interaction, _rest: list[str]):
    embed, view = views.pocket_menu(interaction.user)
    await interaction.response.edit_message(embeds=[embed], view=view)


async def setup(bot: commands.Bot):
    await bot.add_cog(HubCog(bot))