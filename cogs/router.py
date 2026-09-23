"""Central component routing.

One dispatcher routes every button/select by its custom_id (mirrors the old
Node interactionCreate.js). Persistent buttons live in long-lived views that
are re-registered on startup, so a restart never orphans the role picker or
ticket controls.

custom_ids look like "kind:action:extra...". Handlers are found by trying the
full id, then progressively shorter prefixes.
"""

from __future__ import annotations

import discord

BUTTONS: dict[str, object] = {}
SELECTS: dict[str, object] = {}
MODALS: dict[str, object] = {}


def button(custom_id: str):
    """Decorator: register a button handler `fn(interaction, rest_parts)`."""

    def deco(fn):
        BUTTONS[custom_id] = fn
        return fn

    return deco


def select(custom_id: str):
    """Decorator: register a select handler `fn(interaction, values)`."""

    def deco(fn):
        SELECTS[custom_id] = fn
        return fn

    return deco


def modal(custom_id: str):
    """Decorator: register a modal-submit handler `fn(interaction)`."""

    def deco(fn):
        MODALS[custom_id] = fn
        return fn

    return deco


def _match_handler(handlers: dict, custom_id: str):
    parts = custom_id.split(":")
    for i in range(len(parts), 0, -1):
        fn = handlers.get(":".join(parts[:i]))
        if fn:
            return fn, parts[i:]
    return None, []


class RouterButton(discord.ui.Button):
    def __init__(self, custom_id: str, label: str, style: discord.ButtonStyle = discord.ButtonStyle.secondary, emoji=None, disabled=False):
        super().__init__(style=style, label=label, emoji=emoji, custom_id=custom_id, disabled=disabled)

    async def callback(self, interaction: discord.Interaction):
        fn, rest = _match_handler(BUTTONS, self.custom_id)
        if fn is None:
            await interaction.response.send_message("That button is stale — run the command again.", ephemeral=True)
            return
        await fn(interaction, rest)


class RouterSelect(discord.ui.Select):
    def __init__(self, custom_id: str, placeholder: str, options: list[discord.SelectOption]):
        super().__init__(custom_id=custom_id, placeholder=placeholder, options=options)

    async def callback(self, interaction: discord.Interaction):
        fn, _rest = _match_handler(SELECTS, self.custom_id)
        if fn is None:
            await interaction.response.send_message("That menu is stale — run the command again.", ephemeral=True)
            return
        await fn(interaction, self.values)


def make_view(rows: list[list[dict]]) -> discord.ui.View:
    """Build a short-lived view from a spec: each row is a list of button/select dicts."""
    view = discord.ui.View(timeout=600)
    for row_items in rows:
        for cfg in row_items:
            if cfg.get("type") == "select":
                view.add_item(RouterSelect(cfg["custom_id"], cfg.get("placeholder", "Choose…"), cfg["options"]))
            else:
                view.add_item(
                    RouterButton(
                        custom_id=cfg["custom_id"],
                        label=cfg.get("label", "…"),
                        style=cfg.get("style", discord.ButtonStyle.secondary),
                        emoji=cfg.get("emoji"),
                        disabled=cfg.get("disabled", False),
                    )
                )
    return view


def build_persistent_view(button_spec: list[dict]) -> discord.ui.View:
    """Build a persistent (timeout=None) view from a flat button spec."""
    view = discord.ui.View(timeout=None)
    for cfg in button_spec:
        view.add_item(
            RouterButton(
                custom_id=cfg["custom_id"],
                label=cfg.get("label", "…"),
                style=cfg.get("style", discord.ButtonStyle.secondary),
                emoji=cfg.get("emoji"),
                disabled=cfg.get("disabled", False),
            )
        )
    return view