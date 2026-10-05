"""Payment notes for manual (non-crypto) methods.

Every time a customer picks a manual method they get a fresh note to paste
into their PayPal/Cash App/etc payment: a word (place, food, object, shape
or name) plus a short code, e.g.

    Enter this as note -> `House RUJXN8`

The word makes it human-readable; the code makes it unique enough to match
an incoming payment back to the customer who generated it.
"""

from __future__ import annotations

import random
import string

NOTE_PROMPT = "Enter this as note ->"

WORDS: list[str] = [
    # places
    "House", "Park", "Harbor", "Castle", "Valley",
    "Bridge", "Market", "Tower", "Garden", "Island",
    # food
    "Pizza", "Sushi", "Apple", "Bread", "Cookie",
    "Mango", "Steak", "Salad", "Coffee", "Waffle",
    # objects
    "Lamp", "Hammer", "Mirror", "Anchor", "Candle",
    "Compass", "Wallet", "Lantern", "Pillow", "Rocket",
    # shapes
    "Circle", "Square", "Triangle", "Diamond", "Spiral",
    "Arrow", "Star", "Hexagon", "Crescent", "Oval",
    # names
    "Oliver", "Mia", "Noah", "Ava", "Liam",
    "Emma", "Lucas", "Zoe", "Ethan", "Ruby",
]

CODE_LETTERS = 5


def generate_code() -> str:
    """5 uppercase letters + a digit, e.g. RUJXN8."""
    letters = "".join(random.choices(string.ascii_uppercase, k=CODE_LETTERS))
    return letters + random.choice(string.digits)


def generate_note() -> str:
    """A fresh note: 'House RUJXN8'."""
    return f"{random.choice(WORDS)} {generate_code()}"


def note_line(note: str) -> str:
    """How the note is shown to the customer."""
    return f"{NOTE_PROMPT} `{note}`"
