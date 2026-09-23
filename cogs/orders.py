"""Orders cog: DM keyword handler + /orders slash command for purchase history (fetches from website API by username)."""

from __future__ import annotations

import aiohttp
import discord
from discord.ext import commands
from discord import app_commands

from cogs import router
from config import embeds

ORDERS_PER_PAGE = 5
SITE_BASE_URL = "https://a6hub.cc"

# Custom emojis (box/money/key) so the embed matches the brand instead of stock.
EMOJI_BOX = "<:dvdsv:1551337344462757970>"
EMOJI_MONEY = "<a:v2_cart:1550345635646152744>"
EMOJI_KEY = "<:Symbol_Right_Arrow:1551337342097432576>"

# Last purchases rendered per user so pagination buttons can rebuild pages
# without refetching (also guards against stale buttons after a restart).
_RENDER_CACHE: dict[int, list] = {}


async def fetch_orders_by_username(session: aiohttp.ClientSession, username: str) -> dict:
    """Fetch orders from website API by username."""
    url = f"https://a6hub.cc/api/bot/orders?username={username}"
    async with session.get(url) as resp:
        if resp.status == 404:
            return {"ok": False, "reason": "not_found"}
        if resp.status != 200:
            return {"ok": False, "reason": "api_error"}
        return await resp.json()


def resolve_emoji(bot: commands.Bot, emoji_id: int) -> str | None:
    """Return the exact `<a:name:id>` markup for a custom emoji known to the bot.

    Names are matched by ID at render time, so a rename (or a wrong guess in
    the constants below) can never leave a dangling markup in the embed.
    """
    emoji = bot.get_emoji(emoji_id)
    if emoji is None:
        return None
    prefix = "a" if emoji.animated else ""
    return f"<{prefix}:{emoji.name}:{emoji.id}>"


def emoji_debug_line(bot: commands.Bot) -> str:
    """Report what the bot actually knows about the three brand emoji IDs."""
    out = []
    for label, eid in (("box", 1551337344462757970), ("money", 1550345635646152744), ("arrow", 1551337342097432576)):
        emoji = bot.get_emoji(eid)
        if emoji is None:
            out.append(f"- {label} ({eid}): NOT FOUND on this bot")
        else:
            prefix = "a" if emoji.animated else ""
            out.append(f"- {label} ({eid}): <{prefix}:{emoji.name}:{emoji.id}>")
    return "\n".join(out)


