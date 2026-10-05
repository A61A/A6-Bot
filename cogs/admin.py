"""Store management dashboard.

/admin — one embed with buttons. Every action is click → pick → form:

  List      see the full catalog with prices and stock
  Add       product or version via a modal form
  Edit      pick a product/version, form comes prefilled
  Remove    pick, then confirm
  Payments  payment methods shown under the Bank button (link or instructions)
  Notes     the payment notes customers were told to include

All operations read straight from the DB, so changes apply instantly —
no restart, no re-post. Stock is per version: a number, or unlimited.
"""

from __future__ import annotations

import re

import discord
from discord import app_commands
from discord.ext import commands

from cogs import router
from config import embeds
from config.roles import is_owner
from lib import db


def _stock_text(stock: int | None) -> str:
    return "unlimited" if stock is None else f"{stock} left"


def _version_line(v: dict) -> str:
    return f"**{v['label']}** — {v['price']} credits ({_stock_text(v['stock'])})"


def _flags(p: dict) -> str:
    tags = []
    if p.get("coming_soon"):
        tags.append("soon")
    if p.get("hidden"):
        tags.append("hidden")
    if p.get("once"):
        tags.append("once")
    return f" [{', '.join(tags)}]" if tags else ""


def _flags_plain(p: dict) -> str:
    tags = []
    if p.get("coming_soon"):
        tags.append("soon")
    if p.get("hidden"):
        tags.append("hidden")
    if p.get("once"):
        tags.append("once")
    return ", ".join(tags)


def _parse_flags(raw: str) -> dict:
    raw = raw.lower()
    return {
        "coming_soon": "soon" in raw,
        "hidden": "hidden" in raw,
        "once": "once" in raw,
    }


async def _guard(interaction: discord.Interaction) -> bool:
    if is_owner(interaction.user.id):
        return True
    try:
        await interaction.response.send_message("Only the bot owner can do that.", ephemeral=True)
    except discord.DiscordException:
        pass
    return False


def _modal_values(interaction: discord.Interaction) -> dict:
    out = {}
    for row in (interaction.data or {}).get("components", []):
        comps = row.get("components", [row]) if isinstance(row, dict) else []
        for comp in comps:
            if isinstance(comp, dict) and comp.get("custom_id"):
                out[comp["custom_id"]] = (comp.get("value") or "").strip()
    return out


def _parse_stock(raw: str) -> int | None:
    raw = (raw or "").strip()
    if not raw or raw.lower() in ("unlimited", "none", "-"):
        return None
    try:
        n = int(raw)
    except ValueError:
        raise ValueError("Stock must be a number, or blank for unlimited.") from None
    if n < 0:
        raise ValueError("Stock can't be negative.")
    return n


def _parse_price(raw: str) -> int:
    try:
        n = int((raw or "").strip())
    except ValueError:
        raise ValueError("Price must be a whole number of credits.") from None
    if n < 0:
        raise ValueError("Price can't be negative.")
    return n


def _parse_url(raw: str) -> str:
    raw = (raw or "").strip()
    if not raw:
        return ""
    if len(raw) > 512:
        raise ValueError("That link is too long.")
    if not re.match(r"^https?://\S+$", raw, re.I):
        raise ValueError("Link must start with `http://` or `https://` and contain no spaces.")
    return raw


_MARKUP_RE = re.compile(r"^<(a)?:[^:\s<>]{1,100}:\d{5,25}>$")

_EMOJI_HINT = (
    "That doesn't look like an emoji. Paste a unicode emoji (🎧), the full "
    "`<:name:id>` / `<a:name:id>` markup, or just the emoji ID."
)


def _markup_from_id(emoji_id: int, client) -> str:
    emoji = client.get_emoji(emoji_id) if client is not None and hasattr(client, "get_emoji") else None
    if emoji is None:
        raise ValueError(
            f"I can't find emoji id `{emoji_id}` — the bot may not be able to see it. "
            "Right-click the emoji → Copy Link and paste the full `<:name:id>` markup instead."
        )
    return str(discord.PartialEmoji(name=emoji.name, id=emoji.id, animated=emoji.animated))


def _normalize_emoji(raw: str, client) -> str:
    """Accept whatever gets pasted and store it as Discord-ready markup.

    Unicode (🎧) and full `<:name:id>` / `<a:name:id>` markup pass through;
    a bare ID or `:name:` is resolved against the emojis the bot can see.
    """
    raw = (raw or "").strip()
    if not raw:
        return ""
    if _MARKUP_RE.match(raw):
        return raw
    if raw.isdigit():
        return _markup_from_id(int(raw), client)
    if re.fullmatch(r":[^:\s]{1,100}:", raw):
        name = raw[1:-1]
        emoji = next((e for e in getattr(client, "emojis", []) if e.name == name), None)
        if emoji is None:
            raise ValueError(f"I can't find a custom emoji named `{name}` that the bot can see.")
        return str(discord.PartialEmoji(name=emoji.name, id=emoji.id, animated=emoji.animated))
    if raw.isascii() or len(raw) > 40 or any(ch.isspace() for ch in raw):
        raise ValueError(_EMOJI_HINT)
    return raw


