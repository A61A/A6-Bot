"""Portal: the catalog. Browse a product, buy a version with credits."""

from __future__ import annotations

import discord
from discord.ext import commands

from cogs import router, views
from config import embeds
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
        await interaction.response.send_message(embeds=[embed], files=embeds.embed_files(), ephemeral=True)
        return

    if version.get("stock") is not None and version["stock"] <= 0:
        embed = embeds.branded_embed(
            title="Sold out",
            description="That one just ran out — check back soon or grab another version.",
        )
        await interaction.response.send_message(embeds=[embed], files=embeds.embed_files(), ephemeral=True)
        return

    try:
        db.spend_credits(user_id, version["price"])
    except ValueError:
        embed = embeds.branded_embed(
            title="Not enough credits",
            description="Your balance is too low — top up from your Pocket.",
        )
        await interaction.response.send_message(embeds=[embed], files=embeds.embed_files(), ephemeral=True)
        return
    if not db.take_stock(version["value"]):
        # Someone grabbed the last one mid-click - refund, don't charge.
        db.add_credits(user_id, version["price"], "refund", f"refund:{version['value']}")
        embed = embeds.branded_embed(
            title="Just sold out",
            description="Someone grabbed the last one first — your credits were refunded.",
        )
        await interaction.response.send_message(embeds=[embed], files=embeds.embed_files(), ephemeral=True)
        return
    return await _finish_purchase(interaction, product, version, back_view)


@router.button("portal:buy")
async def portal_buy(interaction: discord.Interaction, rest: list[str]):
    await purchase_version(interaction, rest[0], views.hub_home_button_view(interaction.user))


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