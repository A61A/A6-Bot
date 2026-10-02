"""Kiosk: one Components V2 panel posted to the kiosk channel.

Admin-only ``/kiosk`` (re)posts it. The copy lives here so tweaking the
wording never touches the V2 machinery in ``lib/v2.py``.
"""

from __future__ import annotations

import os

import discord
from discord.ext import commands

from cogs import router
from config import embeds
from config.channels import CHANNELS
from config.products import PRODUCTS
from config.roles import is_owner
from lib import v2


def kiosk_title() -> str:
    return os.getenv("KIOSK_TITLE", "read me")


def kiosk_description() -> str:
    return os.getenv(
        "KIOSK_DESCRIPTION",
        "Everything runs through **/hub** — open it anywhere and pick a lane.",
    )


def kiosk_fields() -> list[tuple[str, str]]:
    return [
        ("Portal", "Browse the catalog and spend your credits."),
        ("Pocket", "Balance, redeem codes, top up with crypto."),
        ("Support", "Open a chat — we reply right in your DMs."),
    ]


def kiosk_buttons() -> list[dict]:
    return [
        v2.action_button("kiosk:show:howto", "How to use", v2.PRIMARY_BUTTON),
        v2.action_button("kiosk:show:products", "Products", v2.SECONDARY_BUTTON),
        v2.action_button("kiosk:show:support", "Support", v2.SECONDARY_BUTTON),
    ]


def howto_embed() -> discord.Embed:
    return embeds.branded_embed(
        title="How to use A6",
        description=(
            "1. Run **/hub** anywhere.\n"
            "2. **Portal** — browse the catalog and spend credits.\n"
            "3. **Pocket** — balance, redeem codes, top up with crypto.\n"
            "4. **Support** — open a chat, we reply right in your DMs."
        ),
        hero=False,
    )


def products_embed() -> discord.Embed:
    fields: list[tuple[str, str, bool]] = []
    for p in PRODUCTS:
        if p.get("hidden"):
            continue
        versions = ", ".join(f"{ver['label']} — {ver['price']}" for ver in p["versions"])
        label = p["label"] + (" (soon)" if p.get("coming_soon") else "")
        fields.append((label, versions, False))
    return embeds.branded_embed(
        title="Products",
        description="Live catalog — prices in credits ($1 = 1 credit).",
        fields=fields,
        hero=False,
    )


def support_embed() -> discord.Embed:
    return embeds.branded_embed(
        title="Support",
        description=(
            "Open **/hub**, hit **Support**, and talk in your DMs.\n\n"
            "Keep DMs from server members on or we can't reach you."
        ),
        hero=False,
    )


@router.button("kiosk:show")
async def kiosk_show(interaction: discord.Interaction, rest: list[str]):
    topic = rest[0] if rest else ""
    builders = {"howto": howto_embed, "products": products_embed, "support": support_embed}
    build = builders.get(topic)
    if build is None:
        await interaction.response.send_message("That button is stale — ask staff to re-post the kiosk.", ephemeral=True)
        return
    # Private follow-up: only the clicker sees it, so balances and
    # activity stay out of the channel. Banner only - no gif here.
    await interaction.response.send_message(embeds=[build()], files=[embeds.banner_file()], ephemeral=True)


def kiosk_footer() -> str | None:
    return os.getenv("KIOSK_FOOTER") or os.getenv("SHOP_FOOTER_NOTE") or "Support replies in your DMs — keep them open."


def build_kiosk_container() -> dict:
    return v2.panel(
        title=kiosk_title(),
        brand=embeds.BRAND_SHORT,
        description=kiosk_description(),
        fields=kiosk_fields(),
        buttons=kiosk_buttons() or None,
        banner=f"attachment://{embeds.BANNER_FILENAME}",
        hero=f"attachment://{embeds.HERO_FILENAME}",
        footer=kiosk_footer(),
        accent=embeds.VIOLET,
    )


async def post_kiosk(bot, channel_id: int | str) -> dict:
    """Validate then POST the kiosk panel. Returns Discord's message object."""
    return await v2.send_panel(bot, channel_id, build_kiosk_container(), files=embeds.embed_files())


class KioskCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    @commands.Cog.listener()
    async def on_interaction(self, interaction: discord.Interaction):
        # Raw-V2 buttons have no discord.py View tracking them, so route the
        # kiosk: ones here. No classic view uses that prefix, so this can
        # never double-handle an interaction a view already claimed.
        if interaction.type is not discord.InteractionType.component:
            return
        custom_id = ((interaction.data or {}).get("custom_id") or "")
        if not custom_id.startswith("kiosk:"):
            return
        fn, rest = router._match_handler(router.BUTTONS, custom_id)
        if fn is None:
            try:
                await interaction.response.send_message("That button is stale — ask staff to re-post the kiosk.", ephemeral=True)
            except discord.DiscordException:
                pass
            return
        await fn(interaction, rest)

    @discord.app_commands.command(name="kiosk", description="Staff: (re)post the kiosk panel")
    @discord.app_commands.describe(channel="Channel to post in (defaults to the kiosk channel)")
    async def kiosk(self, interaction: discord.Interaction, channel: discord.TextChannel | None = None):
        if not is_owner(interaction.user.id):
            await interaction.response.send_message("Only the bot owner can do that.", ephemeral=True)
            return
        target = channel or (interaction.client.get_channel(int(CHANNELS["kiosk"])) if CHANNELS.get("kiosk") else None)
        if target is None:
            await interaction.response.send_message(
                "No kiosk channel configured — set KIOSK_CHANNEL_ID first.", ephemeral=True
            )
            return
        await interaction.response.defer(ephemeral=True, thinking=True)
        try:
            msg = await post_kiosk(interaction.client, target.id)
        except (ValueError, discord.DiscordException) as err:
            await interaction.edit_original_response(content=f"Kiosk post failed: {err}")
            return
        await interaction.edit_original_response(content=f"Kiosk posted in {target.mention}.")


async def setup(bot: commands.Bot):
    await bot.add_cog(KioskCog(bot))
