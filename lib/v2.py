"""Components V2 panels sent via raw REST.

discord.py 2.7.1 ships no V2 builders and no IsComponentsV2 flag, so this
module hand-builds the exact JSON Discord expects (mirroring theme.js) and
sends it through ``bot.http``. Only used for the kiosk panel - everything
else stays on classic embeds.

Layout (same order as theme.js ``panel()``):
    banner gallery -> title text -> [fields text] -> [link buttons]
    -> hero gallery -> [footer text], all inside one accent-colored Container.
"""

from __future__ import annotations

import json

from discord.http import Route

# Component types (Discord API)
ACTION_ROW = 1
BUTTON = 2
TEXT_DISPLAY = 10
MEDIA_GALLERY = 12
SEPARATOR = 14
CONTAINER = 17

# Button styles
LINK_BUTTON = 5
PRIMARY_BUTTON = 1
SECONDARY_BUTTON = 2
SUCCESS_BUTTON = 3
DANGER_BUTTON = 4
_ACTION_STYLES = (PRIMARY_BUTTON, SECONDARY_BUTTON, SUCCESS_BUTTON, DANGER_BUTTON)

# Separator spacing (theme.js uses Small)
SPACING_SMALL = 1
SPACING_LARGE = 2

# MessageFlags.IsComponentsV2 - passed as a raw int since discord.py lacks it
V2_FLAG = 1 << 15  # 32768

ACCENT = 0x8B5CF6


def text_display(content: str) -> dict:
    return {"type": TEXT_DISPLAY, "content": content}


def separator(*, divider: bool = True, spacing: int = SPACING_SMALL) -> dict:
    return {"type": SEPARATOR, "divider": divider, "spacing": spacing}


def media_gallery(*urls: str) -> dict:
    return {
        "type": MEDIA_GALLERY,
        "items": [{"media": {"url": url}} for url in urls],
    }


def link_button(label: str, url: str, emoji: str | None = None) -> dict:
    btn: dict = {"type": BUTTON, "style": LINK_BUTTON, "label": label, "url": url}
    if emoji:
        btn["emoji"] = {"name": emoji}
    return btn


def action_button(
    custom_id: str,
    label: str,
    style: int = SECONDARY_BUTTON,
    emoji: str | None = None,
    disabled: bool = False,
) -> dict:
    """An interaction button: clicking it sends the bot an interaction.

    Unlike link buttons these need a handler. In this repo the ``kiosk:``
    prefix is reserved for raw-V2 buttons and dispatched by the kiosk cog -
    no classic-view custom_id starts with it, so double-handling is impossible.
    """
    btn: dict = {"type": BUTTON, "style": style, "label": label, "custom_id": custom_id}
    if emoji:
        btn["emoji"] = {"name": emoji}
    if disabled:
        btn["disabled"] = True
    return btn


def action_row(*buttons: dict) -> dict:
    return {"type": ACTION_ROW, "components": list(buttons)}


def container(*children: dict, accent: int = ACCENT) -> dict:
    return {"type": CONTAINER, "accent_color": accent, "components": list(children)}


def panel(
    title: str,
    brand: str,
    description: str | None = None,
    fields: list[tuple[str, str]] | None = None,
    buttons: list[dict] | None = None,
    banner: str | None = None,
    hero: str | None = None,
    footer: str | None = None,
    accent: int = ACCENT,
) -> dict:
    """Build a theme.js-style panel. Pass ``False``-as-None to hide banner/hero."""
    children: list[dict] = []

    if banner:
        children.append(media_gallery(banner))
        children.append(separator())

    heading = f"# {brand} ・ {title}"
    if description:
        heading += f"\n-# {description}"
    children.append(text_display(heading))

    if fields:
        children.append(separator())
        body = "\n\n".join(f"**{name}**\n{value}" for name, value in fields)
        children.append(text_display(body))

    if buttons:
        children.append(separator())
        children.append(action_row(*buttons[:5]))

    if hero:
        children.append(separator())
        children.append(media_gallery(hero))

    if footer:
        children.append(separator())
        children.append(text_display(f"-# {footer}"))

    # Containers hold at most 10 children - with every section present we
    # land on 11, so shed dividers from the end first (look stays intact).
    while len(children) > 10:
        dividers = [i for i, c in enumerate(children) if c.get("type") == SEPARATOR]
        if not dividers:
            break
        del children[dividers[-1]]

    return container(*children, accent=accent)