def _home_row() -> list[dict]:
    return [{"custom_id": "admin:home", "label": "Dashboard", "style": discord.ButtonStyle.primary}]


def _dashboard_embed() -> discord.Embed:
    count = len(db.list_products(include_hidden=True))
    payments = len(db.list_payment_methods())
    return embeds.branded_embed(
        title="Store Management",
        description="Pick an action below — changes apply instantly.",
        fields=[
            ("Products in catalog", str(count), True),
            ("Payment methods", str(payments), True),
        ],
        hero=False,
        shop=False,
    )


def _dashboard_view() -> discord.ui.View:
    return router.make_view(
        [
            [
                {"custom_id": "admin:list", "label": "List Products", "style": discord.ButtonStyle.primary, "row": 0},
                {"custom_id": "admin:addp", "label": "Add Product", "style": discord.ButtonStyle.success, "row": 0},
                {"custom_id": "admin:edp", "label": "Edit Product", "style": discord.ButtonStyle.secondary, "row": 0},
                {"custom_id": "admin:rmp", "label": "Remove Product", "style": discord.ButtonStyle.danger, "row": 0},
                {"custom_id": "admin:home", "label": "Refresh", "style": discord.ButtonStyle.secondary, "row": 0},
            ],
            [
                {"custom_id": "admin:addv", "label": "Add Version", "style": discord.ButtonStyle.success, "row": 1},
                {"custom_id": "admin:edv", "label": "Edit Version", "style": discord.ButtonStyle.secondary, "row": 1},
                {"custom_id": "admin:rmv", "label": "Remove Version", "style": discord.ButtonStyle.danger, "row": 1},
            ],
            [
                {"custom_id": "admin:addpm", "label": "Add Payment", "style": discord.ButtonStyle.success, "row": 2},
                {"custom_id": "admin:edpm", "label": "Edit Payment", "style": discord.ButtonStyle.secondary, "row": 2},
                {"custom_id": "admin:rmpm", "label": "Remove Payment", "style": discord.ButtonStyle.danger, "row": 2},
                {"custom_id": "admin:notes", "label": "Recent Notes", "style": discord.ButtonStyle.primary, "row": 2},
            ],
        ]
    )


def _result_view() -> discord.ui.View:
    return router.make_view([_home_row()])


async def _show(interaction: discord.Interaction, embed: discord.Embed, view: discord.ui.View) -> None:
    """Edit the dashboard message when possible, else send ephemeral."""
    if getattr(interaction, "message", None) is not None:
        try:
            await interaction.response.edit_message(embeds=[embed], view=view)
            return
        except discord.DiscordException:
            pass
    await interaction.response.send_message(embeds=[embed], view=view, ephemeral=True)


async def _fail(interaction: discord.Interaction, msg: str) -> None:
    embed = embeds.branded_embed(title="Something went wrong", description=msg, hero=False, shop=False)
    await _show(interaction, embed, _result_view())


def _product_select_rows(custom_id: str, placeholder: str) -> list[list[dict]] | None:
    products = db.list_products(include_hidden=True)
    if not products:
        return None
    options = [
        discord.SelectOption(
            label=p["label"][:100],
            value=p["key"],
            description=(p["key"] if len(p["label"]) > 25 else None),
            emoji=p.get("emoji") or None,
        )
        for p in products[:25]
    ]
    return [
        [{"type": "select", "custom_id": custom_id, "placeholder": placeholder, "options": options}],
        _home_row(),
    ]


def _version_select_rows(product_key: str, custom_id: str, placeholder: str) -> list[list[dict]] | None:
    p = db.get_product(product_key)
    if p is None or not p["versions"]:
        return None
    options = [
        discord.SelectOption(
            label=f"{v['label']} — {v['price']}c"[:100],
            value=v["value"],
            description=_stock_text(v["stock"])[:100],
        )
        for v in p["versions"][:25]
    ]
    return [
        [{"type": "select", "custom_id": custom_id, "placeholder": placeholder, "options": options}],
        _home_row(),
    ]


def _prompt_embed(title: str, description: str) -> discord.Embed:
    return embeds.branded_embed(title=title, description=description, hero=False, shop=False)


