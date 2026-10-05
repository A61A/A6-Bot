"""Portal: the catalog. Browse a product, buy a version with credits."""

from __future__ import annotations

import discord
from discord.ext import commands

from cogs import router, views
from config import embeds, notes
from lib import db


class PortalCog(commands.Cog):
    # No direct slash command — the catalog is launched from /hub.
    def __init__(self, bot: commands.Bot):
        self.bot = bot


@router.select("portal:product")
async def portal_product(interaction: discord.Interaction, values: list[str]):
    key = values[0]
    product = db.get_product(key)
    if product is None:
        await interaction.response.send_message("That product no longer exists.", ephemeral=True)
        return
    if product.get("coming_soon"):
        await interaction.response.send_message(f"{product['label']} is coming soon — sit tight!", ephemeral=True)
        return
    embed, view = views.product_page(interaction.user, product)
    await interaction.response.edit_message(embeds=[embed], view=view)


async def purchase_version(interaction: discord.Interaction, version_value: str, back_view: discord.ui.View):
    """Shared purchase path for both the /hub portal and the kiosk.

    `back_view` is the view shown on the Purchase-complete message so each
    surface can send the user back to its own menu.
    """
    # walk the visible products to find which one owns this version_value
    product = next(
        (p for p in views._visible_products() if any(v["value"] == version_value for v in p["versions"])),
        None,
    )
    if product is None:
        await interaction.response.send_message(
            "That option is stale — go back to the catalog and try again.", ephemeral=True
        )
        return

    version = next(v for v in product["versions"] if v["value"] == version_value)
    product_key, user_id = product["key"], interaction.user.id

    if product.get("coming_soon"):
        await interaction.response.send_message(f"{product['label']} is coming soon — sit tight!", ephemeral=True)
        return
    if product.get("hidden"):
        return

    if product.get("once", False) and db.has_purchased(user_id, product_key):
        embed = embeds.branded_embed(
            title="Already yours",
            description="You already own this product — no need to buy it again.",
        )
        await interaction.response.send_message(embeds=[embed], ephemeral=True)
        return

    if version.get("stock") is not None and version["stock"] <= 0:
        embed = embeds.branded_embed(
            title="Sold out",
            description="That one just ran out — check back soon or grab another version.",
        )
        await interaction.response.send_message(embeds=[embed], ephemeral=True)
        return

    try:
        db.spend_credits(user_id, version["price"])
    except ValueError:
        embed = embeds.branded_embed(
            title="Not enough credits",
            description="Your balance is too low — top up from your Pocket.",
        )
        await interaction.response.send_message(embeds=[embed], ephemeral=True)
        return
    if not db.take_stock(version["value"]):
        # Someone grabbed the last one mid-click - refund, don't charge.
        db.add_credits(user_id, version["price"], "refund", f"refund:{version['value']}")
        embed = embeds.branded_embed(
            title="Just sold out",
            description="Someone grabbed the last one first — your credits were refunded.",
        )
        await interaction.response.send_message(embeds=[embed], ephemeral=True)
        return
    return await _finish_purchase(interaction, product, version, back_view)


@router.button("portal:buy")
async def portal_buy(interaction: discord.Interaction, rest: list[str]):
    await purchase_version(interaction, rest[0], views.hub_home_button_view(interaction.user))


@router.select("portal:buy:select")
async def portal_buy_select(interaction: discord.Interaction, values: list[str]):
    # Same purchase path as the old per-version buttons; the version arrives
    # as the dropdown's chosen value.
    await purchase_version(interaction, values[0], views.hub_home_button_view(interaction.user))


# ---------------------------------------------------- direct pay (no credits)
# The BUY button underneath a product's version dropdown: the customer picks a
# version, picks a payment method, and gets the same payment screen the Pocket
# top-up shows — amount due, a fresh note, and where to send it. Nothing is
# charged here; staff fulfil it from /admin -> Payment Notes.


def _prefix_of(interaction: discord.Interaction) -> str:
    cid = str((interaction.data or {}).get("custom_id", ""))
    return "kiosk:buy" if cid.startswith("kiosk:") else "portal:buy"


def _embedded_value(interaction: discord.Interaction, marker: str) -> str:
    """Everything after `marker` in the custom_id (version values contain ':')."""
    cid = str((interaction.data or {}).get("custom_id", ""))
    return cid.split(marker, 1)[1] if marker in cid else ""


def _payable_versions(product: dict, user) -> list[dict]:
    owned = product.get("once", False) and db.has_purchased(user.id, product["key"])
    if owned:
        return []
    return [
        v
        for v in product["versions"]
        if v.get("stock") is None or v["stock"] > 0
    ]


def _find_version(version_value: str):
    if not version_value:
        return None, None
    product = next(
        (p for p in views._visible_products() if any(v["value"] == version_value for v in p["versions"])),
        None,
    )
    if product is None:
        return None, None
    return product, next(v for v in product["versions"] if v["value"] == version_value)


def _product_page(user, product: dict, buy_prefix: str):
    """Re-render a product page for whichever surface we came from."""
    if buy_prefix.startswith("kiosk"):
        return views.product_page(
            user,
            product,
            hero=False,
            back={
                "custom_id": "kiosk:menu:products",
                "label": "Back to Products",
                "style": discord.ButtonStyle.secondary,
            },
            buy_prefix=buy_prefix,
        )
    return views.product_page(user, product, buy_prefix=buy_prefix)


