"""A6 store bot — Python entry point.

Run start.cmd (or: py -3.12 -m venv .venv && .venv\\Scripts\\activate && pip
install -r requirements.txt && python bot.py).
"""

from __future__ import annotations

import logging
import os

import discord
from discord.ext import commands

logging.basicConfig(level=logging.INFO)

from dotenv import load_dotenv  # noqa: E402

load_dotenv()

TOKEN = os.getenv("DISCORD_TOKEN", "")
GUILD_ID = os.getenv("GUILD_ID")

intents = discord.Intents.default()
intents.message_content = True
intents.members = True
intents.dm_messages = True

bot = commands.Bot(command_prefix="!", intents=intents)


@bot.event
async def on_ready():
    print(f"[nodeline] logged in as {bot.user} (id {bot.user.id})")
    print(f"[nodeline] Loaded cogs: {list(bot.cogs.keys())}")
    try:
        synced = await bot.tree.sync()
        print(f"[nodeline] synced {len(synced)} slash commands")
    except discord.DiscordException as err:
        print(f"[nodeline] command sync failed: {err}")
    await bot.change_presence(status=discord.Status.dnd, activity=discord.Activity(type=discord.ActivityType.watching, name="/hub"))

# Global message handler to see all messages
@bot.event
async def on_message(message: discord.Message):
    print(f"[GLOBAL] message: '{message.content}' from {message.author} (bot={message.author.bot}) channel={type(message.channel).__name__}")
    if message.author.bot:
        return
    await bot.process_commands(message)




async def load_cogs():
    for cog in ("hub", "pocket", "portal", "tickets", "payments", "onboarding", "orders"):
        try:
            print(f"[nodeline] attempting to load cogs.{cog}")
            await bot.load_extension(f"cogs.{cog}")
            print(f"[nodeline] loaded cogs.{cog}")
        except Exception as err:
            print(f"[nodeline] could not load cogs.{cog}: {err}")
            import traceback
            traceback.print_exc()


@bot.event
async def setup_hook():
    await load_cogs()


if __name__ == "__main__":
    if not TOKEN:
        raise SystemExit("DISCORD_TOKEN is not set — copy .env.example to .env and fill it in.")
    bot.run(TOKEN)