"""Kiosk: one Components V2 panel posted to the kiosk channel.

Admin-only ``/kiosk`` (re)posts it. The copy lives here so tweaking the
wording never touches the V2 machinery in ``lib/v2.py``.
"""

from __future__ import annotations

import os

import discord
from discord.ext import commands

from cogs import router, views
from config import embeds
from config.channels import CHANNELS
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


SITE_URL = os.getenv("SHOP_URL", "https://a6hub.cc")


def kiosk_buttons() -> list[dict]:
    return [
        v2.action_button("kiosk:show:howto", "Menu", v2.PRIMARY_BUTTON),
        v2.action_button("kiosk:show:bank", "Bank", v2.SECONDARY_BUTTON),
        v2.action_button("kiosk:show:support", "Support", v2.SECONDARY_BUTTON),
        # Link buttons open the URL directly but Discord always renders
        # them grey - blue is only for action buttons.
        v2.link_button("Website", SITE_URL),
    ]


def howto_embed() -> discord.Embed:
    return embeds.branded_embed(
        title="Menu",
        description=(
            "1. Run **/hub** anywhere.\n"
            "2. **Portal** — browse the catalog and spend credits.\n"
            "3. **Pocket** — balance, redeem codes, top up with crypto.\n"
            "4. **Support** — open a chat, we reply right in your DMs."
        ),
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


def menu_view() -> discord.ui.View:
    return router.make_view(
        [[{"custom_id": "kiosk:menu:products", "label": "Products", "style": discord.ButtonStyle.primary}]]
    )


def menu_select_view() -> discord.ui.View | None:
    options = views.product_select_options()
    if not options:
        return None
    return router.make_view(
        [
            [
                {
                    "type": "select",
                    "custom_id": "portal:product",
                    "placeholder": "Browse catalog…",
                    "options": options,
                }
            ],
            [{"custom_id": "kiosk:menu:back", "label": "Back", "style": discord.ButtonStyle.secondary}],
        ]
    )


@router.button("kiosk:show")
async def kiosk_show(interaction: discord.Interaction, rest: list[str]):
    topic = rest[0] if rest else ""
    if topic == "howto":
        # Menu follow-up carries its own Products button (dropdown, no embed).
        await interaction.response.send_message(embeds=[howto_embed()], view=menu_view(), ephemeral=True)
        return
    if topic == "bank":
        # Bank = your credits: balance, redeem, top up.
        embed, view = views.pocket_menu(interaction.user)
        await interaction.response.send_message(embeds=[embed], view=view, ephemeral=True)
        return
    builders = {"support": support_embed}
    build = builders.get(topic)
    if build is None:
        await interaction.response.send_message("That button is stale — ask staff to re-post the kiosk.", ephemeral=True)
        return
    # Private follow-up: only the clicker sees it, so balances and
    # activity stay out of the channel. No files - plain embed, no images.
    await interaction.response.send_message(embeds=[build()], ephemeral=True)


@router.button("kiosk:menu:products")
async def kiosk_menu_products(interaction: discord.Interaction, _rest: list[str]):
    view = menu_select_view()
    if view is None:
        await interaction.response.send_message("The catalog is empty right now.", ephemeral=True)
        return
    # Same message, buttons swapped for the dropdown - no new embed.
    await interaction.response.edit_message(view=view)


@router.button("kiosk:menu:back")
async def kiosk_menu_back(interaction: discord.Interaction, _rest: list[str]):
    await interaction.response.edit_message(embeds=[howto_embed()], view=menu_view())


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


def build_site_container() -> dict:
    return v2.panel(
        title=os.getenv("SITEKIOSK_TITLE", "Website"),
        brand=embeds.BRAND_SHORT,
        buttons=[v2.link_button("Website", SITE_URL)],
        banner=f"attachment://{embeds.BANNER_FILENAME}",
        hero=f"attachment://{embeds.HERO_FILENAME}",
        accent=embeds.VIOLET,
    )


async def post_kiosk(bot, channel_id: int | str) -> dict:
    """Validate then POST the kiosk panel. Returns Discord's message object."""
    return await v2.send_panel(bot, channel_id, build_kiosk_container(), files=embeds.embed_files())


async def post_site_panel(bot, channel_id: int | str) -> dict:
    """Validate then POST the site panel. Returns Discord's message object."""
    return await v2.send_panel(bot, channel_id, build_site_container(), files=embeds.embed_files())


class KioskCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    @commands.Cog.listener()
    async def on_interaction(self, interaction: discord.Interaction):
        # Raw-V2 buttons have no discord.py View tracking them, so route the
        # kiosk:show ones here. Narrowed to that prefix on purpose: the
        # kiosk:menu: buttons live in classic views and are already
        # dispatched by the library - touching them here would answer
        # the same interaction twice ("already responded").
        if interaction.type is not discord.InteractionType.component:
            return
        custom_id = ((interaction.data or {}).get("custom_id") or "")
        if not custom_id.startswith("kiosk:show:"):
            return
        fn, rest = router._match_handler(router.BUTTONS, custom_id)
        if fn is None:
            try:
                await interaction.response.send_message("That button is stale — ask staff to re-post the kiosk.", ephemeral=True)
            except discord.DiscordException:
                pass
            return
        await fn(interaction, rest)

    @discord.app_commands.command(name="kiosk", description="Staff: (re)post a panel")
    @discord.app_commands.describe(
        panel="Which panel to post",
        channel="Channel override (defaults to that panel's channel)",
    )
    @discord.app_commands.choices(
        panel=[
            discord.app_commands.Choice(name="kiosk", value="kiosk"),
            discord.app_commands.Choice(name="site", value="site"),
        ]
    )
    async def kiosk(
        self,
        interaction: discord.Interaction,
        panel: str = "kiosk",
        channel: discord.TextChannel | None = None,
    ):
        if not is_owner(interaction.user.id):
            await interaction.response.send_message("Only the bot owner can do that.", ephemeral=True)
            return
        if panel == "site":
            key, post, label = "site", post_site_panel, "Site panel"
        else:
            key, post, label = "kiosk", post_kiosk, "Kiosk"
        target = channel or (interaction.client.get_channel(int(CHANNELS[key])) if CHANNELS.get(key) else None)
        if target is None:
            await interaction.response.send_message(
                f"No {key} channel configured — set {key.upper()}_CHANNEL_ID first.", ephemeral=True
            )
            return
        await interaction.response.defer(ephemeral=True, thinking=True)
        try:
            await post(interaction.client, target.id)
        except (ValueError, discord.DiscordException) as err:
            await interaction.edit_original_response(content=f"{label} post failed: {err}")
            return
        await interaction.edit_original_response(content=f"{label} posted in {target.mention}.")


async def setup(bot: commands.Bot):
    await bot.add_cog(KioskCog(bot))