def _payment_select_rows(custom_id: str, placeholder: str) -> list[list[dict]] | None:
    payments = db.list_payment_methods()
    if not payments:
        return None
    options = [
        discord.SelectOption(
            label=pm["label"][:100],
            value=str(pm["id"]),
            description=("link" if pm["url"] else "instructions")[:100],
            emoji=pm["emoji"] or None,
        )
        for pm in payments[:25]
    ]
    return [
        [{"type": "select", "custom_id": custom_id, "placeholder": placeholder, "options": options}],
        _home_row(),
    ]


# ------------------------------------------------------------------ modals

def _add_product_modal() -> discord.ui.Modal:
    m = discord.ui.Modal(title="Add Product", custom_id="admin:addp:modal")
    m.add_item(discord.ui.TextInput(label="Key (short id)", custom_id="key", placeholder="spotify", max_length=32))
    m.add_item(discord.ui.TextInput(label="Display name", custom_id="label", placeholder="Lifetime Spotify Premium", max_length=100))
    m.add_item(discord.ui.TextInput(label="Standard price (credits)", custom_id="price", placeholder="10", max_length=10))
    m.add_item(discord.ui.TextInput(label="Description", custom_id="desc", style=discord.TextStyle.paragraph, required=False, max_length=400))
    m.add_item(discord.ui.TextInput(label="Stock (empty = unlimited)", custom_id="stock", placeholder="unlimited", required=False, max_length=12))
    return m


def _add_version_modal(product_key: str) -> discord.ui.Modal:
    m = discord.ui.Modal(
        title=f"Add version - {product_key}"[:45],
        custom_id=f"admin:addv:modal:{product_key}",
    )
    m.add_item(discord.ui.TextInput(label="Version name", custom_id="label", placeholder="12 Months", max_length=100))
    m.add_item(discord.ui.TextInput(label="Price (credits)", custom_id="price", placeholder="50", max_length=10))
    m.add_item(discord.ui.TextInput(label="Stock (empty = unlimited)", custom_id="stock", placeholder="unlimited", required=False, max_length=12))
    m.add_item(discord.ui.TextInput(label="Delivery text (sent to buyer's DM)", custom_id="content", style=discord.TextStyle.paragraph, required=False, max_length=1500))
    return m


def _edit_product_modal(p: dict) -> discord.ui.Modal:
    m = discord.ui.Modal(title=f"Edit — {p['label']}"[:45], custom_id=f"admin:edp:modal:{p['key']}")
    m.add_item(discord.ui.TextInput(label="Display name", custom_id="label", default=p["label"], max_length=100))
    m.add_item(discord.ui.TextInput(label="Description (embed body)", custom_id="desc", style=discord.TextStyle.paragraph, default=(p.get("desc") or "")[:400], required=False, max_length=400))
    m.add_item(discord.ui.TextInput(
        label="Emoji (unicode / custom / ID)",
        custom_id="emoji",
        default=(p.get("emoji") or "")[:100],
        placeholder="🎧  or  <a:v2_dot:1552633964085383299>",
        required=False,
        max_length=100,
    ))
    m.add_item(discord.ui.TextInput(
        label="Color (name or hex, blank = default)",
        custom_id="color",
        default=(p.get("color") or "")[:100],
        placeholder="red, pink, black, blue, green, white… or #E50914",
        required=False,
        max_length=100,
    ))
    m.add_item(discord.ui.TextInput(label="Flags (soon, hidden, once — empty = none)", custom_id="flags", default=_flags_plain(p), required=False, max_length=50))
    return m


def _edit_version_modal(value: str, v: dict) -> discord.ui.Modal:
    m = discord.ui.Modal(title=f"Edit — {v['label']}"[:45], custom_id=f"admin:edv:modal:{value}")
    m.add_item(discord.ui.TextInput(label="Version name", custom_id="label", default=v["label"], max_length=100))
    m.add_item(discord.ui.TextInput(label="Price (credits)", custom_id="price", default=str(v["price"]), max_length=10))
    m.add_item(discord.ui.TextInput(label="Stock (unlimited or a number)", custom_id="stock", default=("unlimited" if v["stock"] is None else str(v["stock"])), required=False, max_length=12))
    m.add_item(discord.ui.TextInput(label="Delivery text (sent to buyer's DM)", custom_id="content", style=discord.TextStyle.paragraph, default=(v.get("content") or "")[:1500], required=False, max_length=1500))
    return m