def validate_message_payload(payload: dict, filenames: set[str] | None = None) -> None:
    """Fail fast with a clear error instead of a cryptic Discord 400.

    Raises ValueError describing the first problem found.
    """
    filenames = filenames or set()

    if not (payload.get("flags", 0) & V2_FLAG):
        raise ValueError("payload is missing the Components V2 flag (32768)")
    if "embeds" in payload:
        raise ValueError("V2 messages cannot mix 'components' with 'embeds'")

    top = payload.get("components", [])
    if not top:
        raise ValueError("V2 message needs at least one top-level component")
    for comp in top:
        _validate_component(comp, "root")

    refs: set[str] = set()

    def collect(node: object) -> None:
        if isinstance(node, dict):
            url = node.get("media", {}).get("url") if isinstance(node.get("media"), dict) else None
            if isinstance(url, str) and url.startswith("attachment://"):
                refs.add(url.split("attachment://", 1)[1])
            for value in node.values():
                collect(value)
        elif isinstance(node, list):
            for value in node:
                collect(value)

    collect(top)
    missing = refs - filenames
    if missing:
        raise ValueError(f"panel references attachments that won't be uploaded: {sorted(missing)}")


def _validate_component(comp: dict, where: str) -> None:
    ctype = comp.get("type")
    if ctype == CONTAINER:
        accent = comp.get("accent_color", 0)
        if not isinstance(accent, int) or not 0 <= accent <= 0xFFFFFF:
            raise ValueError(f"{where}: container accent_color out of range")
        kids = comp.get("components", [])
        if not 1 <= len(kids) <= 10:
            raise ValueError(f"{where}: container needs 1-10 children, got {len(kids)}")
        for i, kid in enumerate(kids):
            _validate_component(kid, f"{where}.container[{i}]")
    elif ctype == TEXT_DISPLAY:
        content = comp.get("content", "")
        if not isinstance(content, str) or not 1 <= len(content) <= 4000:
            raise ValueError(f"{where}: text_display content must be 1-4000 chars")
    elif ctype == SEPARATOR:
        if comp.get("spacing") not in (SPACING_SMALL, SPACING_LARGE):
            raise ValueError(f"{where}: separator spacing must be 1 or 2")
    elif ctype == MEDIA_GALLERY:
        items = comp.get("items", [])
        if not 1 <= len(items) <= 10:
            raise ValueError(f"{where}: media_gallery needs 1-10 items")
        for i, item in enumerate(items):
            url = (item.get("media") or {}).get("url", "")
            if not isinstance(url, str) or not url:
                raise ValueError(f"{where}: gallery item {i} has no media url")
    elif ctype == ACTION_ROW:
        kids = comp.get("components", [])
        if not 1 <= len(kids) <= 5:
            raise ValueError(f"{where}: action row needs 1-5 buttons")
        for i, btn in enumerate(kids):
            _validate_button(btn, f"{where}.row[{i}]")
    else:
        raise ValueError(f"{where}: unexpected component type {ctype!r}")


def _validate_button(btn: dict, where: str) -> None:
    if btn.get("type") != BUTTON:
        raise ValueError(f"{where}: only buttons are allowed in kiosk rows")
    label = btn.get("label", "")
    if not isinstance(label, str) or not 1 <= len(label) <= 80:
        raise ValueError(f"{where}: button label must be 1-80 chars")
    if btn.get("style") == LINK_BUTTON:
        url = btn.get("url", "")
        if not isinstance(url, str) or not url.startswith("http"):
            raise ValueError(f"{where}: link button needs an http(s) url")
    elif btn.get("style") in _ACTION_STYLES:
        if "custom_id" not in btn:
            raise ValueError(f"{where}: action button needs a custom_id")
    else:
        raise ValueError(f"{where}: unknown button style {btn.get('style')!r} (want 1-5)")


def message_payload(container_dict: dict) -> dict:
    """Wrap a Container in a sendable V2 message payload."""
    return {"components": [container_dict], "flags": V2_FLAG}


async def send_panel(bot, channel_id: int | str, container_dict: dict, files=None) -> dict:
    """POST a V2 panel to a channel. Returns Discord's message object.

    ``files`` are discord.File handles (fresh per send) backing any
    ``attachment://`` urls in the galleries.
    """
    files = list(files or [])
    payload = message_payload(container_dict)
    validate_message_payload(payload, {f.filename for f in files})

    route = Route("POST", "/channels/{channel_id}/messages", channel_id=int(channel_id))
    if not files:
        return await bot.http.request(route, json=payload)

    form: list[dict] = [{"name": "payload_json", "value": json.dumps(payload)}]
    for i, f in enumerate(files):
        form.append(
            {
                "name": f"files[{i}]",
                "value": f.fp,
                "filename": f.filename,
                "content_type": "application/octet-stream",
            }
        )
    return await bot.http.request(route, form=form)
