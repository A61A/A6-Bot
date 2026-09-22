"""Orders cog: DM keyword handler + /orders slash command for purchase history (fetches from website API)."""

from __future__ import annotations

import aiohttp
import discord
from discord.ext import commands
from discord import app_commands

from config import embeds

ORDERS_PER_PAGE = 8
SITE_BASE_URL = "https://a6hub.cc"  # Your website URL


async def fetch_orders(session: aiohttp.ClientSession, discord_id: int) -> dict:
    """Fetch orders from website API by Discord ID."""
    url = f"{SITE_BASE_URL}/api/bot/orders?discord_id={discord_id}"
    async with session.get(url) as resp:
        if resp.status == 404:
            return {"ok": False, "reason": "not_linked"}
        if resp.status != 200:
            return {"ok": False, "reason": "api_error"}
        return await resp.json()


def build_orders_embed(username: str, purchases: list, page: int = 1):
    """Build the orders embed with pagination."""
    if not purchases:
        embed = discord.Embed(
            color=0x2A2D3D,
            title="📦 All Orders",
            description=f"**{username}** has no purchases yet. Buy something from the catalog and it'll appear here.",
        )
        embed.set_footer(text="Nodeline · updated live")
        return embed, None, 0, 0

    pages = max(1, (len(purchases) + 7) // 8)
    page = max(1, min(page, pages))
    start = (page - 1) * 8
    end = start + 8
    visible = purchases[start:end]

    lines = []
    for p in visible:
        product_label = p.get("product_label") or p.get("product_key", "Product").replace("_", " ").title()
        version_label = p.get("version_label") or p.get("version_value", "").replace("_", " ").title()
        price = p.get("price", 0)
        qty = p.get("qty", 1)
        ts = p.get("purchased_at", 0)
        from datetime import datetime
        date_str = ""
        if ts:
            date_str = datetime.fromtimestamp(ts / 1000).strftime("%b %d, %Y")
        lines.append(f"📦 **{product_label}** · {version_label}\n    💵 **{price} credits** · `{qty}x` · {date_str}")

    embed = discord.Embed(
        color=0x8B5CF6,
        title="📦 All Orders",
        description=f"**{len(purchases)} order{'s' if len(purchases) != 1 else ''}** for **{purchases[0].get('username', 'User')}**\n\n" + "\n\n".join(lines),
    )
    embed.set_footer(text=f"Page {page} of {pages} · updated live")

    if len(purchases) > 8:
        view = discord.ui.View(timeout=600)
        prev_btn = discord.ui.Button(
            label="◀ Prev",
            style=discord.ButtonStyle.secondary,
            custom_id=f"orders:page:{page - 1}",
            disabled=page <= 1,
        )
        next_btn = discord.ui.Button(
            label="Next ▶",
            style=discord.ButtonStyle.secondary,
            custom_id=f"orders:page:{page + 1}",
            disabled=page >= (len(purchases) + 7) // 8,
        )
        view.add_item(prev_btn)
        view.add_item(next_btn)
        return embed, view, page, (len(purchases) + 7) // 8

    return discord.Embed(
        color=0x8B5CF6,
        title="📦 All Orders",
        description="Error: no purchases found",
    ), None, 0, 0


class OrdersCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        self.session = aiohttp.ClientSession()

    def cog_unload(self):
        self.bot.loop.create_task(self.session.close())

    @app_commands.command(name="orders", description="View your purchase history")
    @app_commands.describe(page="Page number (optional)")
    async def orders(self, interaction: discord.Interaction, page: int = 1):
        """Slash command: /orders [page]"""
        await interaction.response.defer(ephemeral=True)
        async with aiohttp.ClientSession() as session:
            data = await fetch_orders(session, interaction.user.id)
        if not data.get("ok"):
            if data.get("reason") == "not_linked":
                await interaction.followup.send(
                    "Your Discord isn't linked to a website account. Link it on the website first.",
                    ephemeral=True,
                )
            else:
                await interaction.followup.send("Could not fetch orders.", ephemeral=True)
            return
        embed, view, _, _ = build_orders_embed(data["username"], data["purchases"], page)
        await interaction.followup.send(embed=embed, view=view, ephemeral=True)

    @commands.Cog.listener()
    async def on_message(self, message: discord.Message):
        if message.author.bot:
            return
        if not isinstance(message.channel, discord.DMChannel):
            return

        text = (message.content or "").strip().lower()
        if text not in ("orders", "order", "my orders", "all orders"):
            return

        async with aiohttp.ClientSession() as session:
            data = await fetch_orders(session, message.author.id)
        if not data.get("ok"):
            if data.get("reason") == "not_linked":
                await message.channel.send(
                    "Your Discord isn't linked to a website account. Link it on the website first."
                )
            else:
                await message.channel.send("Could not fetch orders.")
            return

        embed, view, _, _ = build_orders_embed(data["username"], data["purchases"], 1)
        await message.channel.send(embed=embed, view=None if not data["purchases"] else None)


@router.button("orders:page")
async def orders_page(interaction: discord.Interaction, rest: list[str]):
    if not rest:
        return
    try:
        page = int(rest[0])
    except ValueError:
        return
    async with aiohttp.ClientSession() as session:
        data = await fetch_orders(session, interaction.user.id)
    if not data.get("ok"):
        await interaction.response.send_message("Could not load that page.", ephemeral=True)
        return
    embed, view, _, _ = build_orders_embed(data["username"], data["purchases"], int(rest[0]))
    await interaction.response.edit_message(embed=embed, view=view)


async def setup(bot: commands.Bot):
    await bot.add_cog(OrdersCog(bot))