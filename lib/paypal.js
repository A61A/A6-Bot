import { getConfig } from "./sitecatalog.js";

const PAYPAL_BASE = (() => {
  const mode = getConfig("paypal_mode", "sandbox");
  return mode === "sandbox" ? "https://api-m.sandbox.paypal.com" : "https://api-m.paypal.com";
})();

async function getPayPalToken() {
  const clientId = getConfig("paypal_client_id", "");
  const secret = getConfig("paypal_secret", "");
  if (!clientId || !secret) throw new Error("PayPal isn't configured yet.");
  
  const r = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${getConfig("paypal_client_id")}:${getConfig("paypal_secret")}`).toString("base64")}`,
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(20_000),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.message || "PayPal auth failed");
  return data.access_token;
}

export async function createPayPalOrder({ usdAmount, reference, returnUrl, cancelUrl }) {
  const token = await getPayPalToken();
  const r = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{
        amount: { currency_code: "USD", value: String(usdAmount.toFixed(2)) },
        reference_id: reference,
        description: "Balance top-up",
      }],
      application_context: {
        brand_name: "A6 Store",
        landing_page: "LOGIN",
        user_action: "PAY_NOW",
        return_url: returnUrl,
        cancel_url: cancelUrl,
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await r.json();
  if (!r.ok || data.status !== "CREATED") throw new Error(data.message || "PayPal order failed");
  return data;
}

export async function capturePayPalOrder(orderId) {
  const token = await getPayPalToken();
  const r = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${orderId}/capture`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(30_000),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.message || "PayPal capture failed");
  return data;
}

export function getPayPalApprovalUrl(orderData) {
  const link = orderData.links?.find(l => l.rel === "approve");
  return link?.href || null;
}