def _add_payment_modal() -> discord.ui.Modal:
    m = discord.ui.Modal(title="Add Payment Method", custom_id="admin:addpm:modal")
    m.add_item(discord.ui.TextInput(label="Name", custom_id="label", placeholder="PayPal", max_length=100))
    m.add_item(discord.ui.TextInput(
        label="Emoji (unicode / custom / ID)",
        custom_id="emoji",
        placeholder="🎧  or  <a:v2_dot:1552633964085383299>",
        required=False,
        max_length=100,
    ))
    m.add_item(discord.ui.TextInput(
        label="Link (optional — becomes an Open button)",
        custom_id="url",
        placeholder="https://paypal.me/yourname",
        required=False,
        max_length=400,
    ))
    m.add_item(discord.ui.TextInput(
        label="Instructions (shown when there's no link)",
        custom_id="details",
        style=discord.TextStyle.paragraph,
        placeholder="Send to $yourtag, then post the screenshot in #payments.",
        required=False,
        max_length=400,
    ))
    return m


def _edit_payment_modal(pm: dict) -> discord.ui.Modal:
    m = discord.ui.Modal(title=f"Edit — {pm['label']}"[:45], custom_id=f"admin:edpm:modal:{pm['id']}")
    m.add_item(discord.ui.TextInput(label="Name", custom_id="label", default=pm["label"], max_length=100))
    m.add_item(discord.ui.TextInput(
        label="Emoji (unicode / custom / ID)",
        custom_id="emoji",
        default=(pm.get("emoji") or "")[:100],
        placeholder="🎧  or  <a:v2_dot:1552633964085383299>",
        required=False,
        max_length=100,
    ))
    m.add_item(discord.ui.TextInput(
        label="Link (optional — becomes an Open button)",
        custom_id="url",
        default=(pm.get("url") or "")[:400],
        placeholder="https://paypal.me/yourname",
        required=False,
        max_length=400,
    ))
    m.add_item(discord.ui.TextInput(
        label="Instructions (shown when there's no link)",
        custom_id="details",
        style=discord.TextStyle.paragraph,
        default=(pm.get("details") or "")[:400],
        placeholder="Send to $yourtag, then post the screenshot in #payments.",
        required=False,
        max_length=400,
    ))
    return m


# ---------------------------------------------------------------- buttons

@router.button("admin:home")
async def admin_home(interaction: discord.Interaction, _rest: list[str]):
    if not await _guard(interaction):
        return
    await interaction.response.edit_message(embeds=[_dashboard_embed()], view=_dashboard_view())


@router.button("admin:list")
async def admin_list(interaction: discord.Interaction, _rest: list[str]):
    if not await _guard(interaction):
        return
    products = db.list_products(include_hidden=True)
    if not products:
        embed = _prompt_embed("Catalog", "The catalog is empty.")
    else:
        fields = []
        for p in products:
            body = "\n".join(_version_line(v) for v in p["versions"]) or "No versions."
            fields.append((f"{p.get('emoji', '')} {p['label']} (`{p['key']}`){_flags(p)}", body, False))
        embed = embeds.branded_embed(title="Catalog", fields=fields[:25], hero=False, shop=False)
    await interaction.response.edit_message(embeds=[embed], view=_dashboard_view())


@router.button("admin:addp")
async def admin_addp(interaction: discord.Interaction, _rest: list[str]):
    if not await _guard(interaction):
        return
    await interaction.response.send_modal(_add_product_modal())


@router.button("admin:edp")
async def admin_edp(interaction: discord.Interaction, _rest: list[str]):
    if not await _guard(interaction):
        return
    rows = _product_select_rows("admin:edp:pick", "Pick a product to edit…")
    if rows is None:
        await interaction.response.edit_message(embeds=[_prompt_embed("Edit Product", "The catalog is empty.")], view=_result_view())
        return
    await interaction.response.edit_message(
        embeds=[_prompt_embed("Edit Product", "Pick the product you want to edit.")], view=router.make_view(rows)
    )


@router.button("admin:edp:open")
async def admin_edp_open(interaction: discord.Interaction, rest: list[str]):
    """Jump straight into a product's edit form (used by the add-product receipt)."""
    if not await _guard(interaction):
        return
    p = db.get_product(":".join(rest))
    if p is None:
        await _fail(interaction, "That product no longer exists.")
        return
    await interaction.response.send_modal(_edit_product_modal(p))


@router.button("admin:edpm:open")
async def admin_edpm_open(interaction: discord.Interaction, rest: list[str]):
    """Jump straight into a payment method's edit form (from the add receipt)."""
    if not await _guard(interaction):
        return
    pm = db.get_payment_method(":".join(rest))
    if pm is None:
        await _fail(interaction, "That payment method no longer exists.")
        return
    await interaction.response.send_modal(_edit_payment_modal(pm))


@router.button("admin:rmp")
async def admin_rmp(interaction: discord.Interaction, _rest: list[str]):
    if not await _guard(interaction):
        return
    rows = _product_select_rows("admin:rmp:pick", "Pick a product to remove…")
    if rows is None:
        await interaction.response.edit_message(embeds=[_prompt_embed("Remove Product", "The catalog is empty.")], view=_result_view())
        return
    await interaction.response.edit_message(
        embeds=[_prompt_embed("Remove Product", "Pick the product you want to remove.")], view=router.make_view(rows)
    )


