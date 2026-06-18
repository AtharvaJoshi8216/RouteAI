const axios = require("axios");

async function callGemini(prompt, retries = 1) {
  try {
    const res = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 2048,
          temperature: 0.7,
        },
      },
    );

    const text = res.data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const usage = res.data.usageMetadata || {};
    const inputTokens  = usage.promptTokenCount     || Math.ceil(prompt.length / 4);
    const outputTokens = usage.candidatesTokenCount || Math.ceil(text.length / 4);

    return { text, tokens: inputTokens + outputTokens, inputTokens, outputTokens };

  } catch (err) {
    // Retry once on 429 (Gemini free tier rate limit)
    if (err.response?.status === 429 && retries > 0) {
      await new Promise(r => setTimeout(r, 2000));
      return callGemini(prompt, retries - 1);
    }
    throw err;
  }
}

module.exports = callGemini;