"""Role/ID configuration.

Server-specific IDs are read from .env so the same code runs on any guild.
"""

from __future__ import annotations

import os

import discord

INF_ROLE_ID = os.getenv("INF_ROLE_ID", "")
SHOPPER_ROLE_ID = os.getenv("SHOPPER_ROLE_ID", "")
ADMIN_USER_IDS = [uid.strip() for uid in os.getenv("ADMIN_USER_IDS", "").split(",") if uid.strip()]
OWNER_USER_ID = os.getenv("OWNER_USER_ID", "")


def is_owner(user_id) -> bool:
    """True for the bot's owner (OWNER_USER_ID) and the admin user IDs."""
    try:
        uid = int(user_id)
    except (TypeError, ValueError):
        return False
    ids = set(ADMIN_USER_IDS)
    if OWNER_USER_ID:
        ids.add(int(OWNER_USER_ID))
    return uid in ids

BASE_ROLE_ID = os.getenv("BASE_ROLE_ID", "")
BASE_ROLE_NAME = os.getenv("BASE_ROLE_NAME", "Member")

EMOJI_SHOPPER = os.getenv("ROLE_EMOJI_SHOPPER", "1️⃣")
EMOJI_RESELLER = os.getenv("ROLE_EMOJI_RESELLER", "2️⃣")


def is_staff(member: discord.Member | None) -> bool:
    """True for the INF role holders and the hard-coded admin user IDs."""
    if member is None:
        return False
    if member.id in ADMIN_USER_IDS:
        return True
    if INF_ROLE_ID:
        return member.get_role(int(INF_ROLE_ID)) is not None
    return member.guild_permissions.administrator


def resolve_role(guild: discord.Guild, key: str):
    """Resolve a picker role by ID first, then by name (case-insensitive)."""
    known = {"shopper": SHOPPER_ROLE_ID}
    role_id = known.get(key, "")
    if role_id:
        role = guild.get_role(int(role_id))
        if role:
            return role
    return discord.utils.get(guild.roles, name=key) or discord.utils.find(
        lambda r: r.name.lower() == key.lower(), guild.roles
    )