@router.button("admin:addv")
async def admin_addv(interaction: discord.Interaction, _rest: list[str]):
    if not await _guard(interaction):
        return
    rows = _product_select_rows("admin:addv:pick", "Pick a product to add a version to…")
    if rows is None:
        await interaction.response.edit_message(embeds=[_prompt_embed("Add Version", "Add a product first — the catalog is empty.")], view=_result_view())
        return
    await interaction.response.edit_message(
        embeds=[_prompt_embed("Add Version", "Pick which product gets the new version.")], view=router.make_view(rows)
    )


@router.button("admin:edv")
async def admin_edv(interaction: discord.Interaction, _rest: list[str]):
    if not await _guard(interaction):
        return
    rows = _product_select_rows("admin:edv:prod", "Pick a product…")
    if rows is None:
        await interaction.response.edit_message(embeds=[_prompt_embed("Edit Version", "The catalog is empty.")], view=_result_view())
        return
    await interaction.response.edit_message(
        embeds=[_prompt_embed("Edit Version", "Pick which product owns the version.")], view=router.make_view(rows)
    )


@router.button("admin:rmv")
async def admin_rmv(interaction: discord.Interaction, _rest: list[str]):
    if not await _guard(interaction):
        return
    rows = _product_select_rows("admin:rmv:prod", "Pick a product…")
    if rows is None:
        await interaction.response.edit_message(embeds=[_prompt_embed("Remove Version", "The catalog is empty.")], view=_result_view())
        return
    await interaction.response.edit_message(
        embeds=[_prompt_embed("Remove Version", "Pick which product owns the version.")], view=router.make_view(rows)
    )


@router.button("admin:addpm")
async def admin_addpm(interaction: discord.Interaction, _rest: list[str]):
    if not await _guard(interaction):
        return
    await interaction.response.send_modal(_add_payment_modal())


@router.button("admin:edpm")
async def admin_edpm(interaction: discord.Interaction, _rest: list[str]):
    if not await _guard(interaction):
        return
    rows = _payment_select_rows("admin:edpm:pick", "Pick a payment method to edit…")
    if rows is None:
        await interaction.response.edit_message(
            embeds=[_prompt_embed("Edit Payment Method", "No payment methods yet — add one first.")], view=_result_view()
        )
        return
    await interaction.response.edit_message(
        embeds=[_prompt_embed("Edit Payment Method", "Pick the payment method you want to edit.")],
        view=router.make_view(rows),
    )


@router.button("admin:rmpm")
async def admin_rmpm(interaction: discord.Interaction, _rest: list[str]):
    if not await _guard(interaction):
        return
    rows = _payment_select_rows("admin:rmpm:pick", "Pick a payment method to remove…")
    if rows is None:
        await interaction.response.edit_message(
            embeds=[_prompt_embed("Remove Payment Method", "No payment methods yet — nothing to remove.")],
            view=_result_view(),
        )
        return
    await interaction.response.edit_message(
        embeds=[_prompt_embed("Remove Payment Method", "Pick the payment method you want to remove.")],
        view=router.make_view(rows),
    )


@router.button("admin:rmp:go")
async def admin_rmp_go(interaction: discord.Interaction, rest: list[str]):
    if not await _guard(interaction):
        return
    key = ":".join(rest)
    try:
        db.delete_product(key)
    except ValueError as err:
        await _fail(interaction, str(err))
        return
    embed = _prompt_embed("Product removed", f"`{key}` and all its versions are gone from the catalog.")
    await _show(interaction, embed, _result_view())


@router.button("admin:rmv:go")
async def admin_rmv_go(interaction: discord.Interaction, rest: list[str]):
    if not await _guard(interaction):
        return
    value = ":".join(rest)
    try:
        db.delete_version(value)
    except ValueError as err:
        await _fail(interaction, str(err))
        return
    embed = _prompt_embed("Version removed", f"**{value}** is gone.")
    await _show(interaction, embed, _result_view())


@router.button("admin:rmpm:go")
async def admin_rmpm_go(interaction: discord.Interaction, rest: list[str]):
    if not await _guard(interaction):
        return
    pm_id = ":".join(rest)
    pm = db.get_payment_method(pm_id)
    if pm is None:
        await _fail(interaction, "That payment method no longer exists.")
        return
    try:
        db.delete_payment_method(pm_id)
    except ValueError as err:
        await _fail(interaction, str(err))
        return
    embed = _prompt_embed(
        "Payment method removed",
        f"**{pm['label']}** is no longer offered under the Bank button.",
    )
    await _show(interaction, embed, _result_view())


