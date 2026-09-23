"""Orders cog: DM keyword handler + /orders slash command for purchase history (fetches from website API by username)."""

from __future__ import annotations

import aiohttp
import discord
from discord.ext import commands
from discord import app_commands

from cogs import router
from config import embeds

ORDERS_PER_PAGE = 8
SITE_BASE_URL = "https://a6hub.cc"


async def fetch_orders_by_username(session: aiohttp.ClientSession, username: str) -> dict:
    """Fetch orders from website API by username."""
    url = f"https://a6hub.cc/api/bot/orders?username={username}"
    async with session.get(url) as resp:
        if resp.status == 404:
            return {"ok": False, "reason": "not_found"}
        if resp.status != 200:
            return {"ok": False, "reason": "api_error"}
        return await resp.json()


def build_orders_embed(purchases: list, page: int = 1):
    """Build the orders embed with pagination."""
    if not purchases:
        embed = discord.Embed(
            color=0x2A2D3D,
            title="📦 All Orders",
            description="No purchases yet. Buy something from the catalog and it'll appear here.",
        )
        embed.set_footer(text="A6 - Custom Bot? DM Me! · updated live")
        return embed, None

    pages = max(1, (len(purchases) + 7) // 8)
    page = max(1, min(page, pages))
    start = (page - 1) * 8
    end = start + 8
    visible = purchases[start:end]

    lines = []
    for i, p in enumerate(visible):
        product_label = p.get("product_label") or p.get("product_key", "Product").replace("_", " ").title()
        version_label = p.get("version_label") or p.get("version_value", "").replace("_", " ").title()
        price = p.get("price", 0)
        qty = p.get("qty", 1)
        ts = p.get("purchased_at", 0)
        from datetime import datetime
        date_str = ""
        if ts:
            date_str = datetime.fromtimestamp(ts / 1000).strftime("%b %d, %Y")
        
        print(f"[build] Purchase {i+1}: {p.get('product_key')} - {p.get('version_value')} - delivery: {p.get('delivery_content', [])}")
        
        # Main order line
        lines.append(f"📦 **{product_label}** · {version_label}\n    💵 **{price} credits** · `{qty}x` · {date_str}")
        
        # Delivery content (keys/downloads) — new API sends `delivered` as a list
        # of {content, sold_at} objects; old API sent a plain string list under
        # `delivery_content`. Accept both so the embed renders regardless.
        raw_delivery = p.get("delivered", None)
        if raw_delivery is None:
            raw_delivery = p.get("delivery_content", [])

        delivery_content = []
        for c in raw_delivery:
            if isinstance(c, dict):
                if c.get("content"):
                    delivery_content.append(c["content"])
            elif c:
                delivery_content.append(c)

        print(f"[build] Delivery content for {p.get('product_key')}: {delivery_content}")
        for content in delivery_content:
            lines.append(f"    🔑 `{content}`")

    embed = discord.Embed(
        color=0x8B5CF6,
        title="📦 All Orders",
        description=f"**{len(purchases)} order{'s' if len(purchases) != 1 else ''}**\n\n" + "\n\n".join(lines),
    )
    embed.set_footer(text=f"Page {page} of {pages} · updated live")
    print(f"[build] Final embed description length: {len(embed.description)} chars")
    print(f"[build] Lines count: {len(lines)}")
    for i, line in enumerate(lines):
        print(f"  Line {i}: {line[:100]}")
    print(f"[build] Final embed description length: {len(embed.description)} chars")
    print(f"[build] Lines count: {len(lines)}")
    for i, line in enumerate(lines):
        print(f"  Line {i}: {line[:100]}")

    view = None
    if pages > 1:
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
            disabled=page >= pages,
        )
        view.add_item(prev_btn)
        view.add_item(next_btn)

    return embed, view


class OrdersCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        print("[ORDERS] Cog loaded!")

    @app_commands.command(name="orders", description="View purchase history by website username")
    @app_commands.describe(username="Website username")
    async def orders(self, interaction: discord.Interaction, username: str):
        """Slash command: /orders <username>"""
        await interaction.response.defer(ephemeral=True)
        async with aiohttp.ClientSession() as session:
            data = await self.fetch_orders(session, username)
        if not data.get("ok"):
            if data.get("reason") == "not_found":
                await interaction.followup.send("Username not found.", ephemeral=True)
            else:
                await interaction.followup.send("Could not fetch orders.", ephemeral=True)
            return
        embed, view = build_orders_embed(data["purchases"], 1)
        await interaction.followup.send(embed=embed, view=view, ephemeral=True)

    @commands.Cog.listener()
    async def on_message(self, message: discord.Message):
        print(f"[ORDERS] on_message received: '{message.content}' from {message.author} (bot={message.author.bot}) channel={type(message.channel).__name__} guild={message.guild}")
        if message.author.bot:
            return
        if not isinstance(message.channel, discord.DMChannel):
            print(f"[orders] Not DM channel, skipping (channel type: {type(message.channel).__name__})")
            return

        text = (message.content or "").strip()
        parts = text.split()
        if not parts:
            print(f"[orders] Empty message")
            return

        first_word = parts[0].lower()
        print(f"[orders] First word: '{first_word}'")
        if first_word in ("orders", "order", "my orders", "all orders"):
            print(f"[orders] Keyword matched!")
            if len(parts) >= 2:
                username = parts[1]
            else:
                await message.channel.send(
                    "Use `orders <your_website_username>` to see your order history."
                )
                return

            async with aiohttp.ClientSession() as session:
                data = await self.fetch_orders(session, username)
            print(f"[orders] API response: {data}")
            if not data.get("ok"):
                if data.get("reason") == "not_found":
                    await message.channel.send("Username not found.")
                else:
                    await message.channel.send("Could not fetch orders.")
                return
            embed, view = build_orders_embed(data["purchases"], 1)
            print(f"[orders] Sending embed with {len(data['purchases'])} purchases")
            await message.channel.send(embed=embed, view=view)
            print(f"[orders] Embed sent successfully")

    async def fetch_orders(self, session: aiohttp.ClientSession, username: str) -> dict:
        """Fetch orders from website API by username."""
        url = f"https://a6hub.cc/api/bot/orders?username={username}"
        async with session.get(url) as resp:
            if resp.status == 404:
                return {"ok": False, "reason": "not_found"}
            if resp.status != 200:
                return {"ok": False, "reason": "api_error"}
            return await resp.json()


@router.button("orders:page")
async def orders_page(interaction: discord.Interaction, rest: list[str]):
    if not rest:
        return
    try:
        page = int(rest[0])
    except ValueError:
        return
    await interaction.response.send_message("Use `/orders <username>` to view orders.", ephemeral=True)


async def setup(bot: commands.Bot):
    await bot.add_cog(OrdersCog(bot))