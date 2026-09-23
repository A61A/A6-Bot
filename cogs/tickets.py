"""Support tickets (DM relay only — no AI)."""

from __future__ import annotations

import discord
from discord.ext import commands

from cogs import router, views
from config import embeds
from config.roles import INF_ROLE_ID
from lib import db, tickets as tickets_lib

PERSISTENT_CONTROLS = [
    {"custom_id": "ticket:pingadmin", "label": "Ping an Admin", "style": discord.ButtonStyle.secondary},
    {"custom_id": "ticket:close", "label": "Close Chat", "style": discord.ButtonStyle.danger},
]


async def _staff_message(reply: str) -> discord.Embed:
    return embeds.branded_embed(eyebrow="Support", title="Support Chat", description=reply, color=embeds.VIOLET)


async def _customer_message(reply: str) -> discord.Embed:
    return embeds.branded_embed(eyebrow="A6", title="Support", description=reply, color=embeds.BLUE)


async def open_chat_for(interaction: discord.Interaction) -> None:
    user = interaction.user
    try:
        dm = await user.create_dm()
    except discord.Forbidden:
        await interaction.response.send_message(
            "I can't DM you — please allow DMs from server members and try again.", ephemeral=True
        )
        return

    existing = db.get_open_ticket_by_dm(str(user.id), str(dm.id))
    if existing:
        await interaction.response.send_message(
            "You already have an open chat — check your DMs and keep talking there.", ephemeral=True
        )
        return

    try:
        res = await tickets_lib.create_chat_ticket(interaction.client, user, dm)
    except RuntimeError as err:
        await interaction.response.send_message(str(err), ephemeral=True)
        return

    ticket = res["ticket"]
    ticket_channel = res["channel"]

    intro = (
        "You're now talking to **A6** • support replies right here in your DMs.\n\n"
        "Staff members can see this chat too, and you'll still talk from this DM."
    )
    await dm.send(embeds=[await _customer_message(intro)], files=[embeds.banner_file()])

    if ticket_channel is not None:
        staff_intro = (
            f"Support chat opened by **{user.name}** (`{user.id}`)\n"
            "They'll message right here — staff replies in their DMs."
        )
        await ticket_channel.send(
            embeds=[await _staff_message(staff_intro)],
            files=[embeds.banner_file()],
            view=views.ticket_controls(db.get_ticket(ticket["id"])),
        )

    reply_text = "Chat opened. Talk to me here!"
    reply_view = views.hub_home_button_view(user)
    await interaction.response.send_message(
        embeds=[await _customer_message(reply_text)], files=[embeds.banner_file()], view=reply_view, ephemeral=True
    )


@router.button("hub:support")
async def hub_support(interaction: discord.Interaction, _rest: list[str]):
    await open_chat_for(interaction)


@router.button("ticket:mode:chat")
async def mode_chat(interaction: discord.Interaction, _rest: list[str]):
    await open_chat_for(interaction)


@router.button("ticket:pingadmin")
async def ticket_pingadmin(interaction: discord.Interaction, _rest: list[str]):
    ticket = db.get_ticket_by_channel(str(interaction.channel_id))
    if ticket is None or interaction.guild is None:
        await interaction.response.send_message("This isn't an active ticket channel.", ephemeral=True)
        return
    role = interaction.guild.get_role(int(INF_ROLE_ID)) if INF_ROLE_ID else None
    embed = embeds.branded_embed(
        eyebrow="Support",
        title="Admin pinged",
        description="An admin has been notified — they'll be on shortly.",
    )
    await interaction.response.send_message(
        content=f"{role.mention} — a customer is waiting in this chat." if role else None,
        embeds=[embed],
        files=[embeds.banner_file()],
    )
    user = interaction.guild.get_member(int(ticket["user_id"]))
    if user:
        try:
            await user.send(embeds=[await _customer_message("An admin has been pinged and will join this chat shortly.")])
        except discord.Forbidden:
            pass


@router.button("ticket:close")
async def ticket_close(interaction: discord.Interaction, _rest: list[str]):
    ticket = db.get_ticket_by_channel(str(interaction.channel_id))
    if ticket is None:
        await interaction.response.send_message("This isn't an active ticket channel.", ephemeral=True)
        return
    db.close_ticket(ticket["id"])
    embed = embeds.branded_embed(
        eyebrow="Support",
        title="Chat closed",
        description="This chat has been closed and the ticket archived.",
    )
    await interaction.response.edit_message(embeds=[embed], view=None)
    user = interaction.guild.get_member(int(ticket["user_id"])) if interaction.guild else None
    if user:
        try:
            await user.send(
                embeds=[await _customer_message("Your support chat has been closed. Open a new one any time from the hub!")]
            )
        except discord.Forbidden:
            pass


def _dm_prelude_embed() -> discord.Embed:
    return embeds.branded_embed(
        eyebrow="A6",
        title="Support",
        description=(
            "Hey! This DM is how support chats with you.\n\n"
            "Say **/hub** right here to open the menu, then hit **Support** to start a chat. "
            "It works in DMs and in any server I'm invited to."
        ),
        color=embeds.NEUTRAL,
    )


async def _mirror_to_channel(channel: discord.abc.Messageable, message: discord.Message, label: str) -> None:
    as_user = message.author
    embed = discord.Embed(color=embeds.VIOLET, description=message.content or "*attachment*")
    embed.set_author(name=f"{label} • {as_user.name}", icon_url=(as_user.display_avatar.url if as_user.display_avatar else None))
    if message.attachments:
        files = [await a.to_file() for a in message.attachments]
        await channel.send(embeds=[embed], files=files)
    else:
        await channel.send(embeds=[embed])


class TicketsCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        bot.add_view(router.build_persistent_view(PERSISTENT_CONTROLS))

    @commands.Cog.listener()
    async def on_message(self, message: discord.Message):
        if message.author.bot:
            return
        if not isinstance(message.channel, discord.DMChannel):
            return

        user_id = message.author.id

        # Let the orders cog (and any other keyword handler) respond to its raw
        # keywords instead of showing the support prelude — don't send anything here.
        first = (message.content or "").strip().split()
        if first and first[0].lower() in ("orders", "order"):
            return

        ticket = db.get_open_ticket_by_dm(str(user_id), str(message.channel.id))
        if ticket is None:
            await message.channel.send(embeds=[_dm_prelude_embed()], files=[embeds.banner_file()])
            return

        db.touch_ticket(ticket["id"])
        target_id = ticket["channel_id"] or ticket["admin_channel_id"]
        target = self.bot.get_channel(int(target_id)) if target_id else None
        if target is not None:
            try:
                await _mirror_to_channel(target, message, label="Customer")
            except discord.DiscordException:
                pass


async def setup(bot: commands.Bot):
    await bot.add_cog(TicketsCog(bot))