async def _method_picker(interaction, product: dict, version: dict, buy_prefix: str):
    options = views.payment_method_options()
    if not options:
        await interaction.response.send_message(
            "No payment methods are set up yet — head to Support and we'll sort you out.",
            ephemeral=True,
        )
        return
    embed = embeds.branded_embed(
        title="Pay directly",
        description=(
            f"**{product['label']} — {version['label']}**\n\n"
            f"**Amount due = ${version['price']}**\n\n"
            "Pick where you're sending it."
        ),
        hero=False,
        shop=False,
    )
    view = router.make_view(
        [
            [views.payment_method_select(f"{buy_prefix}:paym:{version['value']}")],
            [
                {
                    "custom_id": f"{buy_prefix}:payback:{product['key']}",
                    "label": "Back to product",
                    "style": discord.ButtonStyle.secondary,
                }
            ],
        ]
    )
    await interaction.response.edit_message(embeds=[embed], view=view)


@router.button("portal:buy:paydirect")
@router.button("kiosk:buy:paydirect")
async def buy_paydirect(interaction: discord.Interaction, rest: list[str]):
    buy_prefix = _prefix_of(interaction)
    product = db.get_product(":".join(rest)) if rest else None
    if product is None or product.get("coming_soon") or product.get("hidden"):
        await interaction.response.send_message("That product isn't available right now.", ephemeral=True)
        return
    payable = _payable_versions(product, interaction.user)
    if not payable:
        await interaction.response.send_message("That one isn't available right now.", ephemeral=True)
        return
    if len(payable) == 1:
        await _method_picker(interaction, product, payable[0], buy_prefix)
        return

    options = [
        discord.SelectOption(
            label=f"{v['label']} — ${v['price']}",
            value=v["value"],
            description=("unlimited stock" if v.get("stock") is None else f"{v['stock']} left"),
        )
        for v in payable
    ]
    embed = embeds.branded_embed(
        title="Pay directly",
        description=(
            f"**{product['label']}**\n\n"
            "Pick which version you're paying for — we'll show you where to send it."
        ),
        hero=False,
        shop=False,
    )
    view = router.make_view(
        [
            [
                {
                    "type": "select",
                    "custom_id": f"{buy_prefix}:payver",
                    "placeholder": "Pick a version…",
                    "options": options,
                }
            ],
            [
                {
                    "custom_id": f"{buy_prefix}:payback:{product['key']}",
                    "label": "Back to product",
                    "style": discord.ButtonStyle.secondary,
                }
            ],
        ]
    )
    await interaction.response.edit_message(embeds=[embed], view=view)


@router.select("portal:buy:payver")
@router.select("kiosk:buy:payver")
async def buy_payver(interaction: discord.Interaction, values: list[str]):
    buy_prefix = _prefix_of(interaction)
    product, version = _find_version(values[0] if values else "")
    if product is None:
        await interaction.response.send_message("That option is stale — go back and try again.", ephemeral=True)
        return
    if version not in _payable_versions(product, interaction.user):
        await interaction.response.send_message("That version isn't available right now.", ephemeral=True)
        return
    await _method_picker(interaction, product, version, buy_prefix)


@router.select("portal:buy:paym")
@router.select("kiosk:buy:paym")
async def buy_paym(interaction: discord.Interaction, values: list[str]):
    buy_prefix = _prefix_of(interaction)
    product, version = _find_version(_embedded_value(interaction, ":paym:"))
    pm = db.get_payment_method(values[0] if values else None)
    if product is None or pm is None:
        await interaction.response.send_message("That option is stale — go back and try again.", ephemeral=True)
        return
    if version not in _payable_versions(product, interaction.user):
        await interaction.response.send_message("That version isn't available right now.", ephemeral=True)
        return

    note = notes.generate_note()
    db.log_payment_note(
        interaction.user.id,
        pm["id"],
        pm["label"],
        note,
        amount=f"${version['price']}",
        context=f"{product['label']} — {version['label']}",
    )
    embed, view = views.payment_screen(
        pm,
        note,
        amount=f"${version['price']}",
        back={
            "custom_id": f"{buy_prefix}:payback:{product['key']}",
            "label": "Back to product",
            "style": discord.ButtonStyle.secondary,
        },
    )
    await interaction.response.edit_message(embeds=[embed], view=view)


@router.button("portal:buy:payback")
@router.button("kiosk:buy:payback")
async def buy_payback(interaction: discord.Interaction, rest: list[str]):
    product = db.get_product(":".join(rest)) if rest else None
    if product is None:
        await interaction.response.send_message("That product no longer exists.", ephemeral=True)
        return
    embed, view = _product_page(interaction.user, product, _prefix_of(interaction))
    await interaction.response.edit_message(embeds=[embed], view=view)


async def _finish_purchase(interaction, product, version, back_view):
    user_id = interaction.user.id
    db.record_purchase(user_id, product["key"], version["value"], version["price"])

    embed = embeds.branded_embed(
        title="Purchase complete",
        description=f"{product.get('emoji', '')} **{product['label']}** — **{version['label']}**\n\n{version.get('content', '')}",
        fields=[("Spent", f"{version['price']} credits", True), ("Balance", f"{db.get_credits(user_id)} credits", True)],
    )
    embed.add_field(name="Support", value="Need help? Head to the hub -> **Support**.", inline=False)
    await interaction.response.edit_message(embeds=[embed], view=back_view)

    # Best-effort DM delivery after the interaction is answered, so a slow
    # DM can never blow the 3-second response window. The inline copy above
    # already shows the content, so a closed-DM failure changes nothing —
    # catch everything, this must never fail an already-completed purchase.
    delivery = version.get("content", "").strip()
    if delivery:
        try:
            await interaction.user.send(
                embed=embeds.branded_embed(
                    title=f"Delivery — {product['label']}",
                    description=f"**{version['label']}**\n\n{delivery}",
                    hero=False,
                    shop=False,
                )
            )
        except Exception:
            pass


async def setup(bot: commands.Bot):
    await bot.add_cog(PortalCog(bot))