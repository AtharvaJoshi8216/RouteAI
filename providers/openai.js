const axios = require("axios");

async function callOpenAI(prompt, model = "gpt-4o-mini") {
  const res = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 2048,
      temperature: 0.7,
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );

  return {
    text:         res.data.choices[0].message.content,
    tokens:       res.data.usage?.total_tokens      || 0,
    inputTokens:  res.data.usage?.prompt_tokens     || 0,
    outputTokens: res.data.usage?.completion_tokens || 0,
  };
}

module.exports = callOpenAI;