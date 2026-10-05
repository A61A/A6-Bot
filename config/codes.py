"""Redeem codes the owner hands out from /admin → Redeem Codes.

Customers paste one into Pocket → Redeem. The shape is

    A6-4KTP-9WZR

— the brand short, a dash, then two groups of four. The alphabet drops
I, O, 0 and 1 so a code is still readable when it arrives as a screenshot.
"""

from __future__ import annotations

import random

from config import embeds

ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
SEGMENT = 4


def prefix() -> str:
    """Letters of BRAND_SHORT, so the code matches the hint on the redeem form."""
    raw = "".join(ch for ch in embeds.BRAND_SHORT.upper() if ch.isalnum())
    return raw[:6] or "A6"


def generate_code() -> str:
    """A fresh code: 'A6-4KTP-9WZR'."""
    def seg() -> str:
        return "".join(random.choices(ALPHABET, k=SEGMENT))

    return f"{prefix()}-{seg()}-{seg()}"
