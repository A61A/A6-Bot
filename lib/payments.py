"""Crypto checkout for topping up credits.

Providers are picked in this order (see .env): Plisio -> NowPayments ->
simulator. Everything is done by polling the provider API, so no webhook or
web server is required - which is exactly what makes it runnable from cmd.
"""

from __future__ import annotations

import asyncio
import os
import time
import uuid

import aiohttp

from lib import db

PAYMENT_TTL_MS = 20 * 60 * 1000  # 20 minutes per invoice
SIM_FINISH_MS = 16_000  # simulator auto-completes ~16s for testing

SUPPORTED_COINS = [
    {"value": "BTC", "label": "Bitcoin"},
    {"value": "LTC", "label": "Litecoin"},
    {"value": "ETH", "label": "Ethereum"},
    {"value": "SOL", "label": "Solana"},
]

_TIMEOUT = aiohttp.ClientTimeout(total=30)


def payment_provider() -> str:
    if os.getenv("PLISIO_API_KEY"):
        return "plisio"
    if os.getenv("NOWPAYMENTS_API_KEY"):
        return "nowpayments"
    return "sim"


def payment_currency() -> str:
    return os.getenv("PAYMENT_CURRENCY", "btc").upper()


# --------------------------------------------------------------------------
# Plisio
# --------------------------------------------------------------------------

async def plisio_create_invoice(amount_usd: float, currency: str) -> dict:
    payload = {
        "api_key": os.getenv("PLISIO_API_KEY"),
        "source_currency": "USD",
        "source_amount": str(amount_usd),
        "currency": currency.upper(),
        "order_number": f"a6{time.time() * 1000:.0f}",
        "order_name": "A6 balance top-up",
        "expire_min": "20",
    }
    async with aiohttp.ClientSession(timeout=_TIMEOUT) as session:
        async with session.get("https://api.plisio.net/api/v1/invoices/new", params=payload) as res:
            data = await res.json()
    if not data.get("status") == "success" or not (data.get("data") or {}).get("txn_id"):
        raise RuntimeError(f"Plisio create failed: {data.get('data', {}).get('message') or data.get('message')}")
    inv = data["data"]
    return {
        "provider_id": str(inv["txn_id"]),
        "checkout_url": inv.get("invoice_url"),
        "pay_amount": float(inv.get("invoice_total_sum") or 0),
        "pay_address": None,
    }


async def plisio_check(provider_id: str) -> dict:
    payload = {"api_key": os.getenv("PLISIO_API_KEY")}
    async with aiohttp.ClientSession(timeout=_TIMEOUT) as session:
        async with session.get(
            f"https://api.plisio.net/api/v1/invoices/{provider_id}", params=payload
        ) as res:
            data = await res.json()
    if data.get("status") != "success" or not data.get("data"):
        return {"status": "confirming"}
    inv = data["data"].get("invoice") or data["data"]
    status = str(inv.get("status", "")).lower()
    if status in ("completed", "success"):
        return {"status": "finished", "pay_address": inv.get("wallet_hash"), "pay_amount": _to_float(inv.get("amount"))}
    if status in ("failed", "error", "expired", "cancelled"):
        return {"status": "failed"}
    return {"status": "confirming" if status in ("pending", "pending internal") else "waiting"}


# --------------------------------------------------------------------------
# NowPayments
# --------------------------------------------------------------------------

async def np_create_payment(amount_usd: float, currency: str) -> dict:
    body = {
        "price_amount": amount_usd,
        "price_currency": "usd",
        "pay_currency": currency.lower(),
        "order_id": f"a6{time.time() * 1000:.0f}",
        "order_description": "A6 balance top-up",
    }
    headers = {"Content-Type": "application/json", "x-api-key": os.getenv("NOWPAYMENTS_API_KEY")}
    async with aiohttp.ClientSession(timeout=_TIMEOUT) as session:
        async with session.post("https://api.nowpayments.io/v1/payment", json=body, headers=headers) as res:
            data = await res.json()
    if not data.get("payment_id"):
        raise RuntimeError(f"NowPayments create failed ({data.get('message') or data})")
    return {
        "provider_id": str(data["payment_id"]),
        "checkout_url": None,
        "pay_amount": float(data.get("pay_amount") or 0),
        "pay_address": data.get("pay_address"),
    }


async def np_check(provider_id: str) -> dict:
    headers = {"x-api-key": os.getenv("NOWPAYMENTS_API_KEY")}
    async with aiohttp.ClientSession(timeout=_TIMEOUT) as session:
        async with session.get(f"https://api.nowpayments.io/v1/payment/{provider_id}/status", headers=headers) as res:
            data = await res.json()
    status = str(data.get("payment_status", "")).lower()
    if status == "finished":
        return {"status": "finished"}
    if status == "failed":
        return {"status": "failed"}
    return {"status": "waiting" if status == "waiting" else "confirming"}


# --------------------------------------------------------------------------
# Public API
# --------------------------------------------------------------------------

async def create_payment(user_id: str, amount_usd: float, currency: str) -> dict:
    """Create an invoice for topping up credits. Returns display fields."""
    currency = (currency or payment_currency()).upper()
    provider = payment_provider()
    created = {
        "provider_id": None,
        "checkout_url": None,
        "pay_address": None,
        "pay_amount": amount_usd,
    }
    if provider == "plisio":
        created = await plisio_create_invoice(amount_usd, currency)
    elif provider == "nowpayments":
        created = await np_create_payment(amount_usd, currency)

    payment_id = db.insert_payment(
        user_id=str(user_id),
        kind="deposit",
        amount_usd=amount_usd,
        currency=currency,
        provider=provider,
        provider_id=created["provider_id"],
        pay_address=created["pay_address"],
        pay_amount=created["pay_amount"],
        checkout_url=created["checkout_url"],
        note=currency,
        ttl_ms=PAYMENT_TTL_MS,
    )
    return {
        "payment_id": payment_id,
        "provider": provider,
        "checkout_url": created["checkout_url"],
        "pay_address": created["pay_address"],
        "pay_amount": created["pay_amount"],
        "pay_currency": currency,
    }


async def check_payment(payment: db.sqlite3.Row) -> dict:
    """Poll one pending payment; returns a status dict {status, ...}."""
    provider_id = str(payment["provider_id"])
    provider = payment["provider"]
    if provider == "plisio":
        return await plisio_check(provider_id)
    if provider == "nowpayments":
        return await np_check(provider_id)
    # simulator: auto-finish shortly after creation
    if db.now_ms() - payment["created_at"] > SIM_FINISH_MS:
        return {"status": "finished"}
    return {"status": "waiting"}


def _to_float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None