"""UI builders shared by the cogs.

Everything funnels through `branded_embed` + `banner_file`, so the A6
look stays consistent: violet/blue banner strip, tinted border, brand footer.
"""

from __future__ import annotations

import discord

from cogs import router
from config import embeds
from config.products import PRODUCTS
from config.roles import EMOJI_RESELLER, EMOJI_SHOPPER
from lib import db

# ---------------------------------------------------------------- hub menu

def hub_menu(user: discord.User) -> tuple[discord.Embed, discord.ui.View]:
    embed = embeds.branded_embed(
        eyebrow="A6",
        title="How To Use A6",
        description=(
            "Pick a button — everything opens privately, just for you.\n\n"
            "**▸ Portal** — browse the catalog & spend your credits\n"
            "**▸ Pocket** — check your balance, redeem codes\n"
            "**▸ Support** — open a chat, we reply in your DMs"
        ),
    )
    view = router.make_view(
        [
            [
                {"custom_id": "hub:portal", "label": "Portal", "style": discord.ButtonStyle.primary},
                {"custom_id": "hub:pocket", "label": "Pocket", "style": discord.ButtonStyle.secondary},
                {"custom_id": "hub:support", "label": "Support", "style": discord.ButtonStyle.secondary},
            ]
        ]
    )
    return embed, view


def hub_home_button(user: discord.User) -> dict:
    return {"custom_id": "hub:home", "label": "Back to Hub", "style": discord.ButtonStyle.secondary}


# -------------------------------------------------------------- pocket menu

def pocket_menu(user: discord.User) -> tuple[discord.Embed, discord.ui.View]:
    credits = db.get_credits(user.id)
    embed = embeds.branded_embed(
        eyebrow="A6",
        title="Pocket",
        description=f"Hello {user.mention}! You have **{credits} credits**.\n\nNeed more? Pick a payment method below!",
    )
    row1 = [
        {"custom_id": "pocket:redeem", "label": "Redeem", "style": discord.ButtonStyle.secondary},
        {"custom_id": "pocket:buycredits", "label": "Buy Credits - Crypto", "style": discord.ButtonStyle.success},
    ]
    view = router.make_view([row1, [hub_home_button(user)]])
    return embed, view


# -------------------------------------------------------------- portal menu

def _visible_products() -> list[dict]:
    return [p for p in PRODUCTS if not p.get("hidden", False)]


def hub_home_button_view(user: discord.User) -> discord.ui.View:
    return router.make_view([[hub_home_button(user)]])


def portal_menu(user: discord.User, bot: discord.Client | None = None) -> tuple[discord.Embed, discord.ui.View]:
    products = _visible_products()
    embed = embeds.branded_embed(
        eyebrow="A6",
        title="Portal — Catalog",
        description="Pick a product below to view it and purchase.",
    )
    options = []
    for p in products:
        if p.get("coming_soon"):
            options.append(discord.SelectOption(label=f"{p['label']} — Soon…", value=p["key"], disabled=True))
        else:
            options.append(discord.SelectOption(label=p["label"], value=p["key"], emoji=p.get("emoji")))
    view = router.make_view(
        [
            [
                {
                    "type": "select",
                    "custom_id": "portal:product",
                    "placeholder": "Browse catalog…",
                    "options": options,
                }
            ],
            [hub_home_button(user)],
        ]
    )
    return embed, view


def product_page(user: discord.User, product: dict) -> tuple[discord.Embed, discord.ui.View]:
    lines = [(f"**{v['label']}**", f"{v['price']} credits", True) for v in product["versions"]]
    embed = embeds.branded_embed(
        eyebrow="A6",
        title=f"{product.get('emoji', '')} {product['label']}",
        description=product.get("desc") or "",
        fields=lines + [("Balance", f"{db.get_credits(user.id)} credits", False)],
    )
    rows = []
    b_row = []
    for v in product["versions"]:
        owned = product.get("once", False) and db.has_purchased(user.id, product["key"])
        b_row.append(
            {
                "custom_id": f"portal:buy:{v['value']}",
                "label": f"Buy {v['label']} — {v['price']} credits",
                "style": discord.ButtonStyle.success,
                "disabled": owned,
            }
        )
    rows.append(b_row[:5])
    rows.append([hub_home_button(user)])
    view = router.make_view(rows)
    return embed, view


# ------------------------------------------------------ buy-credits (crypto)

def buy_credits_flow(user: discord.User) -> tuple[discord.Embed, discord.ui.View]:
    embed = embeds.branded_embed(
        eyebrow="A6",
        title="Buy Credits",
        description=(
            "Pick an amount. **$1 = 1 credit**. Pay with crypto — pick your coin and the address appears right here.\n\n"
            "_Topping up with a payment provider…_"
        ),
    )
    amounts = [5, 10, 25, 50]
    rows = []
    for i in range(0, len(amounts), 2):
        rows.append(
            [
                {"custom_id": f"pay:amount:{a}", "label": f"${a} = {a} credits", "style": discord.ButtonStyle.secondary}
                for a in amounts[i : i + 2]
            ]
        )
    rows.append([hub_home_button(user)])
    view = router.make_view(rows)
    return embed, view


def coin_selector(user: discord.User, amount: int) -> tuple[discord.Embed, discord.ui.View]:
    from lib.payments import SUPPORTED_COINS

    embed = embeds.branded_embed(
        eyebrow="A6",
        title="Buy Credits",
        description=f"Amount locked in: **${amount} = {amount} credits**.\n\nPick which coin to pay with.",
    )
    options = [discord.SelectOption(label=coin["label"], value=coin["value"]) for coin in SUPPORTED_COINS]
    view = router.make_view(
        [
            [{"type": "select", "custom_id": f"pay:coin:{amount}", "placeholder": "Pick a coin…", "options": options}],
            [hub_home_button(user)],
        ]
    )
    return embed, view


# ------------------------------------------------------------------ tickets

def ticket_controls(ticket) -> discord.ui.View:
    ai_label = "Start the AI" if ticket and ticket["human_taken"] else "Stop the AI"
    return router.build_persistent_view(
        [
            {"custom_id": "ticket:ai", "label": ai_label, "style": discord.ButtonStyle.secondary},
            {"custom_id": "ticket:pingadmin", "label": "Ping an Admin", "style": discord.ButtonStyle.secondary},
            {"custom_id": "ticket:close", "label": "Close Chat", "style": discord.ButtonStyle.danger},
        ]
    )


# ------------------------------------------------------------------- roles

def role_picker(who: discord.Member | None = None) -> tuple[discord.Embed, discord.ui.View]:
    embed = embeds.branded_embed(
        description=f"{who}, pick your role to unlock the matching channels." if who else "Pick your role to unlock the matching channels.",
    )
    view = router.build_persistent_view(
        [
            {"custom_id": "role:shopper", "label": "Shopper", "emoji": EMOJI_SHOPPER, "style": discord.ButtonStyle.secondary},
            {"custom_id": "role:reseller", "label": "Reseller", "emoji": EMOJI_RESELLER, "style": discord.ButtonStyle.secondary, "disabled": True},
        ]
    )
    return embed, view