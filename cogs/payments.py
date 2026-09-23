"""Crypto top-ups: amount -> coin -> invoice, then a background sweeper that
credits the wallet when a payment lands (or auto-completes in simulator mode).
"""

from __future__ import annotations

import asyncio

import discord
from discord.ext import commands

from cogs import router, views
from config import embeds
from lib import db, payments as paylib

POLL_SECONDS = 10


def _coin_label(value: str) -> str:
    for coin in paylib.SUPPORTED_COINS:
        if coin["value"] == value:
            return f"{coin['label']} ({value})"
    return value


def _invoice_embed(payment, finished_amount: float | None = None) -> discord.Embed:
    provider = paylib.payment_provider()
    fields = []
    fields.append(("Amount", f"${payment['amount_usd']:.2f} USD", True))
    currency = payment["currency"] or "USD"
    fields.append(("You pay", f"{_coin_label(currency)}", True))
    if payment["pay_amount"] is not None:
        fields.append(("Coin amount", f"{payment['pay_amount']:.8f} {currency}", True))

    if finished_amount is not None:
        description = f"Payment received ({finished_amount:.8f} {currency})."
    elif payment["pay_address"]:
        description = f"Send exactly **{payment['pay_amount']:.8f} {currency}** to:\n\n`{payment['pay_address']}`"
    else:
        description = "The payment is being prepared…"
    if payment["checkout_url"]:
        description += f"\n\nOr pay via the hosted checkout: {payment['checkout_url']}"

    embed = embeds.branded_embed(
        eyebrow="A6",
        title="Buy Credits — Crypto",
        description=description,
        fields=fields,
    )
    if provider == "sim":
        embed.add_field(name="Simulator", value="Testing mode: the payment completes automatically in ~16s.", inline=False)
    return embed


def _invoice_view(payment_id: int) -> discord.ui.View:
    return views.router.make_view(
        [
            [
                {"custom_id": f"pay:refresh:{payment_id}", "label": "Refresh Status", "style": discord.ButtonStyle.secondary},
                {"custom_id": f"pay:cancel:{payment_id}", "label": "Cancel", "style": discord.ButtonStyle.danger},
            ]
        ]
    )


@router.button("pocket:buycredits")
async def pocket_buycredits(interaction: discord.Interaction, _rest: list[str]):
    embed, view = views.buy_credits_flow(interaction.user)
    await interaction.response.edit_message(embeds=[embed], view=view)


@router.button("pay:amount")
async def pay_amount(interaction: discord.Interaction, rest: list[str]):
    try:
        amount = int(rest[0])
    except (IndexError, ValueError):
        await interaction.response.send_message("That option is stale — start again from Pocket.", ephemeral=True)
        return
    embed, view = views.coin_selector(interaction.user, amount)
    await interaction.response.edit_message(embeds=[embed], view=view)


@router.select("pay:coin")
async def pay_coin(interaction: discord.Interaction, values: list[str]):
    coin = values[0]
    amount = 5
    # the amount rides along in the custom_id: "pay:coin:<amount>"
    rest = interaction.data["custom_id"].split(":")
    try:
        amount = int(rest[2])
    except (IndexError, ValueError):
        pass

    await interaction.response.defer(thinking=True)
    created = await paylib.create_payment(interaction.user.id, amount, coin)
    payment = db.get_payment(created["payment_id"])
    embed = _invoice_embed(payment)
    await interaction.edit_original_response(
        embeds=[embed], view=_invoice_view(created["payment_id"]), attachments=[]
    )


