"""Server onboarding: welcome, base role, the /post-role-select + /post-kiosk
pinning commands, and the role picker."""

from __future__ import annotations

import discord
from discord.ext import commands

from cogs import router, views
from config import embeds
from config.channels import CHANNELS, get_channel
from config.roles import BASE_ROLE_ID, EMOJI_RESELLER, EMOJI_SHOPPER, resolve_role


class OnboardingCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        bot.add_view(views.router.build_persistent_view(
            [
                {"custom_id": "role:shopper", "label": "Shopper", "emoji": EMOJI_SHOPPER,
                 "style": discord.ButtonStyle.secondary},
                {"custom_id": "role:reseller", "label": "Reseller", "emoji": EMOJI_RESELLER,
                 "style": discord.ButtonStyle.secondary, "disabled": True},
            ]
        ))

    @commands.Cog.listener()
    async def on_member_join(self, member: discord.Member):
        if BASE_ROLE_ID and member.guild.get_role(int(BASE_ROLE_ID)):
            try:
                await member.add_roles(member.guild.get_role(int(BASE_ROLE_ID)), reason="Welcome to A6!")
            except discord.DiscordException as err:
                print(f"[onboarding] could not assign {BASE_ROLE_ID}: {err}")

        # Channel welcome (no DM on join - channel-only)
        welcome_ch = await get_channel(self.bot, "welcome")
        if welcome_ch:
            try:
                verify_ch = await get_channel(self.bot, "verify")
                site_ch = await get_channel(self.bot, "site")
                verify_ref = verify_ch.mention if verify_ch else "**#verify**"
                site_ref = site_ch.mention if site_ch else "**#site**"
                embed = embeds.branded_embed(
                    title="Welcome!",
                    description=(
                        f"Thanks for joining **{member.guild.name}**, {member.mention}!\n\n"
                        f"Head over to {verify_ref} to get verified and {site_ref} to browse the store."
                    ),
                    no_banner=True,
                    no_footer=True,
                )
                embed.set_footer(text=embeds.BRAND_NAME)
                await welcome_ch.send(
                    content=member.mention,
                    embed=embed,
                    files=[],
                )
            except discord.DiscordException as err:
                print(f"[onboarding] could not send welcome to channel: {err}")


@router.button("role:shopper")
async def role_shopper(interaction: discord.Interaction, _rest: list[str]):
    member = interaction.user
    if not isinstance(member, discord.Member):
        await interaction.response.send_message("You must be in the server to pick a role.", ephemeral=True)
        return
    role = resolve_role(member.guild, "shopper")
    if role is None:
        await interaction.response.send_message("The Shopper role isn't configured yet — poke the staff.", ephemeral=True)
        return
    if role in member.roles:
        await interaction.response.send_message("You already have the Shopper role!", ephemeral=True)
        return
    try:
        await member.add_roles(role, reason="Role picker")
    except discord.DiscordException as err:
        await interaction.response.send_message(f"Couldn't assign that role: {err}", ephemeral=True)
        return
    embed = embeds.branded_embed(
        eyebrow="A6",
        title="You're in!",
        description=f"You've got the **{role.name}** role. Run **/hub** to get going.",
        color=embeds.SUCCESS,
    )
    await interaction.response.send_message(embeds=[embed], files=[embeds.banner_file()], ephemeral=True)


@router.button("role:reseller")
async def role_reseller(interaction: discord.Interaction, _rest: list[str]):
    await interaction.response.send_message(
        "The Reseller role isn't available yet — ask staff if you need it.", ephemeral=True
    )


async def setup(bot: commands.Bot):
    await bot.add_cog(OnboardingCog(bot))