@router.button("admin:notes")
async def admin_notes(interaction: discord.Interaction, _rest: list[str]):
    """Newest-first log of the notes customers were told to paste in."""
    if not await _guard(interaction):
        return
    rows = db.recent_payment_notes()
    if not rows:
        embed = _prompt_embed("Payment Notes", "No notes have been generated yet.")
    else:
        def _line(n: dict) -> str:
            bits = [f"<@{n['user_id']}>", f"**{n['note']}**"]
            if n.get("amount"):
                bits.append(n["amount"])
            if n.get("context"):
                bits.append(n["context"])
            bits.append(n["method_label"])
            bits.append(f"<t:{int(n['created_at']) // 1000}:R>")
            return " • ".join(bits)

        lines = [_line(n) for n in rows[:25]]
        embed = embeds.branded_embed(
            title="Payment Notes",
            description="\n\n".join(lines),
            hero=False,
            shop=False,
        )
    await interaction.response.edit_message(embeds=[embed], view=_dashboard_view())


# ---------------------------------------------------------------- selects

@router.select("admin:edp:pick")
async def admin_edp_pick(interaction: discord.Interaction, values: list[str]):
    if not await _guard(interaction):
        return
    p = db.get_product(values[0])
    if p is None:
        await _fail(interaction, "That product no longer exists.")
        return
    await interaction.response.send_modal(_edit_product_modal(p))


@router.select("admin:rmp:pick")
async def admin_rmp_pick(interaction: discord.Interaction, values: list[str]):
    if not await _guard(interaction):
        return
    key = values[0]
    p = db.get_product(key)
    if p is None:
        await _fail(interaction, "That product no longer exists.")
        return
    embed = _prompt_embed(
        "Confirm removal",
        f"Remove **{p['label']}** (`{p['key']}`) and all {len(p['versions'])} of its versions?\n\nThis cannot be undone.",
    )
    view = router.make_view(
        [
            [
                {"custom_id": f"admin:rmp:go:{key}", "label": "Remove", "style": discord.ButtonStyle.danger},
                {"custom_id": "admin:home", "label": "Cancel", "style": discord.ButtonStyle.secondary},
            ]
        ]
    )
    await interaction.response.edit_message(embeds=[embed], view=view)


@router.select("admin:addv:pick")
async def admin_addv_pick(interaction: discord.Interaction, values: list[str]):
    if not await _guard(interaction):
        return
    key = values[0]
    if db.get_product(key) is None:
        await _fail(interaction, "That product no longer exists.")
        return
    await interaction.response.send_modal(_add_version_modal(key))


@router.select("admin:edv:prod")
async def admin_edv_prod(interaction: discord.Interaction, values: list[str]):
    if not await _guard(interaction):
        return
    key = values[0]
    rows = _version_select_rows(key, "admin:edv:ver", "Pick a version to edit…")
    if rows is None:
        await _fail(interaction, f"`{key}` has no versions.")
        return
    p = db.get_product(key)
    embed = _prompt_embed("Edit Version", f"Pick a version of **{p['label']}**.")
    await interaction.response.edit_message(embeds=[embed], view=router.make_view(rows))


@router.select("admin:edv:ver")
async def admin_edv_ver(interaction: discord.Interaction, values: list[str]):
    if not await _guard(interaction):
        return
    value = values[0]
    _p, v = db.find_version(value)
    if v is None:
        await _fail(interaction, "That version no longer exists.")
        return
    await interaction.response.send_modal(_edit_version_modal(value, v))


@router.select("admin:rmv:prod")
async def admin_rmv_prod(interaction: discord.Interaction, values: list[str]):
    if not await _guard(interaction):
        return
    key = values[0]
    rows = _version_select_rows(key, "admin:rmv:ver", "Pick a version to remove…")
    if rows is None:
        await _fail(interaction, f"`{key}` has no versions.")
        return
    p = db.get_product(key)
    embed = _prompt_embed("Remove Version", f"Pick a version of **{p['label']}** to remove.")
    await interaction.response.edit_message(embeds=[embed], view=router.make_view(rows))


@router.select("admin:rmv:ver")
async def admin_rmv_ver(interaction: discord.Interaction, values: list[str]):
    if not await _guard(interaction):
        return
    value = values[0]
    _p, v = db.find_version(value)
    if v is None:
        await _fail(interaction, "That version no longer exists.")
        return
    embed = _prompt_embed(
        "Confirm removal",
        f"Remove **{v['label']}** ({v['price']} credits, {_stock_text(v['stock'])})?\n\nThis cannot be undone.",
    )
    view = router.make_view(
        [
            [
                {"custom_id": f"admin:rmv:go:{value}", "label": "Remove", "style": discord.ButtonStyle.danger},
                {"custom_id": "admin:home", "label": "Cancel", "style": discord.ButtonStyle.secondary},
            ]
        ]
    )
    await interaction.response.edit_message(embeds=[embed], view=view)


