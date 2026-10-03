"""Default product catalog.

A version entry is `{label, value, price}` where price is in credits
($1 = 1 credit). `once` products can only be bought a single time per user.
"""

from __future__ import annotations

PRODUCTS: list[dict] = [
    {
        "key": "nsfw_vip",
        "label": "SOON",
        "desc": "Coming soon!",
        "emoji": "🔒",
        "coming_soon": True,
        "versions": [{"label": "Standard", "value": "nsfw_vip:standard", "price": 5}],
    },
    {
        "key": "spotify",
        "label": "Lifetime Spotify Premium",
        "desc": "Your account, upgraded.",
        "emoji": "🎧",
        "versions": [
            {"label": "1 Month", "value": "spotify:1m", "price": 20},
            {"label": "3 Months", "value": "spotify:3m", "price": 50},
            {"label": "Lifetime", "value": "spotify:lifetime", "price": 120},
        ],
    },
    {
        "key": "netflix",
        "label": "HD Netflix",
        "desc": "HD viewing on your own account.",
        "emoji": "🍿",
        "versions": [
            {"label": "1 Month", "value": "netflix:1m", "price": 25},
            {"label": "3 Months", "value": "netflix:3m", "price": 60},
            {"label": "6 Months", "value": "netflix:6m", "price": 100},
        ],
    },
    {
        "key": "hbomax",
        "label": "HBO Max",
        "desc": "Stream everything HBO.",
        "emoji": "🦉",
        "versions": [
            {"label": "1 Month", "value": "hbomax:1m", "price": 20},
            {"label": "3 Months", "value": "hbomax:3m", "price": 50},
            {"label": "6 Months", "value": "hbomax:6m", "price": 90},
        ],
    },
    {
        "key": "disney",
        "label": "Disney+",
        "desc": "Disney, Pixar, Marvel, Star Wars.",
        "emoji": "✨",
        "versions": [
            {"label": "1 Month", "value": "disney:1m", "price": 20},
            {"label": "3 Months", "value": "disney:3m", "price": 50},
            {"label": "6 Months", "value": "disney:6m", "price": 90},
        ],
    },
    {
        "key": "prime",
        "label": "Prime Video",
        "desc": "Amazon Prime Video on your account.",
        "emoji": "📺",
        "versions": [
            {"label": "1 Month", "value": "prime:1m", "price": 20},
            {"label": "3 Months", "value": "prime:3m", "price": 50},
            {"label": "6 Months", "value": "prime:6m", "price": 90},
        ],
    },
    {
        "key": "suppliers",
        "label": "Suppliers",
        "desc": "Fresh supplier accounts ready to go. Grab yours and start selling today.",
        "emoji": "🤝",
        "versions": [
            {"label": "Standard", "value": "suppliers:standard", "price": 10, "content": "[placeholder delivery]"},
        ],
    },
    {
        "key": "tiktok_users",
        "label": "TikTok Users",
        "desc": "Aged TikTok accounts with real engagement. Perfect for growth.",
        "emoji": "🎵",
        "versions": [
            {"label": "Standard", "value": "tiktok_users:standard", "price": 10, "content": "[placeholder delivery]"},
        ],
    },
    {
        "key": "discord_nitro",
        "label": "Discord Nitro",
        "desc": "Full Discord Nitro — boosted uploads, custom emoji, HD streaming.",
        "emoji": "🎮",
        "versions": [
            {"label": "1 Month", "value": "discord_nitro:1m", "price": 15, "content": "[placeholder delivery]"},
        ],
    },
    {
        "key": "twitter_accounts",
        "label": "Twitter Accounts",
        "desc": "Aged Twitter/X accounts ready for marketing and engagement.",
        "emoji": "🐦",
        "versions": [
            {"label": "Standard", "value": "twitter_accounts:standard", "price": 10, "content": "[placeholder delivery]"},
        ],
    },
]


def find_product(key: str):
    return next((p for p in PRODUCTS if p["key"] == key), None)


def find_version(product: dict, value: str):
    return next((v for v in product["versions"] if v["value"] == value), None)