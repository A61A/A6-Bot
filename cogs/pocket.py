"""Pocket: balance, redeem codes, and the buy-credits entry point."""

from __future__ import annotations

import discord
from discord.ext import commands

from cogs import router, views
from config import embeds
from lib import db


class RedeemModal(discord.ui.Modal, title="Redeem a code"):
    code_input = discord.ui.TextInput(
        label="Code",
        placeholder="e.g. ND-XXXX-XXXX",
        min_length=1,
        max_length=64,
        required=True,
    )

    def __init__(self):
        super().__init__(custom_id="redeem:code", timeout=300)

    async def on_submit(self, interaction: discord.Interaction):
        code = self.code_input.value.strip()
        ok, message, details = db.redeem_code(interaction.user.id, code)
        embed = embeds.branded_embed(
            eyebrow="A6",
            title="Redeem a code",
            description=message,
        )
        if ok:
            embed.add_field(name="New balance", value=f"{details['balance']} credits", inline=False)
            embed.color = embeds.SUCCESS
        else:
            embed.color = embeds.NEUTRAL
        await interaction.response.send_message(embeds=[embed], files=[embeds.banner_file()], ephemeral=True)


class PocketCog(commands.Cog):
    # No direct slash command — the Pocket screen is launched from /hub.
    def __init__(self, bot: commands.Bot):
        self.bot = bot


@router.button("pocket:redeem")
async def pocket_redeem(interaction: discord.Interaction, _rest: list[str]):
    await interaction.response.send_modal(RedeemModal())


async def setup(bot: commands.Bot):
    await bot.add_cog(PocketCog(bot))