@router.select("admin:edpm:pick")
async def admin_edpm_pick(interaction: discord.Interaction, values: list[str]):
    if not await _guard(interaction):
        return
    pm = db.get_payment_method(values[0] if values else None)
    if pm is None:
        await _fail(interaction, "That payment method no longer exists.")
        return
    await interaction.response.send_modal(_edit_payment_modal(pm))


@router.select("admin:rmpm:pick")
async def admin_rmpm_pick(interaction: discord.Interaction, values: list[str]):
    if not await _guard(interaction):
        return
    pm = db.get_payment_method(values[0] if values else None)
    if pm is None:
        await _fail(interaction, "That payment method no longer exists.")
        return
    shown = f"a link button → {pm['url']}" if pm["url"] else "your instructions"
    embed = _prompt_embed(
        "Confirm removal",
        f"Remove **{pm['label']}**? Customers would lose {shown}.\n\nThis cannot be undone.",
    )
    view = router.make_view(
        [
            [
                {"custom_id": f"admin:rmpm:go:{pm['id']}", "label": "Remove", "style": discord.ButtonStyle.danger},
                {"custom_id": "admin:home", "label": "Cancel", "style": discord.ButtonStyle.secondary},
            ]
        ]
    )
    await interaction.response.edit_message(embeds=[embed], view=view)


# ---------------------------------------------------------------- modals

@router.modal("admin:addp:modal")
async def admin_addp_modal(interaction: discord.Interaction, _rest: list[str]):
    if not await _guard(interaction):
        return
    v = _modal_values(interaction)
    try:
        price = _parse_price(v.get("price", ""))
        stock = _parse_stock(v.get("stock", ""))
    except ValueError as err:
        await _fail(interaction, str(err))
        return
    key = (v.get("key") or "").strip().lower().replace(" ", "_")
    label = (v.get("label") or "").strip()
    if not key or not label:
        await _fail(interaction, "Key and display name are required.")
        return
    try:
        db.add_product(key, label, v.get("desc", ""), "")
        db.add_version(key, "Standard", price, stock, content="")
    except ValueError as err:
        await _fail(interaction, str(err))
        return
    embed = _prompt_embed(
        "Product added",
        f"**{label}** (`{key}`) with **Standard** — {price} credits ({_stock_text(stock)}).\n\n"
        "Use **Edit details** to give it an emoji and an embed color.",
    )
    view = router.make_view(
        [
            [
                {"custom_id": f"admin:edp:open:{key}", "label": "Edit details", "style": discord.ButtonStyle.secondary},
                *_home_row(),
            ]
        ]
    )
    await _show(interaction, embed, view)


@router.modal("admin:addv:modal")
async def admin_addv_modal(interaction: discord.Interaction, rest: list[str]):
    if not await _guard(interaction):
        return
    key = ":".join(rest)
    v = _modal_values(interaction)
    try:
        price = _parse_price(v.get("price", ""))
        stock = _parse_stock(v.get("stock", ""))
    except ValueError as err:
        await _fail(interaction, str(err))
        return
    label = (v.get("label") or "").strip()
    if not label:
        await _fail(interaction, "Version name is required.")
        return
    try:
        db.add_version(key, label, price, stock, content=v.get("content", ""))
    except ValueError as err:
        await _fail(interaction, str(err))
        return
    embed = _prompt_embed(
        "Version added",
        f"**{label}** on `{key}` — {price} credits ({_stock_text(stock)}).",
    )
    await _show(interaction, embed, _result_view())


@router.modal("admin:edp:modal")
async def admin_edp_modal(interaction: discord.Interaction, rest: list[str]):
    if not await _guard(interaction):
        return
    key = ":".join(rest)
    v = _modal_values(interaction)
    color_raw = (v.get("color") or "").strip()
    try:
        emoji = _normalize_emoji(v.get("emoji", ""), getattr(interaction, "client", None))
        embeds.parse_color(color_raw)  # validate now so a typo can't be stored
    except ValueError as err:
        await _fail(interaction, str(err))
        return
    try:
        db.update_product(
            key,
            label=(v.get("label") or "").strip(),
            desc=v.get("desc", ""),
            emoji=emoji,
            color=color_raw,
            **_parse_flags(v.get("flags", "")),
        )
    except ValueError as err:
        await _fail(interaction, str(err))
        return
    p = db.get_product(key)
    embed = _prompt_embed(
        "Product updated",
        f"**{p['label']}** (`{p['key']}`){_flags(p)}\n\n"
        f"Emoji: {p.get('emoji') or '—'}\n"
        f"Color: `{p.get('color') or 'default'}`\n"
        f"Description: {p.get('desc') or '—'}",
    )
    await _show(interaction, embed, _result_view())


