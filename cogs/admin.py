"""Store management (owner only).

/admin product ...  add / edit / remove / list products
/admin version ...  add / edit / remove versions (price + stock live here)

Everything reads straight from the DB, so changes apply instantly -
no restart, no re-post. Stock is per version: a number, or unlimited.
"""

from __future__ import annotations

import discord
from discord import app_commands
from discord.ext import commands

from config import embeds
from config.roles import is_owner
from lib import db


def _stock_text(stock: int | None) -> str:
    return "unlimited" if stock is None else f"{stock} left"


def _version_line(v: dict) -> str:
    return f"**{v['label']}** — {v['price']} credits ({_stock_text(v['stock'])})"


def _flags(p: dict) -> str:
    tags = []
    if p.get("coming_soon"):
        tags.append("soon")
    if p.get("hidden"):
        tags.append("hidden")
    if p.get("once"):
        tags.append("once")
    return f" [{', '.join(tags)}]" if tags else ""


async def _guard(interaction: discord.Interaction) -> bool:
    if is_owner(interaction.user.id):
        return True
    await interaction.response.send_message("Only the bot owner can do that.", ephemeral=True)
    return False


class AdminCog(commands.Cog):
    admin = app_commands.Group(name="admin", description="Store management (owner only)")
    product = app_commands.Group(name="product", parent=admin, description="Add, edit, remove products")
    version = app_commands.Group(name="version", parent=admin, description="Prices and stock per version")

    def __init__(self, bot: commands.Bot):
        self.bot = bot

    # ---------------------------------------------------------- product list

    @product.command(name="list", description="Show the full catalog with prices and stock")
    async def product_list(self, interaction: discord.Interaction):
        if not await _guard(interaction):
            return
        products = db.list_products(include_hidden=True)
        if not products:
            await interaction.response.send_message("The catalog is empty.", ephemeral=True)
            return
        fields = []
        for p in products:
            body = "\n".join(_version_line(v) for v in p["versions"]) or "No versions."
            fields.append((f"{p.get('emoji', '')} {p['label']} (`{p['key']}`){_flags(p)}", body, False))
        embed = embeds.branded_embed(title="Catalog", fields=fields[:25], hero=False, shop=False)
        await interaction.response.send_message(embeds=[embed], ephemeral=True)

    # ----------------------------------------------------------- product add

    @product.command(name="add", description="Add a product (creates a Standard version automatically)")
    @app_commands.describe(
        key="Short id, e.g. spotify",
        label="Display name, e.g. Lifetime Spotify Premium",
        price="Price in credits for the Standard version",
        desc="One-line description",
        emoji="Emoji shown in the catalog",
        stock="Starting stock (leave empty for unlimited)",
    )
    async def product_add(
        self,
        interaction: discord.Interaction,
        key: str,
        label: str,
        price: int,
        desc: str = "",
        emoji: str = "",
        stock: int | None = None,
    ):
        if not await _guard(interaction):
            return
        if price < 0 or (stock is not None and stock < 0):
            await interaction.response.send_message("Price and stock can't be negative.", ephemeral=True)
            return
        try:
            db.add_product(key, label, desc, emoji)
            value = db.add_version(key.strip().lower().replace(" ", "_"), "Standard", price, stock)
        except ValueError as err:
            await interaction.response.send_message(str(err), ephemeral=True)
            return
        p = db.get_product(key.strip().lower().replace(" ", "_"))
        embed = embeds.branded_embed(
            title="Product added",
            description=f"{p['label']} (`{p['key']}`) with **Standard** — {price} credits ({_stock_text(stock)}).",
            hero=False,
            shop=False,
        )
        await interaction.response.send_message(embeds=[embed], ephemeral=True)

    # ---------------------------------------------------------- product edit

    @product.command(name="edit", description="Edit a product's name, description, emoji or flags")
    @app_commands.describe(
        key="Product id",
        label="New display name",
        desc="New description",
        emoji="New emoji",
        coming_soon="Show as coming soon",
        hidden="Hide from the catalog",
        once="One purchase per user ever",
    )
    async def product_edit(
        self,
        interaction: discord.Interaction,
        key: str,
        label: str | None = None,
        desc: str | None = None,
        emoji: str | None = None,
        coming_soon: bool | None = None,
        hidden: bool | None = None,
        once: bool | None = None,
    ):
        if not await _guard(interaction):
            return
        try:
            db.update_product(
                key.strip().lower(), label=label, desc=desc, emoji=emoji,
                coming_soon=coming_soon, hidden=hidden, once=once,
            )
        except ValueError as err:
            await interaction.response.send_message(str(err), ephemeral=True)
            return
        p = db.get_product(key.strip().lower())
        embed = embeds.branded_embed(
            title="Product updated",
            description=f"{p['label']} (`{p['key']}`){_flags(p)}",
            hero=False,
            shop=False,
        )
        await interaction.response.send_message(embeds=[embed], ephemeral=True)

    # -------------------------------------------------------- product remove

    @product.command(name="remove", description="Delete a product and all its versions")
    @app_commands.describe(key="Product id", confirm="Must be True - no undo")
    async def product_remove(self, interaction: discord.Interaction, key: str, confirm: bool = False):
        if not await _guard(interaction):
            return
        if not confirm:
            await interaction.response.send_message(
                "Pass `confirm: True` - deleting a product cannot be undone.", ephemeral=True
            )
            return
        try:
            db.delete_product(key.strip().lower())
        except ValueError as err:
            await interaction.response.send_message(str(err), ephemeral=True)
            return
        embed = embeds.branded_embed(title="Product removed", description=f"`{key}` is gone from the catalog.", hero=False, shop=False)
        await interaction.response.send_message(embeds=[embed], ephemeral=True)

    # ------------------------------------------------------------ version add

    @version.command(name="add", description="Add a version (e.g. 12 Months) to a product")
    @app_commands.describe(
        product="Product id",
        label="Version name, e.g. 12 Months",
        price="Price in credits",
        stock="Starting stock (leave empty for unlimited)",
    )
    async def version_add(
        self,
        interaction: discord.Interaction,
        product: str,
        label: str,
        price: int,
        stock: int | None = None,
    ):
        if not await _guard(interaction):
            return
        if price < 0 or (stock is not None and stock < 0):
            await interaction.response.send_message("Price and stock can't be negative.", ephemeral=True)
            return
        try:
            value = db.add_version(product.strip().lower(), label, price, stock)
        except ValueError as err:
            await interaction.response.send_message(str(err), ephemeral=True)
            return
        embed = embeds.branded_embed(
            title="Version added",
            description=f"**{label}** on `{product}` — {price} credits ({_stock_text(stock)}).",
            hero=False,
            shop=False,
        )
        await interaction.response.send_message(embeds=[embed], ephemeral=True)

    # ----------------------------------------------------------- version edit

    @version.command(name="edit", description="Change a version's price, stock, label or delivery text")
    @app_commands.describe(
        product="Product id",
        label="Which version (its current name)",
        new_label="Rename it",
        price="New price in credits",
        stock="Set stock to this number",
        unlimited="True = never runs out (clears stock)",
        content="Delivery text sent on purchase",
    )
    async def version_edit(
        self,
        interaction: discord.Interaction,
        product: str,
        label: str,
        new_label: str | None = None,
        price: int | None = None,
        stock: int | None = None,
        unlimited: bool | None = None,
        content: str | None = None,
    ):
        if not await _guard(interaction):
            return
        p = db.get_product(product.strip().lower())
        if p is None:
            await interaction.response.send_message("No such product.", ephemeral=True)
            return
        match = next((v for v in p["versions"] if v["label"].lower() == label.lower()), None)
        if match is None:
            await interaction.response.send_message(f"`{product}` has no version called `{label}`.", ephemeral=True)
            return
        if price is not None and price < 0:
            await interaction.response.send_message("Price can't be negative.", ephemeral=True)
            return
        if stock is not None and stock < 0:
            await interaction.response.send_message("Stock can't be negative.", ephemeral=True)
            return
        if new_label and new_label.lower() != match["label"].lower():
            if any(v["label"].lower() == new_label.lower() for v in p["versions"]):
                await interaction.response.send_message("That label is already taken on this product.", ephemeral=True)
                return
        try:
            kwargs: dict = {}
            if new_label:
                kwargs["label"] = new_label
            if price is not None:
                kwargs["price"] = price
            if unlimited:
                kwargs["stock"] = None  # clears to unlimited
            elif stock is not None:
                kwargs["stock"] = stock
            if content is not None:
                kwargs["content"] = content
            db.update_version(match["value"], **kwargs)
        except ValueError as err:
            await interaction.response.send_message(str(err), ephemeral=True)
            return
        _, updated = db.find_version(match["value"])
        embed = embeds.branded_embed(
            title="Version updated",
            description=_version_line(updated),
            hero=False,
            shop=False,
        )
        await interaction.response.send_message(embeds=[embed], ephemeral=True)

    # --------------------------------------------------------- version remove

    @version.command(name="remove", description="Delete one version from a product")
    @app_commands.describe(product="Product id", label="Which version", confirm="Must be True - no undo")
    async def version_remove(
        self, interaction: discord.Interaction, product: str, label: str, confirm: bool = False
    ):
        if not await _guard(interaction):
            return
        if not confirm:
            await interaction.response.send_message("Pass `confirm: True` - this cannot be undone.", ephemeral=True)
            return
        p = db.get_product(product.strip().lower())
        if p is None:
            await interaction.response.send_message("No such product.", ephemeral=True)
            return
        match = next((v for v in p["versions"] if v["label"].lower() == label.lower()), None)
        if match is None:
            await interaction.response.send_message(f"`{product}` has no version called `{label}`.", ephemeral=True)
            return
        try:
            db.delete_version(match["value"])
        except ValueError as err:
            await interaction.response.send_message(str(err), ephemeral=True)
            return
        embed = embeds.branded_embed(
            title="Version removed", description=f"**{label}** is gone from `{product}`.", hero=False, shop=False
        )
        await interaction.response.send_message(embeds=[embed], ephemeral=True)


async def setup(bot: commands.Bot):
    await bot.add_cog(AdminCog(bot))
