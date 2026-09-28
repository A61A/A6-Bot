"""Support tickets: a "DM relay" chat.

The customer talks to the bot in their DMs; a visible ticket channel in the
server mirrors both sides. The AI replies in the customer's DM, an admin can
toggle the AI off and chat as a human, and tickets auto-close after 24h of
inactivity.
"""

from __future__ import annotations

import os

import discord

from config import channels as channels_cfg
from config.roles import ADMIN_USER_IDS, INF_ROLE_ID
from lib import db

TICKET_TTL_MS = 24 * 60 * 60 * 1000  # 24h of inactivity

# In-memory timers for auto-close (mirrors A7's timer management)
_timers: dict[int, int] = {}


async def create_chat_ticket(client: discord.Client, user: discord.User, dm_channel: discord.DMChannel) -> dict:
    """Create the ticket row + the mirrored #ticket-xxx channel in the server."""
    guild_id = os.getenv("GUILD_ID")
    guild = client.get_guild(int(guild_id)) if guild_id else None
    if guild is None and guild_id:
        try:
            guild = await client.fetch_guild(int(guild_id))
        except discord.DiscordException as err:
            raise RuntimeError(f"Could not find the server ({guild_id}): {err}")

    if guild is None:
        # No server configured yet - fall back to a pure DM chat (no mirror).
        ticket = db.open_ticket(user.id, "dm", str(dm_channel.id))
        return {"ticket": ticket, "channel": None, "guild": None}

    category = None
    if channels_cfg.SUPPORT_CATEGORY_ID:
        category = guild.get_channel(int(channels_cfg.SUPPORT_CATEGORY_ID))
    if category is None:
        category = discord.utils.get(guild.categories, name="Support-Inbox")
    if category is None:
        category = await guild.create_category("Support-Inbox")

    ticket = db.open_ticket(user.id, "dm-ai", str(dm_channel.id))

    overwrites = {
        guild.default_role: discord.PermissionOverwrite(read_messages=False),
    }
    member = guild.get_member(user.id)
    if member:
        overwrites[member] = discord.PermissionOverwrite(read_messages=True, send_messages=True, read_message_history=True)
    if INF_ROLE_ID:
        role = guild.get_role(int(INF_ROLE_ID))
        if role:
            overwrites[role] = discord.PermissionOverwrite(read_messages=True, send_messages=True, read_message_history=True, manage_channels=True)
    for uid in ADMIN_USER_IDS:
        admin = guild.get_member(int(uid))
        if admin:
            overwrites[admin] = discord.PermissionOverwrite(read_messages=True, send_messages=True, read_message_history=True, manage_channels=True)

    short = "".join(ch for ch in (user.name or "user").lower() if ch.isalnum())[:20] or "user"
    ticket_channel = await guild.create_text_channel(
        name=f"ticket-{short}-{ticket['id']}",
        category=category,
        overwrites=overwrites,
    )
    db.set_ticket_meta(ticket["id"], channel_id=str(ticket_channel.id), admin_channel_id=str(ticket_channel.id))
    return {"ticket": db.get_ticket(ticket["id"]), "channel": ticket_channel, "guild": guild}


# In-memory timers for auto-close (mirrors A7's timer management)
_timers: dict[int, int] = {}


def get_timer(ticket_id: int) -> int | None:
    return _timers.get(ticket_id)


def schedule_auto_close(client, ticket, ttl: int = TICKET_TTL_MS) -> None:
    existing = _timers.get(ticket["id"])
    if existing:
        existing.cancel()

    async def _auto_close():
        _timers.pop(ticket["id"], None)
        await auto_close_ticket(client, ticket, "Auto-closed after 24h of inactivity")

    timer = client.loop.call_later(ttl / 1000, lambda: client.loop.create_task(_auto_close()))
    _timers[ticket["id"]] = timer


async def auto_close_ticket(client, ticket, reason: str) -> None:
    db.close_ticket(ticket["id"])
    # Channel cleanup and user notification would go here
    # Placeholder for channel cleanup / user notification logic


def reschedule_open_tickets(client) -> None:
    for ticket in db.get_open_tickets():
        elapsed = db.now_ms() - ticket["last_message"]
        remaining = TICKET_TTL_MS - elapsed
        if remaining <= 0:
            # Fire immediately
            client.loop.create_task(auto_close_ticket(client, ticket, "Auto-closed after 24h of inactivity"))
        else:
            schedule_auto_close(client, ticket, remaining)