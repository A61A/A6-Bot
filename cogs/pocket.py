"""Pocket: balance, redeem codes, and the buy-credits entry point."""

from __future__ import annotations

import discord
from discord.ext import commands

from cogs import router, views
from config import embeds, notes
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
            title="Redeem a code",
            description=message,
        )
        if ok:
            embed.add_field(name="New balance", value=f"{details['balance']} credits", inline=False)
            embed.color = embeds.SUCCESS
        else:
            embed.color = embeds.NEUTRAL
        await interaction.response.send_message(embeds=[embed], files=embeds.embed_files(), ephemeral=True)


class PocketCog(commands.Cog):
    # No direct slash command — the Pocket screen is launched from /hub.
    def __init__(self, bot: commands.Bot):
        self.bot = bot


@router.button("pocket:redeem")
async def pocket_redeem(interaction: discord.Interaction, _rest: list[str]):
    await interaction.response.send_modal(RedeemModal())


@router.select("pocket:pay")
async def pocket_pay(interaction: discord.Interaction, values: list[str]):
    """A payment method picked from the Bank dropdown."""
    pm = db.get_payment_method(values[0] if values else None)
    if pm is None:
        await interaction.response.send_message(
            "That payment method is no longer available — pick another one.", ephemeral=True
        )
        return
    rows: list[list[dict]] = []
    if pm["url"]:
        # URL set -> a direct link button; no URL -> the written instructions.
        rows.append([{"label": f"Open {pm['label']}"[:80], "url": pm["url"], "emoji": pm["emoji"] or None}])
    rows.append([{"custom_id": "pocket:back", "label": "Back to Pocket", "style": discord.ButtonStyle.secondary}])

    # Manual payment -> a fresh note to paste into the payment, so staff can
    # match it. (Crypto runs through its own invoice flow instead.)
    note = notes.generate_note()
    db.log_payment_note(interaction.user.id, pm["id"], pm["label"], note)

    details = (pm["details"] or "").strip()
    if pm["url"]:
        body = details or f"Tap **Open {pm['label']}** to pay."
    else:
        body = details or "No instructions yet — contact staff."
    description = f"**{notes.note_line(note)}**\n\n{body}"
    embed = embeds.branded_embed(title=pm["label"], description=description, hero=False, shop=False)
    await interaction.response.edit_message(embeds=[embed], view=router.make_view(rows))


@router.button("pocket:back")
async def pocket_back(interaction: discord.Interaction, _rest: list[str]):
    embed, view = views.pocket_menu(interaction.user)
    # Pocket is text-only: keep the banner strip and hero off the message.
    await interaction.response.edit_message(embeds=[embed], view=view, attachments=[])


async def setup(bot: commands.Bot):
    await bot.add_cog(PocketCog(bot))