@router.modal("admin:edv:modal")
async def admin_edv_modal(interaction: discord.Interaction, rest: list[str]):
    if not await _guard(interaction):
        return
    value = ":".join(rest)
    v = _modal_values(interaction)
    try:
        price = _parse_price(v.get("price", ""))
        stock = _parse_stock(v.get("stock", ""))
    except ValueError as err:
        await _fail(interaction, str(err))
        return
    label = (v.get("label") or "").strip()
    if not label:
        await _fail(interaction, "Version name is required.")
        return
    try:
        db.update_version(value, label=label, price=price, stock=stock, content=v.get("content", ""))
    except ValueError as err:
        await _fail(interaction, str(err))
        return
    _p, updated = db.find_version(value)
    embed = _prompt_embed("Version updated", _version_line(updated))
    await _show(interaction, embed, _result_view())


@router.modal("admin:addpm:modal")
async def admin_addpm_modal(interaction: discord.Interaction, _rest: list[str]):
    if not await _guard(interaction):
        return
    v = _modal_values(interaction)
    label = (v.get("label") or "").strip()
    if not label:
        await _fail(interaction, "A payment method needs a name.")
        return
    try:
        emoji = _normalize_emoji(v.get("emoji", ""), getattr(interaction, "client", None))
        url = _parse_url(v.get("url", ""))
    except ValueError as err:
        await _fail(interaction, str(err))
        return
    try:
        pm_id = db.add_payment_method(label, emoji, url, (v.get("details") or "").strip())
    except ValueError as err:
        await _fail(interaction, str(err))
        return
    how = f"an **Open** button → {url}" if url else "your instructions"
    embed = _prompt_embed(
        "Payment method added",
        f"**{label}** is now in the Bank dropdown — customers get {how}.\n\n"
        f"Emoji: {emoji or '—'}",
    )
    view = router.make_view(
        [
            [
                {"custom_id": f"admin:edpm:open:{pm_id}", "label": "Edit details", "style": discord.ButtonStyle.secondary},
                *_home_row(),
            ]
        ]
    )
    await _show(interaction, embed, view)


@router.modal("admin:edpm:modal")
async def admin_edpm_modal(interaction: discord.Interaction, rest: list[str]):
    if not await _guard(interaction):
        return
    pm_id = ":".join(rest)
    v = _modal_values(interaction)
    label = (v.get("label") or "").strip()
    if not label:
        await _fail(interaction, "A payment method needs a name.")
        return
    try:
        emoji = _normalize_emoji(v.get("emoji", ""), getattr(interaction, "client", None))
        url = _parse_url(v.get("url", ""))
    except ValueError as err:
        await _fail(interaction, str(err))
        return
    try:
        db.update_payment_method(pm_id, label=label, emoji=emoji, url=url, details=(v.get("details") or "").strip())
    except ValueError as err:
        await _fail(interaction, str(err))
        return
    pm = db.get_payment_method(pm_id)
    if pm is None:
        await _fail(interaction, "That payment method no longer exists.")
        return
    embed = _prompt_embed(
        "Payment method updated",
        f"**{pm['label']}**\n\n"
        f"Emoji: {pm['emoji'] or '—'}\n"
        f"Link: {pm['url'] or '—'}\n"
        f"Instructions: {pm['details'] or '—'}",
    )
    await _show(interaction, embed, _result_view())


class AdminCog(commands.Cog):
    """Owner-only /admin — dashboard embed with buttons + modal dispatcher."""

    def __init__(self, bot: commands.Bot):
        self.bot = bot

    @commands.Cog.listener()
    async def on_interaction(self, interaction: discord.Interaction):
        # Modals have no discord.py View tracking them, so route admin
        # modal submits here. Narrowed to modal_submit + the admin: prefix
        # so kiosk/components keep flowing to their own handlers.
        if interaction.type is not discord.InteractionType.modal_submit:
            return
        custom_id = ((interaction.data or {}).get("custom_id") or "")
        if not custom_id.startswith("admin:"):
            return
        fn, rest = router._match_handler(router.MODALS, custom_id)
        if fn is None:
            try:
                await interaction.response.send_message("That form expired — open /admin again.", ephemeral=True)
            except discord.DiscordException:
                pass
            return
        await fn(interaction, rest)

    @app_commands.command(name="admin", description="Store management dashboard")
    async def admin(self, interaction: discord.Interaction):
        if not await _guard(interaction):
            return
        await interaction.response.send_message(
            embeds=[_dashboard_embed()], view=_dashboard_view(), ephemeral=True
        )


async def setup(bot: commands.Bot):
    await bot.add_cog(AdminCog(bot))
