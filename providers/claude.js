const axios = require("axios");

const MODELS = {
  haiku:  "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-6",
};

async function callClaude(prompt, tier = "sonnet") {
  const res = await axios.post(
    "https://api.anthropic.com/v1/messages",
    { model: MODELS[tier] || MODELS.sonnet, max_tokens: 2048, messages: [{ role: "user", content: prompt }] },
    {
      headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    }
  );

  return {
    text:         res.data.content[0].text,
    tokens:       res.data.usage.input_tokens + res.data.usage.output_tokens,
    inputTokens:  res.data.usage.input_tokens,
    outputTokens: res.data.usage.output_tokens,
  };
}

module.exports = callClaude;