@router.button("pay:refresh")
async def pay_refresh(interaction: discord.Interaction, rest: list[str]):
    try:
        payment_id = int(rest[0])
    except (IndexError, ValueError):
        await interaction.response.send_message("That payment no longer exists.", ephemeral=True)
        return
    payment = db.get_payment(payment_id)
    if payment is None:
        await interaction.response.send_message("That payment no longer exists.", ephemeral=True)
        return
    if payment["status"] in ("finished", "failed", "cancelled"):
        embed = _invoice_embed(payment)
        await interaction.response.edit_message(embeds=[embed], view=None)
        return
    await interaction.response.defer(thinking=True)
    try:
        status = await paylib.check_payment(payment)
    except RuntimeError as err:
        await interaction.edit_original_response(content=f"Could not reach the payment provider: {err}")
        return
    await finalize_if_done(payment_id, status)
    payment = db.get_payment(payment_id)
    embed = _invoice_embed(payment)
    if payment["status"] in ("finished", "failed", "cancelled"):
        await interaction.edit_original_response(embeds=[embed], view=None)
    else:
        await interaction.edit_original_response(embeds=[embed], view=_invoice_view(payment_id))


@router.button("pay:cancel")
async def pay_cancel(interaction: discord.Interaction, rest: list[str]):
    try:
        payment_id = int(rest[0])
    except (IndexError, ValueError):
        await interaction.response.send_message("That payment no longer exists.", ephemeral=True)
        return
    if db.get_payment(payment_id) is None:
        await interaction.response.send_message("That payment no longer exists.", ephemeral=True)
        return
    db.update_payment(payment_id, status="cancelled")
    embed = embeds.branded_embed(
        eyebrow="A6", title="Top-up cancelled", description="No problem — you can start a new one from your Pocket."
    )
    await interaction.response.edit_message(embeds=[embed], view=None)


async def finalize_if_done(payment_id: int, status: dict) -> None:
    """Credit the wallet when a payment finishes; mark failures. Returns nothing."""
    payment = db.get_payment(payment_id)
    if payment is None or payment["status"] in ("finished", "failed", "cancelled"):
        return
    kind = status.get("status")
    if kind == "finished":
        db.add_credits(payment["user_id"], int(payment["amount_usd"]), "deposit", f"pay:{payment_id}")
        db.update_payment(payment_id, status="finished")
    elif kind == "failed":
        db.update_payment(payment_id, status="failed")


class PaymentsCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self._sweeper_task = None

    async def cog_load(self):
        self._sweeper_task = self.bot.loop.create_task(self._sweeper())

    async def cog_unload(self):
        if self._sweeper_task:
            self._sweeper_task.cancel()

    async def _notify_user(self, user_id: str, embed: discord.Embed):
        user = self.bot.get_user(int(user_id))
        if user:
            try:
                await user.send(embeds=[embed], files=[embeds.banner_file()])
            except discord.Forbidden:
                pass

    async def _sweeper(self):
        await self.bot.wait_until_ready()
        while True:
            try:
                for row in db.pending_payments():
                    if row["status"] != "pending":
                        continue
                    if db.now_ms() > row["expires_at"]:
                        db.update_payment(row["id"], status="failed")
                        continue
                    try:
                        status = await paylib.check_payment(row)
                    except RuntimeError as err:
                        print(f"[payments] check failed for #{row['id']}: {err}")
                        continue
                    if status.get("status") == "finished":
                        db.add_credits(row["user_id"], int(row["amount_usd"]), "deposit", f"pay:{row['id']}")
                        db.update_payment(row["id"], status="finished")
                        balance = db.get_credits(row["user_id"])
                        embed = embeds.branded_embed(
                            eyebrow="A6",
                            title="Top-up confirmed",
                            description=f"**{int(row['amount_usd'])} credits** are in your Pocket.",
                            fields=[("Balance", f"{balance} credits", True)],
                            color=embeds.SUCCESS,
                        )
                        await self._notify_user(row["user_id"], embed)
                    elif status.get("status") == "failed":
                        db.update_payment(row["id"], status="failed")
                        await self._notify_user(
                            row["user_id"],
                            embeds.branded_embed(
                                eyebrow="A6", title="Top-up failed", description="The payment didn't go through."
                            ),
                        )

                # auto-close stale support tickets (24h of silence)
                for t in db.open_tickets_before(db.now_ms() - 24 * 60 * 60 * 1000):
                    db.close_ticket(t["id"])
            except Exception as err:
                print(f"[sweeper] error: {err}")
            await asyncio.sleep(POLL_SECONDS)


async def setup(bot: commands.Bot):
    await bot.add_cog(PaymentsCog(bot))