def build_orders_embed(
    purchases: list,
    page: int = 1,
    emoji_box: str = EMOJI_BOX,
    emoji_money: str = EMOJI_MONEY,
    emoji_key: str = EMOJI_KEY,
):
    """Build the orders embed with pagination."""
    if not purchases:
        embed = discord.Embed(
            color=0x2A2D3D,
title=f"{emoji_box} All Orders",
            description="No purchases yet. Buy something from the catalog and it'll appear here.",
        )
        embed.set_footer(text="A6 - Custom Bot? DM Me! · updated live")
        return embed, None

    items_per_page = 5
    pages = max(1, (len(purchases) + items_per_page - 1) // items_per_page)
    page = max(1, min(page, pages))
    start = (page - 1) * items_per_page
    end = start + items_per_page
    visible = purchases[start:end]

    blocks = []
    for i, p in enumerate(visible):
        product_label = p.get("product_label") or p.get("product_key", "Product").replace("_", " ").title()
        version_label = p.get("version_label") or p.get("version_value", "").replace("_", " ").title()

        # Delivery content (keys/downloads) — new API sends `delivered` as a list
        # of {content, sold_at} objects; old API sent a plain string list under
        # `delivery_content`. Accept both so the embed renders regardless.
        raw = p.get("delivered", None)
        if raw is None:
            raw = p.get("delivery_content", [])
        keys = []
        for c in raw:
            if isinstance(c, dict):
                if c.get("content"):
                    keys.append(str(c["content"]))
            elif c:
                keys.append(str(c))
        # Keep long key lines (e.g. "pastebin | Pass: ...") within the embed width.
        keys = [f"{k[:120]}{'…' if len(k) > 120 else ''}" for k in keys]

        price = p.get("price", 0)
        qty = p.get("qty", 1)
        ts = p.get("purchased_at", 0)
        from datetime import datetime
        date_str = ""
        if ts:
            date_str = datetime.fromtimestamp(ts / 1000).strftime("%b %d, %Y")

        block = [f"{emoji_box} **{product_label}** · {version_label}"]
        block.append(f"    {emoji_money} **{price} credits** · `{qty}x` · {date_str}")
        for k in keys:
            block.append(f"    {emoji_key} `{k}`")
        blocks.append("\n".join(block))

    embed = discord.Embed(
        color=0x8B5CF6,
title=f"{emoji_box} All Orders",
        description=f"**{len(blocks)} order{'s' if len(blocks) != 1 else ''}**\n\n" + "\n\n".join(blocks),
    )
    embed.set_footer(text=f"Page {page} of {pages} · updated live")
    print(f"[build] Final embed description length: {len(embed.description)} chars")
    print(f"[build] Orders per page: 5 · pages: {pages}")

    view = None
    if pages > 1:
        view = discord.ui.View(timeout=600)
        prev_btn = router.RouterButton(
            custom_id=f"orders:page:{page - 1}",
            label="◀ Prev",
            style=discord.ButtonStyle.secondary,
            disabled=page <= 1,
        )
        next_btn = router.RouterButton(
            custom_id=f"orders:page:{page + 1}",
            label="Next ▶",
            style=discord.ButtonStyle.secondary,
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
        embed, view = build_orders_embed(
            data["purchases"], 1,
            emoji_box=resolve_emoji(self.bot, 1551337344462757970) or EMOJI_BOX,
            emoji_money=resolve_emoji(self.bot, 1550345635646152744) or EMOJI_MONEY,
            emoji_key=resolve_emoji(self.bot, 1551337342097432576) or EMOJI_KEY,
        )
        _RENDER_CACHE[interaction.user.id] = data["purchases"]
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
        if first_word == "emoji-debug":
            await message.channel.send(
                f"{len(self.bot.emojis)} emojis visible to the bot.\n{emoji_debug_line(self.bot)}"
            )
            return
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
            embed, view = build_orders_embed(
            data["purchases"], 1,
            emoji_box=resolve_emoji(self.bot, 1551337344462757970) or EMOJI_BOX,
            emoji_money=resolve_emoji(self.bot, 1550345635646152744) or EMOJI_MONEY,
            emoji_key=resolve_emoji(self.bot, 1551337342097432576) or EMOJI_KEY,
        )
            _RENDER_CACHE[message.author.id] = data["purchases"]
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
        await interaction.response.send_message("Use `/orders <username>` to view your order history.", ephemeral=True)
        return
    try:
        page = int(rest[0])
    except ValueError:
        await interaction.response.send_message("That page is invalid — run `/orders <username>` again.", ephemeral=True)
        return

    data = _RENDER_CACHE.get(interaction.user.id)
    if not data:
        await interaction.response.send_message(
            "That message is stale (or the bot restarted). Use `/orders <username>` to get a fresh list.",
            ephemeral=True,
        )
        return

    embed, view = build_orders_embed(
        data, page,
        emoji_box=resolve_emoji(interaction.client, 1551337344462757970) or EMOJI_BOX,
        emoji_money=resolve_emoji(interaction.client, 1550345635646152744) or EMOJI_MONEY,
        emoji_key=resolve_emoji(interaction.client, 1551337342097432576) or EMOJI_KEY,
    )

    # Edit in place so pagination feels instant for both /orders (ephemeral)
    # and DM embeds. Deferring first keeps us inside the 3s interaction window.
    try:
        await interaction.response.defer()
        await interaction.message.edit(embed=embed, view=view)
    except discord.NotFound:
        await interaction.followup.send(embed=embed, view=view, ephemeral=True)
    except discord.HTTPException:
        await interaction.followup.send(
            "Could not update that page — run `/orders <username>` again.", ephemeral=True
        )


async def setup(bot: commands.Bot):
    await bot.add_cog(OrdersCog(bot))