const API_BASE = "https://api.getnadir.com/v1";

// Keys are stored in Vercel Environment Variables — NOT in code
// Set NADIR_KEY_1 and NADIR_KEY_2 in Vercel Dashboard > Settings > Environment Variables
function getApiKeys() {
  const keys = [];
  if (process.env.NADIR_KEY_1) keys.push(process.env.NADIR_KEY_1);
  if (process.env.NADIR_KEY_2) keys.push(process.env.NADIR_KEY_2);
  if (keys.length === 0) throw new Error("No API keys configured in environment variables.");
  return keys;
}

let keyIndex = 0;

function sanitizeMessages(messages) {
  return messages.map((msg) => {
    let content = msg.content;
    if (Array.isArray(content)) {
      const textParts = [];
      for (const part of content) {
        if (part.type === "text") textParts.push(part.text);
        else if (part.type === "image_url")
          textParts.push("[User attached an image]");
      }
      content = textParts.join("\n");
    }
    return { role: msg.role, content };
  });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  function sendError(msg) {
    res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  }

  try {
    const API_KEYS = getApiKeys();
    const body = req.body;
    const messages = body.messages || [];
    const model = body.model;

    const cleanMessages = sanitizeMessages(messages);
    const payload = {
      messages: cleanMessages,
      stream: true,
      max_tokens: 16000,
    };
    if (model && model !== "auto") payload.model = model;

    // Retry with failover
    let upstreamResp = null;
    let lastError = "All API keys failed";

    for (let attempt = 0; attempt < API_KEYS.length; attempt++) {
      const tryKey = API_KEYS[(keyIndex + attempt) % API_KEYS.length];
      try {
        const r = await fetch(`${API_BASE}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${tryKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });

        if (r.ok) {
          keyIndex = (keyIndex + attempt + 1) % API_KEYS.length;
          upstreamResp = r;
          break;
        } else {
          const errText = await r.text();
          lastError = `Key ${attempt + 1} — HTTP ${r.status}: ${errText.slice(0, 200)}`;
        }
      } catch (fetchErr) {
        lastError = `Key ${attempt + 1} — ${fetchErr.message}`;
      }
    }

    if (!upstreamResp) return sendError(lastError);

    const reader = upstreamResp.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
    res.end();

  } catch (e) {
    sendError(`Server error: ${e.message}`);
  }
}
