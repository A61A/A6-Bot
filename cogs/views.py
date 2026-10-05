"""UI builders shared by the cogs.

Everything funnels through `branded_embed` + `banner_file`, so the A6
look stays consistent: violet/blue banner strip, tinted border, brand footer.
"""

from __future__ import annotations

import discord

from cogs import router
from config import embeds, notes
from config.roles import EMOJI_RESELLER, EMOJI_SHOPPER
from lib import db

# ---------------------------------------------------------------- hub menu

def hub_menu(user: discord.User) -> tuple[discord.Embed, discord.ui.View]:
    embed = embeds.branded_embed(
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


def payment_method_options() -> list[discord.SelectOption]:
    """Owner-managed methods from the DB (see /admin → Add Payment)."""
    options: list[discord.SelectOption] = []
    for pm in db.list_payment_methods()[:25]:
        first_line = (pm["details"] or "").strip().splitlines()
        description = (first_line[0] if first_line else pm["url"])[:100] or None
        options.append(
            discord.SelectOption(
                label=pm["label"][:100],
                value=str(pm["id"]),
                description=description,
                emoji=(pm["emoji"] or None),
            )
        )
    return options


def payment_method_select(custom_id: str, *, placeholder: str = "Pick a payment method…") -> dict:
    """The method picker row, used by both the Pocket top-up and direct product buys."""
    return {
        "type": "select",
        "custom_id": custom_id,
        "placeholder": placeholder,
        "options": payment_method_options(),
    }


def payment_screen(
    pm: dict,
    note: str,
    *,
    amount: str = "",
    back: dict,
) -> tuple[discord.Embed, discord.ui.View]:
    """What the customer pays from: how much, the note to paste, where to send it.

    `amount` is the money they owe ("$25"); empty skips the line (nothing to charge).
    """
    lines: list[str] = []
    if amount:
        lines.append(f"Amount due = {amount}")
        lines.append("")
    lines.append(notes.note_line(note))
    details = (pm.get("details") or "").strip()
    if details:
        if "\n" in details or len(details) > 100:
            lines.append("")
            lines.append(details)
        else:
            lines.append(f"Send here -> `{details}`")
    elif pm.get("url"):
        lines.append(f"Tap **Open {pm['label']}** to pay.")
    else:
        lines.append("No instructions yet — contact staff.")

    rows: list[list[dict]] = []
    if pm.get("url"):
        # URL set -> a direct link button; no URL -> the written instructions.
        rows.append([{"label": f"Open {pm['label']}"[:80], "url": pm["url"], "emoji": pm.get("emoji") or None}])
    rows.append([back])
    embed = embeds.branded_embed(title=pm["label"], description="\n".join(lines), hero=False, shop=False)
    return embed, router.make_view(rows)


# -------------------------------------------------------------- pocket menu

def pocket_menu(user: discord.User) -> tuple[discord.Embed, discord.ui.View]:
    credits = db.get_credits(user.id)
    embed = embeds.branded_embed(
        title="Pocket",
        description=f"Hello {user.mention}! You have **{credits} credits**.\n\nNeed more? Pick a payment method below!",
        hero=False,
    )
    row1 = [
        {"custom_id": "pocket:redeem", "label": "Redeem", "style": discord.ButtonStyle.secondary},
        {"custom_id": "pocket:buycredits", "label": "Buy Credits - Crypto", "style": discord.ButtonStyle.success},
    ]
    rows: list[list[dict]] = [row1]
    options = payment_method_options()
    if options:
        rows.append(
            [
                {
                    "type": "select",
                    "custom_id": "pocket:pay",
                    "placeholder": "Pick a payment method…",
                    "options": options,
                }
            ]
        )
    rows.append([hub_home_button(user)])
    return embed, router.make_view(rows)


# -------------------------------------------------------------- portal menu

def _visible_products() -> list[dict]:
    """Live catalog from the DB (managed via /admin, seeded from config)."""
    return db.list_products()


def hub_home_button_view(user: discord.User) -> discord.ui.View:
    return router.make_view([[hub_home_button(user)]])


# Per-product accent used on the catalog pages. Products not listed here
# keep the default violet. (TikTok's black is 0x000000 = Discord's default,
# so that embed simply renders with no accent bar.)
PRODUCT_COLORS: dict[str, int] = {
    "netflix": 0xE50914,
    "suppliers": 0xFF69B4,
    "tiktok_users": 0x000000,
    "discord_nitro": 0x5865F2,
    "spotify": 0x1DB954,
    "twitter_accounts": 0xFFFFFF,
}


def _product_color(product: dict) -> int:
    """Accent for a product embed: /admin colour first, then the table, then violet."""
    try:
        typed = embeds.parse_color(product.get("color") or "")
    except ValueError:
        typed = None
    if typed is not None:
        return typed
    return PRODUCT_COLORS.get(product["key"], embeds.VIOLET)


def product_select_options() -> list[discord.SelectOption]:
    """Dropdown options for the visible catalog. Shared by portal_menu and the kiosk Menu follow-up."""
    options = []
    for p in _visible_products():
        if p.get("coming_soon"):
            options.append(discord.SelectOption(label=f"{p['label']} — Soon…", value=p["key"]))
        else:
            options.append(discord.SelectOption(label=p["label"], value=p["key"], emoji=p.get("emoji")))
    return options


def portal_menu(user: discord.User, bot: discord.Client | None = None) -> tuple[discord.Embed, discord.ui.View]:
    products = _visible_products()
    embed = embeds.branded_embed(
        title="Portal — Catalog",
        description="Pick a product below to view it and purchase.",
    )
    options = product_select_options()
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


def product_page(
    user: discord.User,
    product: dict,
    *,
    hero: bool = True,
    back: dict | None = None,
    buy_prefix: str = "portal:buy",
) -> tuple[discord.Embed, discord.ui.View]:
    lines = []
    owned = product.get("once", False) and db.has_purchased(user.id, product["key"])
    payable = False
    for v in product["versions"]:
        stock = v.get("stock")
        price = f"{v['price']} credits"
        if stock is not None:
            price += " — Sold out" if stock <= 0 else f" — {stock} left"
        lines.append((f"**{v['label']}**", price, True))
        if not owned and (stock is None or stock > 0):
            payable = True
    description = (product.get("desc") or "").strip()
    if payable:
        # Reached from the BUY button underneath the version dropdown.
        hook = "**No credits?** Click the BUY button below."
        description = f"{description}\n\n{hook}" if description else hook
    embed = embeds.branded_embed(
        title=f"{product.get('emoji', '')} {product['label']}",
        description=description,
        fields=lines + [("Balance", f"{db.get_credits(user.id)} credits", False)],
        color=_product_color(product),
        hero=hero,
    )
    options = []
    for v in product["versions"]:
        stock = v.get("stock")
        if owned:
            note = "Already owned"
        elif stock is not None and stock <= 0:
            note = "Sold out"
        elif stock is not None:
            note = f"{stock} left"
        else:
            note = None
        options.append(
            discord.SelectOption(
                label=f"Buy {v['label']} — {v['price']} credits",
                value=v["value"],
                description=note,
            )
        )
    rows = []
    if options:
        rows.append(
            [
                {
                    "type": "select",
                    "custom_id": f"{buy_prefix}:select",
                    "placeholder": "Pick a version to buy…",
                    "options": options,
                }
            ]
        )
        # Pay-without-credits entry point, right underneath the version dropdown.
        if payable:
            rows.append(
                [
                    {
                        "custom_id": f"{buy_prefix}:paydirect:{product['key']}",
                        "label": "BUY",
                        "style": discord.ButtonStyle.success,
                    }
                ]
            )
    rows.append([back if back is not None else hub_home_button(user)])
    return embed, router.make_view(rows)


# ------------------------------------------------------ buy-credits (crypto)

def buy_credits_flow(user: discord.User) -> tuple[discord.Embed, discord.ui.View]:
    embed = embeds.branded_embed(
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
    return router.build_persistent_view(
        [
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