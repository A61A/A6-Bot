"""Store management dashboard.

/admin — shows an embed with buttons for product and version management.
All operations read straight from the DB, so changes apply instantly — no restart,
no re-post. Stock is per version: a number, or unlimited.
"""

from __future__ import annotations

import discord
from discord import app_commands
from discord.ext import commands
from discord.ui import View, button

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


class AdminDashboardView(View):
    """Embed + button dashboard for /admin."""

    def __init__(self):
        super().__init__(timeout=180.0)

    @button(label="List Products", style=discord.ButtonStyle.primary, custom_id="admin:list_products")
    async def list_products(self, interaction: discord.Interaction, button: discord.Button):
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
        await interaction.response.edit_message(embeds=[embed], view=self)

    @button(label="Add Product", style=discord.ButtonStyle.success, custom_id="admin:add_product")
    async def add_product(self, interaction: discord.Interaction, button: discord.Button):
        if not await _guard(interaction):
            return
        await interaction.response.send_message("Use `/admin product add` in chat to add a product.", ephemeral=True)

    @button(label="Remove Product", style=discord.ButtonStyle.danger, custom_id="admin:remove_product")
    async def remove_product(self, interaction: discord.Interaction, button: discord.Button):
        if not await _guard(interaction):
            return
        await interaction.response.send_message("Use `/admin product remove` in chat to remove a product.", ephemeral=True)

    @button(label="List Versions", style=discord.ButtonStyle.primary, custom_id="admin:list_versions")
    async def list_versions(self, interaction: discord.Interaction, button: discord.Button):
        if not await _guard(interaction):
            return
        products = db.list_products(include_hidden=True)
        if not products:
            await interaction.response.send_message("No products to show versions for.", ephemeral=True)
            return
        # Show first product's versions as an example
        p = products[0]
        body = "\n".join(_version_line(v) for v in p["versions"]) or "No versions."
        embed = embeds.branded_embed(
            title=f"Versions — {p['label']} (`{p['key']}`)",
            description=body,
            hero=False,
            shop=False,
        )
        await interaction.response.edit_message(embeds=[embed], view=self)

    @button(label="Add Version", style=discord.ButtonStyle.success, custom_id="admin:add_version")
    async def add_version(self, interaction: discord.Interaction, button: discord.Button):
        if not await _guard(interaction):
            return
        await interaction.response.send_message("Use `/admin version add` in chat to add a version.", ephemeral=True)

    @button(label="Remove Version", style=discord.ButtonStyle.danger, custom_id="admin:remove_version")
    async def remove_version(self, interaction: discord.Interaction, button: discord.Button):
        if not await _guard(interaction):
            return
        await interaction.response.send_message("Use `/admin version remove` in chat to remove a version.", ephemeral=True)

    @button(label="Check Stock", style=discord.ButtonStyle.secondary, custom_id="admin:check_stock")
    async def check_stock(self, interaction: discord.Interaction, button: discord.Button):
        if not await _guard(interaction):
            return
        products = db.list_products(include_hidden=True)
        if not products:
            await interaction.response.send_message("The catalog is empty.", ephemeral=True)
            return
        fields = []
        for p in products[:5]:
            vs = "\n".join(_version_line(v) for v in p["versions"])
            fields.append((f"{p.get('emoji', '')} {p['label']}", vs, False))
        embed = embeds.branded_embed(title="Stock Overview", fields=fields, hero=False, shop=False)
        await interaction.response.edit_message(embeds=[embed], view=self)


class AdminCog(commands.Cog):
    """Owner-only /admin command — dashboard embed with buttons."""

    def __init__(self, bot: commands.Bot):
        self.bot = bot

    @app_commands.command(name="admin", description="Store management dashboard")
    async def admin(self, interaction: discord.Interaction):
        if not await _guard(interaction):
            return
        view = AdminDashboardView()
        embed = embeds.branded_embed(
            title="Store Management",
            description="Click a button below to manage the catalog:",
            hero=False,
            shop=False,
        )
        # Add field for quick info
        products = db.list_products(include_hidden=True)
        embed.add_field(
            name="Products in catalog",
            value=f"{len(products)} product(s) — use buttons above or `/admin product list` in chat",
            inline=False,
        )
        await interaction.response.send_message(embeds=[embed], view=view, ephemeral=True)


async def setup(bot: commands.Bot):
    await bot.add_cog(AdminCog(bot))