"""Portal: the catalog. Browse a product, buy a version with credits."""

from __future__ import annotations

import discord
from discord.ext import commands

from cogs import router, views
from config import embeds
from config.products import find_product
from lib import db


class PortalCog(commands.Cog):
    # No direct slash command — the catalog is launched from /hub.
    def __init__(self, bot: commands.Bot):
        self.bot = bot


@router.select("portal:product")
async def portal_product(interaction: discord.Interaction, values: list[str]):
    key = values[0]
    product = find_product(key)
    if product is None:
        await interaction.response.send_message("That product no longer exists.", ephemeral=True)
        return
    if product.get("coming_soon"):
        await interaction.response.send_message(f"{product['label']} is coming soon — sit tight!", ephemeral=True)
        return
    embed, view = views.product_page(interaction.user, product)
    await interaction.response.edit_message(embeds=[embed], view=view)


@router.button("portal:buy")
async def portal_buy(interaction: discord.Interaction, rest: list[str]):
    version_value = rest[0]
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
            eyebrow="A6",
            title="Already yours",
            description="You already own this product — no need to buy it again.",
        )
        await interaction.response.send_message(embeds=[embed], files=[embeds.banner_file()], ephemeral=True)
        return

    try:
        db.spend_credits(user_id, version["price"])
    except ValueError:
        embed = embeds.branded_embed(
            eyebrow="A6",
            title="Not enough credits",
            description="Your balance is too low — top up from your Pocket.",
        )
        await interaction.response.send_message(embeds=[embed], files=[embeds.banner_file()], ephemeral=True)
        return
    return await _finish_purchase(interaction, product, version)


async def _finish_purchase(interaction, product, version):
    user_id = interaction.user.id
    db.record_purchase(user_id, product["key"], version["value"], version["price"])

    embed = embeds.branded_embed(
        eyebrow="A6",
        title="Purchase complete",
        description=f"{product.get('emoji', '')} **{product['label']}** — **{version['label']}**\n\n{version.get('content', '')}",
        fields=[("Spent", f"{version['price']} credits", True), ("Balance", f"{db.get_credits(user_id)} credits", True)],
    )
    embed.add_field(name="Support", value="Need help? Head to the hub -> **Support**.", inline=False)
    await interaction.response.edit_message(embeds=[embed], view=views.hub_home_button_view(interaction.user))


async def setup(bot: commands.Bot):
    await bot.add_cog(PortalCog(bot))