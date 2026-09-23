"""Channel configuration.

Every feature that posts to a specific channel reads from here instead of
hardcoding an ID inline. Add a new env var + a new key whenever a feature
needs its own channel.
"""

from __future__ import annotations

import os

import discord


CHANNELS = {
    "welcome": os.getenv("WELCOME_CHANNEL_ID"),
    "roleSelect": os.getenv("ROLE_SELECT_CHANNEL_ID"),
    "announcements": os.getenv("ANNOUNCEMENTS_CHANNEL_ID"),
    "modLog": os.getenv("MOD_LOG_CHANNEL_ID"),
    "kiosk": os.getenv("KIOSK_CHANNEL_ID"),
}

SUPPORT_CATEGORY_ID = os.getenv("SUPPORT_CATEGORY_ID")


async def get_channel(client: discord.Client | discord.Bot, key: str) -> discord.TextChannel | None:
    """Fetch one of the configured channels, logging a warning if unset."""
    channel_id = CHANNELS.get(key)
    if not channel_id:
        print(f'[channels] No channel ID configured for "{key}" - check your .env')
        return None
    try:
        return await client.fetch_channel(channel_id)
    except discord.DiscordException as err:
        print(f'[channels] Could not fetch "{key}" ({channel_id}): {err}')
        return None