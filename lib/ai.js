const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const SYSTEM_PROMPT = `You are A7, the support bot for a Discord store called "pleasers". Customers buy credits (in a Pocket) and redeem codes, and buy account subscriptions/products via the Customer Portal. Products offered: SOON, Lifetime Spotify Premium, HD Netflix, HBO Max, Disney+, Prime Video.

Rules:
- Reply briefly and helpfully to the customer's message.
- If the customer has a question you cannot answer, or anything involves billing/payment/problems with a purchase, set "escalate" to true.
- You are speaking to a customer one-on-one; be friendly but professional.

Respond ONLY with JSON of the form {"reply": "...", "escalate": true/false}.`;

function buildMessages(history, userMessage) {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.slice(-10),
    { role: "user", content: userMessage },
  ];
}

async function callOpenAiCompat(endpoint, key, messages, model) {
  const started = Date.now();
  console.log(`AI call -> ${endpoint} (model ${model})`);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages,
        response_format: { type: "json_object" },
        temperature: 0.4,
        max_tokens: 200,
      }),
      // A hung upstream must never stall a customer conversation forever.
      signal: AbortSignal.timeout(30_000),
    });

    console.log(`AI call took ${Date.now() - started}ms (status ${res.status})`);

    if (!res.ok) {
      const text = await res.text();
      console.error(`AI error ${res.status} from ${endpoint}: ${text.slice(0, 500)}`);
      return null;
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    const tag = err?.name === "TimeoutError" ? "TIMEOUT" : err?.name || "ERROR";
    console.error(`AI call ${tag} after ${Date.now() - started}ms: ${err?.message || err}`);
    return null;
  }
}

function parseReply(raw) {
  let text = String(raw ?? "").trim();

  // Strip markdown code fences: ```json ... ```
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  // Fall back to the first {...} block if there's surrounding prose.
  if (!text.startsWith("{")) {
    const objBlock = text.match(/\{[\s\S]*\}/);
    if (objBlock) text = objBlock[0].trim();
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = {};
  }
  return {
    reply: String(parsed.reply ?? "Hmm, I couldn't form a response. An admin has been notified."),
    escalate: Boolean(parsed.escalate),
  };
}

export async function getAiReply(history, userMessage) {
  const messages = buildMessages(history, userMessage);

  // Gemini first (free tier): OpenAI-compatible endpoint.
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    try {
      const raw = await callOpenAiCompat(
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        geminiKey,
        messages,
        GEMINI_MODEL
      );
      if (raw !== null) return parseReply(raw);
      return {
        reply: "I ran into a problem talking to my brain. An admin has been notified.",
        escalate: true,
        errored: true,
      };
    } catch (err) {
      console.error("Gemini error:", err.message);
      return { reply: "I ran into a problem talking to my brain. An admin has been notified.", escalate: true, errored: true };
    }
  }

  // OpenAI fallback if no Gemini key is set.
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    try {
      const raw = await callOpenAiCompat("https://api.openai.com/v1/chat/completions", openaiKey, messages, OPENAI_MODEL);
      if (raw !== null) return parseReply(raw);
      return {
        reply: "I ran into a problem talking to my brain. An admin has been notified.",
        escalate: true,
        errored: true,
      };
    } catch (err) {
      console.error("OpenAI error:", err.message);
      return { reply: "I ran into a problem talking to my brain. An admin has been notified.", escalate: true, errored: true };
    }
  }

  return { reply: "AI support isn't configured yet. Apologies!", escalate: false, errored: true };
}