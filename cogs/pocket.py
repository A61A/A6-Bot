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
        await interaction.response.send_message(embeds=[embed], ephemeral=True)


class PocketCog(commands.Cog):
    # No direct slash command — the Pocket screen is launched from /hub.
    def __init__(self, bot: commands.Bot):
        self.bot = bot


@router.button("pocket:redeem")
async def pocket_redeem(interaction: discord.Interaction, _rest: list[str]):
    await interaction.response.send_modal(RedeemModal())


@router.select("pocket:pay")
async def pocket_pay(interaction: discord.Interaction, values: list[str]):
    """A payment method picked from the Bank dropdown -> choose the top-up amount."""
    pm = db.get_payment_method(values[0] if values else None)
    if pm is None:
        await interaction.response.send_message(
            "That payment method is no longer available — pick another one.", ephemeral=True
        )
        return
    embed = embeds.branded_embed(
        title=pm["label"],
        description=(
            f"How much are you topping up with **{pm['label']}**?\n\n"
            "**$1 = 1 credit** — pick an amount and we'll tell you exactly what to send."
        ),
        hero=False,
        shop=False,
    )
    amounts = [5, 10, 25, 50]
    rows: list[list[dict]] = []
    for i in range(0, len(amounts), 2):
        rows.append(
            [
                {
                    "custom_id": f"pocket:amount:{pm['id']}:{a}",
                    "label": f"${a}",
                    "style": discord.ButtonStyle.secondary,
                }
                for a in amounts[i : i + 2]
            ]
        )
    rows.append([{"custom_id": "pocket:back", "label": "Back to Pocket", "style": discord.ButtonStyle.secondary}])
    await interaction.response.edit_message(embeds=[embed], view=router.make_view(rows))


@router.button("pocket:amount")
async def pocket_amount(interaction: discord.Interaction, rest: list[str]):
    """Amount picked -> the payment screen: amount due, the note, where to send it."""
    pm = db.get_payment_method(rest[0] if rest else None)
    if pm is None:
        await interaction.response.send_message(
            "That payment method is no longer available — pick another one.", ephemeral=True
        )
        return
    try:
        amount = int(rest[1])
    except (IndexError, TypeError, ValueError):
        amount = 0
    if amount <= 0:
        await interaction.response.send_message("Pick an amount to continue.", ephemeral=True)
        return

    # Fresh note per click, logged with what it's for so staff can match the payment.
    note = notes.generate_note()
    db.log_payment_note(
        interaction.user.id,
        pm["id"],
        pm["label"],
        note,
        amount=f"${amount}",
        context="Balance top-up",
    )
    embed, view = views.payment_screen(
        pm,
        note,
        amount=f"${amount}",
        back={"custom_id": "pocket:back", "label": "Back to Pocket", "style": discord.ButtonStyle.secondary},
    )
    await interaction.response.edit_message(embeds=[embed], view=view)


@router.button("pocket:back")
async def pocket_back(interaction: discord.Interaction, _rest: list[str]):
    embed, view = views.pocket_menu(interaction.user)
    # Pocket is text-only: keep the banner strip and hero off the message.
    await interaction.response.edit_message(embeds=[embed], view=view, attachments=[])


async def setup(bot: commands.Bot):
    await bot.add_cog(PocketCog(bot))