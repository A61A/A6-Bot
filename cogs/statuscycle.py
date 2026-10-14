"""Cycles the bot's presence (activity) through the store's promo lines.

Replaces the BetterDiscord AnimatedStatus plugin: same rotating text, but
hosted on the bot account so it runs 24/7 from Railway.

Env vars (all optional):
    STATUS_ENABLED   true/false (default true)
    STATUS_INTERVAL  seconds per step, min 5 (default 10)
    STATUS_PRESENCE  online / idle / dnd / invisible (default dnd)
    STATUS_STEPS     ";"-separated lines (default: the A6 promo set below)
"""

from __future__ import annotations

import os

import discord
from discord.ext import commands, tasks

DEFAULT_STEPS = [
    ".gg/a6s",
    "t.me/a61ahub",
    "Lifetime Netflix",
    "a6hub.cc",
    "FREE Acc Gen!",
    "TikTok [4c/4L]",
    "Nitro Links + Codes",
    "Spotify Premium",
    "Server Boosts",
]

_PRESENCES = {
    "online": discord.Status.online,
    "idle": discord.Status.idle,
    "dnd": discord.Status.dnd,
    "invisible": discord.Status.invisible,
}


class StatusCycleCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        raw_steps = os.getenv("STATUS_STEPS", "")
        self.steps = [s.strip() for s in raw_steps.split(";") if s.strip()] or list(DEFAULT_STEPS)
        try:
            self.interval = max(5, int(os.getenv("STATUS_INTERVAL", "10")))
        except ValueError:
            self.interval = 10
        self.presence_status = _PRESENCES.get(
            os.getenv("STATUS_PRESENCE", "dnd").strip().lower(), discord.Status.dnd
        )
        self._index = 0
        self._cycle = tasks.loop(seconds=self.interval, reconnect=5)(self._run)
        self._cycle.before_loop(self._before_loop)
        if os.getenv("STATUS_ENABLED", "true").strip().lower() in ("0", "false", "no", "off"):
            print("[statuscycle] disabled via STATUS_ENABLED")
            return
        print(f"[statuscycle] cycling {len(self.steps)} steps every {self.interval}s")
        self._cycle.start()

    async def _before_loop(self):
        await self.bot.wait_until_ready()

    async def _run(self):
        if not self.steps:
            return
        text = self.steps[self._index % len(self.steps)]
        self._index += 1
        try:
            await self.bot.change_presence(
                status=self.presence_status,
                activity=discord.Activity(type=discord.ActivityType.watching, name=text),
            )
        except Exception as err:
            print(f"[statuscycle] presence update failed: {err}")

    def cog_unload(self):
        self._cycle.cancel()


async def setup(bot: commands.Bot):
    await bot.add_cog(StatusCycleCog(bot))
