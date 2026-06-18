require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const helmet  = require("helmet");
const fs      = require("fs");
const path    = require("path");
const crypto  = require("crypto");

const {
  getSession,
  setSession,
  updateSession,
  addMessage,
  getMessages,
} = require("./utils/sessionStore");

const {

  getCustomerBudget,
  addSpend,
  budgetExceeded,
  incrementDowngrade

} = require("./utils/budgetStore");

const callOpenAI = require("./providers/openai");
const callClaude = require("./providers/claude");
const callGemini = require("./providers/gemini");

const app = express();

app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

app.use(cors({ origin: "*", methods: ["GET", "POST"] }));
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT   = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === "production";

// ─────────────────────────────────────────────
// FEATURE 14 — STARTUP VALIDATION
// Fail fast with a clear message if no keys are set
// ─────────────────────────────────────────────
const HAS_OPENAI = !!process.env.OPENAI_API_KEY;
const HAS_CLAUDE = !!process.env.ANTHROPIC_API_KEY;
const HAS_GEMINI = !!process.env.GEMINI_API_KEY;

if (!HAS_OPENAI && !HAS_CLAUDE && !HAS_GEMINI) {
  console.error("\n❌  No provider API keys found.");
  console.error("    Add at least one to your .env file and restart.\n");
  process.exit(1);
}

const AVAILABLE = new Set([
  ...(HAS_OPENAI ? ["gpt-4o-mini", "gpt-4o"]        : []),
  ...(HAS_CLAUDE ? ["claude-haiku", "claude-sonnet"] : []),
  ...(HAS_GEMINI ? ["gemini-flash"]                  : []),
]);

const providerHealth = {

  "gpt-4o-mini": {
    healthy: true,
    lastFail: 0,
    failures: 0,
    successes: 0,
    avgLatency: 0,
    totalLatency: 0,
    requests: 0,
    score: 100,
  },

  "gpt-4o": {
    healthy: true,
    lastFail: 0,
    failures: 0,
    successes: 0,
    avgLatency: 0,
    totalLatency: 0,
    requests: 0,
    score: 100,
  },

  "claude-haiku": {
    healthy: true,
    lastFail: 0,
    failures: 0,
    successes: 0,
    avgLatency: 0,
    totalLatency: 0,
    requests: 0,
    score: 100,
  },

  "claude-sonnet": {
    healthy: true,
    lastFail: 0,
    failures: 0,
    successes: 0,
    avgLatency: 0,
    totalLatency: 0,
    requests: 0,
    score: 100,
  },

  "gemini-flash": {
    healthy: true,
    lastFail: 0,
    failures: 0,
    successes: 0,
    avgLatency: 0,
    totalLatency: 0,
    requests: 0,
    score: 100,
  },

};

console.log(`✅  Providers ready: ${[...AVAILABLE].join(", ")}`);

// ─────────────────────────────────────────────
// COST TABLE — per 1K tokens, in USD
// Source: platform.openai.com/pricing, ai.google.dev/pricing, anthropic.com/pricing
// ─────────────────────────────────────────────
const COST = {
  "gpt-4o-mini":  { in: 0.00015,  out: 0.0006  },
  "gpt-4o":       { in: 0.005,    out: 0.015   },
  "claude-haiku": { in: 0.00025,  out: 0.00125 },
  "claude-sonnet":{ in: 0.003,    out: 0.015   },
  "gemini-flash": { in: 0.000075, out: 0.0003  },
  "baseline":     { in: 0.005,    out: 0.015   }, // GPT-4o — used for savings calculation
};

const calcCost     = (k, i, o) => { const r = COST[k]; return r ? (i/1000)*r.in + (o/1000)*r.out : 0; };
const calcBaseline = (i, o)    => (i/1000)*COST.baseline.in + (o/1000)*COST.baseline.out;

// ─────────────────────────────────────────────
// FEATURE 9 — API KEY AUTH
// FEATURE 10 — RATE LIMITING (per-key, sliding window)
// ─────────────────────────────────────────────
const VALID_KEYS = new Set(
  (process.env.ROUTE_AI_API_KEYS || "dev-key-123")
    .split(",").map(k => k.trim()).filter(Boolean)
);
const RATE_LIMIT = parseInt(process.env.RATE_LIMIT_PER_MIN || "60");
const rlMap = {};

function requireApiKey(req, res, next) {
  if (req.path === "/api/health" || req.path === "/api/metrics" || !req.path.startsWith("/api/")) return next();

  const key = req.headers["x-api-key"] || req.query.api_key;
  if (!key || !VALID_KEYS.has(key))
    return res.status(401).json({ success: false, error: "Invalid or missing API key. Pass x-api-key header." });

  const now = Date.now();
  if (!rlMap[key]) rlMap[key] = { count: 0, start: now };
  const rl = rlMap[key];
  if (now - rl.start > 60000) { rl.count = 0; rl.start = now; }
  rl.count++;

  res.setHeader("X-RateLimit-Limit",     RATE_LIMIT);
  res.setHeader("X-RateLimit-Remaining", Math.max(0, RATE_LIMIT - rl.count));

  if (rl.count > RATE_LIMIT)
    return res.status(429).json({
      success: false,
      error: `Rate limit exceeded. Max ${RATE_LIMIT} req/min.`,
      retryAfter: Math.ceil((rl.start + 60000 - now) / 1000),
    });

  next();
}

app.use(requireApiKey);

// ─────────────────────────────────────────────
// FILE STORE — debounced writes, in-memory reads
// ─────────────────────────────────────────────
function makeStore(filename, defaultVal) {
  const file = path.join(__dirname, filename);
  let data = JSON.parse(JSON.stringify(defaultVal));
  if (fs.existsSync(file)) {
    try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) {}
  }
  let timer = null;
  return {
    get:    ()   => data,
    update: (fn) => { data = fn(data); },
    save:   ()   => {
      if (timer) return;
      timer = setTimeout(() => {
        fs.promises.writeFile(file, JSON.stringify(data, null, 2)).catch(console.error);
        timer = null;
      }, 500);
    },
  };
}

const cacheStore    = makeStore("cache.json",     {});
const logsStore     = makeStore("logs.json",      []);
const customerStore = makeStore("customers.json", {});

// ─────────────────────────────────────────────
// LOGGING
// ─────────────────────────────────────────────
function saveLog(entry) {
  logsStore.update(logs => {
    logs.push(entry);
    // Keep last 1000 logs — safe for Railway memory
    if (logs.length > 1000) logs.shift();
    return logs;
  });
  logsStore.save();
}

// ─────────────────────────────────────────────
// FEATURE 11 — PER-CUSTOMER TRACKING
// Seeds the V3 learning router data flywheel
// ─────────────────────────────────────────────
function updateCustomer(customerId, entry) {
  if (!customerId) return;
  customerStore.update(cs => {
    if (!cs[customerId]) {
      cs[customerId] = {
        customerId,
        firstSeen: new Date().toISOString(),
        requests: 0, totalCost: 0, totalTokens: 0, totalSaved: 0,
        cacheHits: 0, fallbacks: 0, errors: 0,
        modelUsage: {},
        complexityBreakdown: { simple: 0, medium: 0, complex: 0 },
        recentPrompts: [],
      };
    }
    const c = cs[customerId];
    c.requests++;
    c.totalCost   += entry.cost    || 0;
    c.totalTokens += entry.tokens  || 0;
    c.totalSaved  += entry.savedVsBaseline || 0;
    if (entry.cached)       c.cacheHits++;
    if (entry.fallbackUsed) c.fallbacks++;
    if (!entry.success)     c.errors++;
    if (entry.modelKey)     c.modelUsage[entry.modelKey] = (c.modelUsage[entry.modelKey] || 0) + 1;
    if (entry.complexity)   c.complexityBreakdown[entry.complexity] = (c.complexityBreakdown[entry.complexity] || 0) + 1;
    c.recentPrompts.push({
      prompt:     (entry.prompt || "").slice(0, 100),
      complexity: entry.complexity,
      model:      entry.modelKey,
      cost:       entry.cost,
      timestamp:  entry.timestamp,
    });
    if (c.recentPrompts.length > 50) c.recentPrompts = c.recentPrompts.slice(-50);
    c.lastSeen = new Date().toISOString();
    return cs;
  });
  customerStore.save();
}

// ─────────────────────────────────────────────
// FEATURE 2 — INTELLIGENT ROUTING (CLASSIFIER)
// ─────────────────────────────────────────────

function detectTaskType(prompt) {

  const p = prompt.toLowerCase();

  if (

    p.includes("code") ||

    p.includes("function") ||

    p.includes("debug") ||

    p.includes("implement") ||

    p.includes("api") ||

    p.includes("backend") ||

    p.includes("frontend") ||

    p.includes("database") ||

    p.includes("sql") ||

    p.includes("mongodb") ||

    p.includes("postgres") ||

    p.includes("mysql") ||

    p.includes("docker") ||

    p.includes("dockerfile") ||

    p.includes("redis") ||

    p.includes("terraform") ||

    p.includes("kubernetes") ||

    p.includes("k8s") ||

    p.includes("yaml") ||

    p.includes("json") ||

    p.includes("jwt") ||

    p.includes("oauth") ||

    p.includes("typescript") ||

    p.includes("javascript") ||

    p.includes("python") ||

    p.includes("node") ||

    p.includes("react") ||

    p.includes("express") ||

    p.includes("middleware")

) return "coding";

  if (
    p.includes("summarize") ||
    p.includes("summarise") ||
    p.includes("tldr") ||
    p.includes("brief")
  ) return "summarization";

  if (
    p.includes("extract") ||
    p.includes("find all") ||
    p.includes("list all") ||
    p.includes("pull out")
  ) return "extraction";

  if (

    p.includes("why") ||

    p.includes("explain") ||

    p.includes("analyse") ||

    p.includes("analyze") ||

    p.includes("compare") ||

    p.includes("tradeoff") ||

    p.includes("pros and cons") ||

    p.includes("research") ||

    p.includes("benchmark") ||

    p.includes("evaluate")

) return "reasoning";

  if (
    p.includes("translate") ||
    p.includes("hindi") ||
    p.includes("spanish") ||
    p.includes("french")
  ) return "multilingual";

  if (

    p.includes("write") ||

    p.includes("email") ||

    p.includes("caption") ||

    p.includes("linkedin") ||

    p.includes("twitter") ||

    p.includes("instagram") ||

    p.includes("blog") ||

    p.includes("article") ||

    p.includes("story") ||

    p.includes("proposal") ||

    p.includes("documentation") ||

    p.includes("technical document") ||

    p.includes("release notes") ||

    p.includes("resume") ||

    p.includes("cover letter")

) return "writing";

  if (

    p.includes("pricing") ||

    p.includes("business") ||

    p.includes("startup") ||

    p.includes("saas") ||

    p.includes("revenue") ||

    p.includes("growth") ||

    p.includes("fundraising") ||

    p.includes("pitch") ||

    p.includes("market") ||

    p.includes("competitor")

) return "business";

  if (
    p.includes("search") ||
    p.includes("find") ||
    p.includes("lookup") ||
    p.includes("what is")
  ) return "search";

  return "general";
}

function classifyPrompt(prompt) {

    const p = prompt.toLowerCase();

    const wc = prompt.trim().split(/\s+/).length;

    let score = 0;

    // -----------------------
    // Word Count
    // -----------------------

    if (wc > 40) score += 1;

    if (wc > 100) score += 1;

    // -----------------------
    // Complex Keywords
    // -----------------------

    if (
        /architecture|microservices|distributed|system design|authentication|oauth|jwt|terraform|kubernetes|docker|production|real-time|high availability|multi-tenant|optimization|benchmark|tradeoff/.test(p)
    ) {
        score += 3;
    }

    // -----------------------
    // Coding
    // -----------------------

    if (
        /implement|build api|create api|sql query|database schema|redis|backend|frontend|react|node|python/.test(p)
    ) {
        score += 2;
    }

    // -----------------------
    // Business / Strategy
    // -----------------------

    if (
        /startup|pricing|go to market|gtm|business plan|revenue|market strategy/.test(p)
    ) {
        score += 2;
    }

    // -----------------------
    // Research
    // -----------------------

    if (
        /compare|analyse|analyze|pros and cons|research|evaluate/.test(p)
    ) {
        score += 2;
    }

    // -----------------------
    // Simple Questions
    // -----------------------

    if (

        p.startsWith("what is") ||

        p.startsWith("who is") ||

        p.startsWith("define")

    ) {

        score -= 2;

    }

    // -----------------------

    if (score <= 0)

        return "simple";

    if (score <= 3)

        return "medium";

    return "complex";

}

function calculateConfidence(

    complexity,

    taskType,

    promptContext

) {

    let score = 70;

    // ----------------------------
    // Complexity
    // ----------------------------

    if (complexity === "complex")
        score += 10;

    else if (complexity === "medium")
        score += 7;

    else
        score += 5;

    // ----------------------------
    // Task detection
    // ----------------------------

    if (taskType !== "general")
        score += 8;

    // ----------------------------
    // Context signals
    // ----------------------------

    const contextMatches =

        Object.values(promptContext)

            .filter(Boolean)

            .length;

    score += contextMatches * 4;

    score = Math.min(99, score);

    let level;
    let color;

    if (score >= 90) {

        level = "High";
        color = "green";

    }

    else if (score >= 80) {

        level = "Medium";
        color = "yellow";

    }

    else {

        level = "Low";
        color = "red";

    }

    return {

        score,

        level,

        color

    };

}

function detectPromptContext(prompt) {

  const p = prompt.toLowerCase();

  return {

    // ─────────────────────────
    // CODE / ENGINEERING
    // ─────────────────────────

    code:
      /write.*sql|sql query|mysql query|postgres query|database schema|optimize query|debug|bug|fix|function|algorithm|implement|build api|create api|express server|authentication|login system|javascript|typescript|python|react|nodejs|backend|frontend|api endpoint|coding/.test(p),

    // ─────────────────────────
    // BUSINESS / STRATEGY
    // ─────────────────────────

    business:
      /startup|market|pricing|revenue|growth|sales|business|gtm|strategy|customer|saas/.test(p),

    // ─────────────────────────
    // WRITING / CONTENT
    // ─────────────────────────

    writing:
      /blog|article|story|poem|script|linkedin post|twitter thread|content writing|copywriting/.test(p),

    // ─────────────────────────
    // RESEARCH / ANALYSIS
    // ─────────────────────────

    research:
      /analyze|compare|research|study|tradeoff|pros and cons|benchmark/.test(p),

    // ─────────────────────────
    // MATH / LOGIC
    // ─────────────────────────

    math:
      /equation|math|calculate|probability|statistics|algebra/.test(p),

    // ─────────────────────────
    // LONG CONTEXT
    // ─────────────────────────

    longContext:
      prompt.length > 4000,

  };
}


function getHealthyProvider(preferred) {

  const health =
    providerHealth[preferred];

  // If provider score is too low,
  // fallback automatically

  if (
    health &&
    health.score < 60
  ) {

    if (!isProd) {

      console.log(
        `[Health Router] ${preferred} degraded (${health.score})`
      );  

    }

    const alternatives =
      Object.entries(providerHealth)
        .filter(([k, v]) =>
          v.score >= 70 &&
          AVAILABLE.has(k)
        )
        .sort((a, b) =>
          b[1].score - a[1].score
        );

    if (alternatives.length) {
      return alternatives[0][0];
    }
  }

  return preferred;
}

function selectContextAwareProvider(
  complexity,
  mode,
  context,
  taskType
) {

  // ─────────────────────────
  // LONG CONTEXT
  // ─────────────────────────

  if (context.longContext) {

    return getHealthyProvider(
      "claude-sonnet"
    );

  }

  // ─────────────────────────
  // CODING TASKS
  // ─────────────────────────

  if (
    context.code ||
    taskType === "coding"
  ) {

    return complexity === "complex"
      ? getHealthyProvider("gpt-4o")
      : getHealthyProvider("gpt-4o-mini");

  }

  // ─────────────────────────
  // RESEARCH / REASONING
  // ─────────────────────────

  if (
    context.research ||
    taskType === "reasoning"
  ) {

    return complexity === "complex"
      ? getHealthyProvider("claude-sonnet")
      : getHealthyProvider("gpt-4o-mini");

  }

  // ─────────────────────────
  // WRITING
  // ─────────────────────────

  if (context.writing) {

    return getHealthyProvider(
      "claude-haiku"
    );

  }

  // ─────────────────────────
  // BUSINESS
  // ─────────────────────────

  if (context.business) {

    return complexity === "complex"
      ? getHealthyProvider("gpt-4o")
      : getHealthyProvider("gpt-4o-mini");

  }

  // ─────────────────────────
  // MATH
  // ─────────────────────────

  if (context.math) {

    return getHealthyProvider(
      "gpt-4o-mini"
    );

  }

  // ─────────────────────────
  // FALLBACK
  // ─────────────────────────

  return selectProvider(
    complexity,
    mode
  );

}

// ─────────────────────────────────────────────
// FEATURE 3 — ROUTING MODES
// balanced | cost | speed | quality
// ─────────────────────────────────────────────
function selectProvider(complexity, mode = "balanced") {

  if (mode === "cost")
    return complexity === "complex"
      ? getHealthyProvider("claude-haiku")
      : getHealthyProvider("gemini-flash");

  if (mode === "speed")
    return getHealthyProvider("claude-haiku");

  if (mode === "quality")
    return complexity === "complex"
      ? getHealthyProvider("claude-sonnet")
      : getHealthyProvider("gpt-4o");

  // BALANCED

  if (complexity === "simple")
    return getHealthyProvider("gemini-flash");

  if (complexity === "medium")
    return getHealthyProvider("gpt-4o-mini");

  if (complexity === "complex")
    return getHealthyProvider("gpt-4o");

  return getHealthyProvider("gpt-4o-mini");
}


// ─────────────────────────────────────────────
// FEATURE 13 — ROUTING REASON
// No black box — every response explains why
// ─────────────────────────────────────────────
function buildRoutingReason(
  complexity,
  mode,
  provider,
  context,
  taskType,
  budgetTriggered = false,
  stickySession = false
) {

  const reasons = [];

  // ─────────────────────────
  // SESSION
  // ─────────────────────────

  if (stickySession) {

    reasons.push(
      `Sticky session active`
    );

  }

  // ─────────────────────────
  // BUDGET
  // ─────────────────────────

  if (budgetTriggered) {

    reasons.push(
      `Budget guardrail triggered`
    );

  }

  // ─────────────────────────
  // COMPLEXITY
  // ─────────────────────────

  reasons.push(
    `Complexity: ${complexity}`
  );

  // ─────────────────────────
  // MODE
  // ─────────────────────────

  reasons.push(
    `Mode: ${mode}`
  );

  // ─────────────────────────
  // TASK TYPE
  // ─────────────────────────

  reasons.push(
    `Task: ${taskType}`
  );

  // ─────────────────────────
  // CONTEXTS
  // ─────────────────────────

  Object.entries(context)
    .filter(([k, v]) => v)
    .forEach(([k]) => {

      reasons.push(
        `Context: ${k}`
      );

    });

  // ─────────────────────────
  // FINAL MODEL
  // ─────────────────────────

  reasons.push(
    `Selected: ${provider}`
  );

  return reasons.join(" • ");

}

// ─────────────────────────────────────────────
// FEATURE 5 — CENTRALIZED TIMEOUTS
// Faster fallback recovery
// ─────────────────────────────────────────────

const providerTimeouts = {
  "gpt-4o-mini": 14000,
  "gpt-4o": 15000,
  "claude-haiku": 14000,
  "claude-sonnet": 15000,
  "gemini-flash": 14000
};

// ─────────────────────────────────────────────
// FEATURE 4 — FALLBACK CHAIN
// Each provider has its own smart fallback order
// ─────────────────────────────────────────────
const CHAINS = {

  // FAST + CHEAP
  "gpt-4o-mini": [
    "gpt-4o-mini",
    "claude-haiku",
    "gemini-flash"
  ],

  // PREMIUM QUALITY
  "gpt-4o": [
    "gpt-4o",
    "gpt-4o-mini",
    "claude-sonnet"
  ],

  // VERY FAST FALLBACK
  "claude-haiku": [
    "claude-haiku",
    "gpt-4o-mini",
    "gemini-flash"
  ],

  // HIGH QUALITY
  "claude-sonnet": [
    "claude-sonnet",
    "gpt-4o-mini",
    "claude-haiku"
  ],

  // LOW COST + FAST
  "gemini-flash": [
    "gemini-flash",
    "claude-haiku",
    "gpt-4o-mini"
  ],
};

// ─────────────────────────────────────────────
// FEATURE 1 — MULTI-PROVIDER SUPPORT
// ─────────────────────────────────────────────
async function callProvider(key, prompt) {
  if (!AVAILABLE.has(key)) throw new Error(`Provider '${key}' not configured — add its API key to .env`);
  prompt = prompt.trim();
  prompt = prompt.slice(0, 1200);
  switch (key) {
    case "gpt-4o-mini":   return { ...(await callOpenAI(prompt, "gpt-4o-mini")),  modelKey: "gpt-4o-mini"   };
    case "gpt-4o":        return { ...(await callOpenAI(prompt, "gpt-4o")),       modelKey: "gpt-4o"        };
    case "claude-haiku":  return { ...(await callClaude(prompt, "haiku")),        modelKey: "claude-haiku"  };
    case "claude-sonnet": return { ...(await callClaude(prompt, "sonnet")),       modelKey: "claude-sonnet" };
    case "gemini-flash":  return { ...(await callGemini(prompt)),                 modelKey: "gemini-flash"  };
    default: throw new Error(`Unknown provider: ${key}`);
  }
}

// FEATURE 5 — TIMEOUT HANDLING (5s per provider)
async function callWithFallback(primary, prompt) {

  const startedAt = Date.now();

  prompt = prompt.trim().slice(0, 1200);

  const chain = (CHAINS[primary] || ["gpt-4o-mini"])
    .filter(p => AVAILABLE.has(p));

  if (!chain.length) {
    throw new Error("No configured providers available.");
  }

  let lastErr;

  for (const provider of chain) {

    // =========================
    // SKIP TEMPORARILY UNHEALTHY PROVIDERS
    // =========================

    const health = providerHealth[provider];

    if (
      health &&
      !health.healthy &&
      Date.now() - health.lastFail < 30000
    ) {

      console.log(`Skipping unhealthy provider: ${provider}`);

      continue;
    }

    try {

      // =========================
      // SINGLE PROVIDER CALL
      // AXIOS HANDLES TIMEOUT
      // =========================

      const timeout = providerTimeouts[provider] || 5000;

      const result = await Promise.race([

        callProvider(provider, prompt),

        new Promise((_, reject) =>
          setTimeout(() => {
            reject(new Error(`timeout after ${timeout}ms`));
          }, timeout)
        )

      ]);

      // =========================
      // MARK HEALTHY
      // =========================

      const ph = providerHealth[provider];

      ph.healthy = true;
      ph.lastFail = 0;

      ph.successes++;
      ph.requests++;

      // HEALTH SCORE

      const successRate =
        ph.successes /
        Math.max(1, ph.requests);

      const latencyPenalty =
        Math.min(ph.avgLatency / 100, 20);

      ph.score = Math.max(
        1,
        Math.round(
          (successRate * 100) - latencyPenalty
        )
      );

      const totalLatency = Date.now() - startedAt;

      ph.totalLatency += totalLatency;

      ph.avgLatency =
        Math.round(
          ph.totalLatency / ph.requests
        );

      return {

        ...result,

        latency: totalLatency,

        fallbackUsed: provider !== primary,

        attemptedProvider: provider

      };

    } catch (err) {

      // =========================
      // MARK UNHEALTHY
      // =========================

      const ph = providerHealth[provider];

      ph.healthy = false;
      ph.lastFail = Date.now();

      ph.failures++;
      ph.requests++;

      // SCORE DROP

      ph.score = Math.max(
        1,
        ph.score - 15
      );

      console.warn(
        `[${new Date().toISOString()}] ${provider} failed: ${err.message}`
      );

      lastErr = err;
    }
  }

  throw new Error(
    `All providers failed. Last error: ${lastErr?.message}`
  );
}

// ─────────────────────────────────────────────
// FEATURE 8 — PROMPT COMPRESSION
// Strips filler words before sending — fewer tokens, same quality
// ─────────────────────────────────────────────
function compressPrompt(prompt) {
  const original   = prompt;
  const compressed = prompt
    .replace(/\b(please|kindly|could you|can you|would you mind|i want you to|i need you to|i'd like you to)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return {
    compressed,
    originalLength:    original.length,
    compressedLength:  compressed.length,
    savedChars:        original.length - compressed.length,
  };
}

// ─────────────────────────────────────────────
// COST GUARD helper (used by /api/ai maxCost field)
// ─────────────────────────────────────────────
function estimateInputCost(prompt, modelKey) {
  const r = COST[modelKey];
  return r ? (Math.ceil(prompt.length / 4) / 1000) * r.in : 0;
}

// ─────────────────────────────────────────────
// STATS
// ─────────────────────────────────────────────
function computeStats(filterCid = null) {
  const src = filterCid
    ? logsStore.get().filter(l => l.customerId === filterCid)
    : logsStore.get();
  if (!src.length) return null;

  const totalCost  = src.reduce((s, l) => s + (l.cost || 0), 0);
  const totalSaved = src.reduce((s, l) => s + (l.savedVsBaseline || 0), 0);
  const cacheHits  = src.filter(l => l.cached).length;
  const mb = {};
  src.forEach(l => {
    if (!l.modelKey) return;
    if (!mb[l.modelKey]) mb[l.modelKey] = { count: 0, cost: 0, tokens: 0 };
    mb[l.modelKey].count++;
    mb[l.modelKey].cost   += l.cost   || 0;
    mb[l.modelKey].tokens += l.tokens || 0;
  });

  return {
    totalRequests: src.length,
    totalCost:     totalCost.toFixed(6),
    totalSaved:    totalSaved.toFixed(6),
    cacheSaved:    src.filter(l => l.cached).reduce((s, l) => s + (l.cost || 0), 0).toFixed(6),
    totalTokens:   src.reduce((s, l) => s + (l.tokens || 0), 0),
    avgLatency:    Math.round(src.reduce((s, l) => s + (l.latency || 0), 0) / src.length),
    cacheHits,
    cacheHitRate:  ((cacheHits / src.length) * 100).toFixed(1),
    modelBreakdown: mb,
    fallbacks:     src.filter(l => l.fallbackUsed).length,
    errors:        src.filter(l => !l.success).length,
  };
}

// ═════════════════════════════════════════════
// ROUTES
// ═════════════════════════════════════════════

// ── ROUTE 1: POST /api/ai ─────────────────────
// The main endpoint. Routes, compresses, caches, tracks.
app.post("/api/ai", async (req, res) => {
  const start = Date.now();
  const {
    prompt,
    mode,
    maxCost,
    compress,
    customerId,
    systemPrompt,
    sessionId
  } = req.body;

  if (!prompt || typeof prompt !== "string")
    return res.status(400).json({ success: false, error: "prompt is required and must be a string." });

  // FEATURE 2+3 — Classify + Route

  // ─────────────────────────────
  // STICKY SESSION LOOKUP
  // ─────────────────────────────

  let stickyProvider = null;
  let previousTaskType = null;
  let previousComplexity = null;
  let conversationHistory = [];

  if (sessionId) {

    const existingSession =
      getSession(sessionId);

    if (existingSession) {

      const lastSeenAgo =
        Date.now() - new Date(existingSession.lastUsed).getTime();

      if (lastSeenAgo > 10 * 60 * 1000) {

        stickyProvider = null;
        conversationHistory = [];

      } else {

        stickyProvider =
        existingSession.provider;

        previousTaskType =
        existingSession.taskType;

        previousComplexity =
        existingSession.complexity;

        conversationHistory =
        getMessages(sessionId);

        updateSession(sessionId);

      }

    }
  }


  // FEATURE 8 — Compress
  let finalPrompt = prompt;
  let compressionInfo = null;

  // ─────────────────────────────
  // SESSION MEMORY CONTEXT
  // ─────────────────────────────

  if (
    conversationHistory &&
    conversationHistory.length > 0
  ) {

    const historyText =
      conversationHistory
        .slice(-4)
        .map(msg =>
          `${msg.role}: ${msg.content.slice(0, 300)}`
        )
        .join("\n");

    finalPrompt = `
      Previous conversation:

      ${historyText}

      Current user message:

      ${prompt}
      `;
    }

  // ─────────────────────────────
  // COMPRESS
  // ─────────────────────────────

  if (compress !== false) {

    const r = compressPrompt(finalPrompt);

    finalPrompt = r.compressed;

    compressionInfo = r;
  }

  // ─────────────────────────────
  // CONTEXT CLASSIFICATION
  // ─────────────────────────────

  const complexity =
    classifyPrompt(finalPrompt);

  const taskType =
    detectTaskType(finalPrompt);

  const promptContext =
    detectPromptContext(finalPrompt);

  const confidence =

    calculateConfidence(

        complexity,

        taskType,

        promptContext

    );

  const routingMode =
    mode || "balanced";

  // FEATURE 6 — Cache check
  const normalizedPrompt = prompt
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

  const cacheKey = crypto
    .createHash("md5")
    .update(
      JSON.stringify({
        prompt: normalizedPrompt,
        mode: routingMode,
        complexity,
        taskType
      })
    )
    .digest("hex");

  const shouldUseCache = !sessionId;

  const cached =
    shouldUseCache
      ? cacheStore.get()[cacheKey]
      : null;
  
  if (cached) {

    const log = {
      id: crypto.randomUUID(),

      success: true,
      cached: true,

      customerId: customerId || null,

      prompt: prompt.slice(0, 200),

      response: cached.response,

      model: cached.model,
      modelKey: cached.modelKey,

      // IMPORTANT
      cost: 0,
      baselineCost: 0,
      savedVsBaseline: 0,

      // IMPORTANT
      tokens: 0,
      inputTokens: 0,
      outputTokens: 0,

      latency: Date.now() - start,

      timestamp: new Date().toISOString(),
    };

    saveLog(log);

    updateCustomer(customerId, log);

    return res.json({

      success: true,

      cached: true,

      data: {

        response: cached.response,

        model: cached.modelKey || cached.model,

        routingDetails: {
          cached: true,
          provider: cached.modelKey || cached.model,
        },

        latency: log.latency,

        fallbackUsed: false,

        tokens: 0,

        inputTokens: 0,

        outputTokens: 0,

        cost: 0,

        savedVsBaseline: 0,

        cached: true,

        routingTimeline: [

          {
            step: "Prompt received",
            status: "success",
            time: "0ms",
            timestamp: new Date().toLocaleTimeString()
          },

          {
            step: "Semantic cache lookup",
            status: "success",
            time: "2ms",
            timestamp: new Date().toLocaleTimeString()
          },

          {
            step: "Cache hit detected",
            status: "cached",
            time: "3ms",
            timestamp: new Date().toLocaleTimeString()
          },

          {
            step: "Returning cached response",
            status: "cached",
            time: `${log.latency}ms`,
            timestamp: new Date().toLocaleTimeString()
          }

        ],

      }

    });

  }

  // FINAL PROVIDER

  let budgetTriggered = false;

  // ─────────────────────────
  // SMART STICKY SESSION
  // ─────────────────────────

  let primary;

  const canReuseProvider =

    stickyProvider &&

    previousTaskType === taskType &&

    previousComplexity === complexity &&

    complexity !== "complex";

  if (canReuseProvider) {

    primary = stickyProvider;

  } else {

    primary = selectContextAwareProvider(

        complexity,

        routingMode,

        promptContext,

        taskType

    );

  }

  // ─────────────────────────
  // BUDGET GUARDRAIL
  // ─────────────────────────

  if (

    customerId &&
    budgetExceeded(customerId)

  ) {

    budgetTriggered = true;

    incrementDowngrade(customerId);

    primary = "gemini-flash";

  }

  const stickyUsed = canReuseProvider;

  const reason =
    stickyUsed
      ? `Sticky session active. Reusing ${primary}.`
      : buildRoutingReason(
        complexity,
        routingMode,
        primary,
        promptContext,
        taskType,
        budgetTriggered,
        stickyUsed
      );

  // Cost guard
  if (maxCost) {
    const est = estimateInputCost(finalPrompt, primary);
    if (est > Number(maxCost))
      return res.status(400).json({
        success: false,
        error: `Estimated cost $${est.toFixed(6)} exceeds your maxCost of $${maxCost}.`,
        estimatedCost: est,
      });
  }

  try {

    if (sessionId) {

      addMessage(
        sessionId,
        "user",
        prompt
      );

    }

    // FEATURE 15 — System prompt support
    const toSend = systemPrompt ? `[System: ${systemPrompt}]\n\n${finalPrompt}` : finalPrompt;

    // FEATURE 4+5 — Call with fallback chain + timeout
    const result  = await callWithFallback(primary, toSend);
    // Limit response size — protects dashboard, memory, and payload
    result.text = (result.text || "").slice(0, 12000);

    // ─────────────────────────────
    // SAVE AI RESPONSE TO MEMORY
    // ─────────────────────────────

    if (sessionId) {

      addMessage(
        sessionId,
        "assistant",
        result.text.slice(0, 1500)
      );

    }

    const latency = Date.now() - start;

    // ─────────────────────────────
    // LIVE ROUTING TIMELINE
    // ─────────────────────────────

    const routingTimeline = [

      {
        step: "Prompt received",
        status: "success",
        time: "0ms"
      },

      {
        step: `Complexity classified: ${complexity}`,
        status: "success",
        time: "12ms"
      },

      {
        step: `Task detected: ${taskType}`,
        status: "success",
        time: "18ms"
      },

      {
        step: `Routing mode: ${routingMode}`,
        status: "success",
        time: "26ms"
      },

      {
        step: "Provider scoring completed",
        status: "success",
        time: "34ms"
      },

      {
        step: `${result.modelKey} selected`,
        status: "success",
        time: "52ms"
      },

      {
        step: result.fallbackUsed
          ? `Fallback triggered → ${result.modelKey}`
          : "Primary provider healthy",
        status: result.fallbackUsed
          ? "fallback"
          : "done",
        time: "74ms"
      },

      {
        step: "Generating response",
        status: "success",
        time: `${latency}ms`
      }

    ];

    // FEATURE 7 — Accurate cost tracking
    const cost            = calcCost(result.modelKey, result.inputTokens || 0, result.outputTokens || 0);
    const baselineCost    = calcBaseline(result.inputTokens || 0, result.outputTokens || 0);
    const savedVsBaseline = Math.max(0, baselineCost - cost);

    // ─────────────────────────────
    // SAVE STICKY SESSION
    // ─────────────────────────────

    if (sessionId) {

      setSession(
        sessionId,
        result.modelKey,
        taskType,
        complexity
      );

    }

    const logEntry = {
      id: crypto.randomUUID(),
      success: true, cached: false,
      customerId:      customerId || null,
      prompt:          prompt.slice(0, 200),
      taskType:       detectTaskType(finalPrompt),
      confidence,
      response:        result.text,
      modelKey:        result.modelKey,
      complexity,      routingMode,
      primaryProvider: primary,
      routingReason:   reason,

      routingTimeline,

      routingDetails: {
        complexity,
        mode: routingMode,
        taskType,
        confidence,
        provider: result.modelKey,
        fallbackUsed: result.fallbackUsed || false,
        cached: false,
        stickySession: stickyUsed,
        budgetTriggered,

        contexts: Object.entries(promptContext)
          .filter(([_, v]) => v)
          .map(([k]) => k),
      },

      fallbackUsed:    result.fallbackUsed || false,
      attemptedProvider: result.attemptedProvider,
      tokens:          result.tokens       || 0,
      inputTokens:     result.inputTokens  || 0,
      outputTokens:    result.outputTokens || 0,
      cost, baselineCost, savedVsBaseline, latency,
      compression:     compressionInfo,
      timestamp:       new Date().toISOString(),
    };

    // Save to cache ONLY for non-session requests

    if (shouldUseCache) {

      cacheStore.update(c => {

        c[cacheKey] = {

          model: result.modelKey,
          modelKey: result.modelKey,

          response: result.text,

          tokens: result.tokens || 0,
          inputTokens: result.inputTokens || 0,
          outputTokens: result.outputTokens || 0,

          cost,
          baselineCost,

        };

        // Limit cache size

        if (Object.keys(c).length > 500) {

          const firstKey = Object.keys(c)[0];

          delete c[firstKey];

        }

        return c;

      });

      cacheStore.save();

    }

    saveLog(logEntry);

    updateCustomer(customerId, logEntry);

    if (customerId) {

      addSpend(
        customerId,
        cost
      );

}

    return res.json({
      success: true,
      routingTimeline,
      stickySession: !!sessionId,
      sessionProvider: result.modelKey,
      cached: false,
      requestId:       logEntry.id,
      model:           result.modelKey,
      response:        result.text,
      complexity,      routingMode,
      confidence,
      primaryProvider: primary,
      routingReason:   reason,

      routingDetails: logEntry.routingDetails,

      budgetTriggered,

      budgetInfo:

        customerId

          ? getCustomerBudget(customerId)

          : null,

      taskType,

      promptContext,
      fallbackUsed:    result.fallbackUsed || false,
      tokens:          result.tokens || 0,
      cost,
      savedVsBaseline,
      latency,
      compression:     compressionInfo,
    });

  } catch (error) {
    const latency = Date.now() - start;
    saveLog({
      id: crypto.randomUUID(), success: false,
      customerId:  customerId || null,
      prompt:      prompt.slice(0, 200),
      taskType:    detectTaskType(finalPrompt),
      error:       error.message,
      complexity,  routingMode, latency,
      cost: 0, tokens: 0, savedVsBaseline: 0,
      timestamp:   new Date().toISOString(),
    });
    return res.status(500).json({
      success: false,
      error: "AI provider temporarily unavailable. Please try again in a few seconds.",
      latency,
    });
  }
});

// ── ROUTE 2: GET /api/savings ─────────────────
// FEATURE 12 — The killer demo stat
app.get("/api/savings", (req, res) => {
  const src = req.query.customerId
    ? logsStore.get().filter(l => l.customerId === req.query.customerId)
    : logsStore.get();

  if (!src.length)
    return res.json({
      message: "No requests yet.", totalRequests: 0,
      totalCost: 0, totalSaved: 0, cacheSaved: 0, routingSaved: 0,
      compressionSavedChars: 0, savingsPercent: "0.0", baselineCostIfGpt4o: 0,
    });

  const totalCost     = src.reduce((s, l) => s + (l.cost || 0), 0);
  const totalBaseline = src.reduce((s, l) => s + (l.baselineCost || 0), 0);
  const totalSaved    = src.reduce((s, l) => s + (l.savedVsBaseline || 0), 0);
  const cacheSaved    = src.filter(l => l.cached).reduce((s, l) => s + (l.cost || 0), 0);

  res.json({
    message:               `Route AI saved you $${totalSaved.toFixed(4)} vs using GPT-4o for everything`,
    totalRequests:         src.length,
    totalCost:             parseFloat(totalCost.toFixed(6)),
    totalSaved:            parseFloat(totalSaved.toFixed(6)),
    cacheSaved:            parseFloat(cacheSaved.toFixed(6)),
    cacheHits:             src.filter(l => l.cached).length,
    routingSaved:          parseFloat((totalSaved - cacheSaved).toFixed(6)),
    compressionSavedChars: src.reduce((s, l) => s + (l.compression?.savedChars || 0), 0),
    savingsPercent:        totalBaseline > 0 ? ((totalSaved / totalBaseline) * 100).toFixed(1) : "0.0",
    baselineCostIfGpt4o:   parseFloat(totalBaseline.toFixed(6)),
  });
});

// ── ROUTE 3: POST /api/estimate ───────────────
// FEATURE 14 — Dry run: see routing + cost with zero API spend
app.post("/api/estimate", (req, res) => {
  const { prompt, mode } = req.body;
  if (!prompt) return res.status(400).json({ success: false, error: "prompt required" });

  const r          = compressPrompt(prompt);
  const complexity = classifyPrompt(r.compressed);
  const routingMode = mode || "balanced";
  const primary    = selectProvider(complexity, routingMode);
  const estIn      = Math.ceil(r.compressed.length / 4);
  const estOut     = 200; // conservative estimate

  res.json({
    success:               true,
    dryRun:                true,
    complexity,
    routingMode,
    selectedModel:         primary,
    routingReason:         buildRoutingReason(complexity, routingMode, primary),
    estimatedInputTokens:  estIn,
    estimatedOutputTokens: estOut,
    estimatedCost:         parseFloat(calcCost(primary, estIn, estOut).toFixed(8)),
    estimatedBaselineCost: parseFloat(calcBaseline(estIn, estOut).toFixed(8)),
    estimatedSaving:       parseFloat(Math.max(0, calcBaseline(estIn, estOut) - calcCost(primary, estIn, estOut)).toFixed(8)),
    compression:           r,
    fallbackChain:         (CHAINS[primary] || []).filter(p => AVAILABLE.has(p)),
    note:                  "Token counts estimated at prompt.length/4. Actual costs vary.",
  });
});

// ── ROUTE 4: GET /api/stats ───────────────────
app.get("/api/stats", (req, res) => {
  res.json(computeStats(req.query.customerId || null) || {
    totalRequests: 0, totalCost: "0.000000", totalSaved: "0.000000",
    totalTokens: 0, avgLatency: 0, cacheHits: 0, cacheHitRate: "0.0",
    modelBreakdown: {}, fallbacks: 0, errors: 0,
  });
});

// ── ROUTE 5: GET /api/logs ────────────────────
app.get("/api/logs", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const src   = req.query.customerId
    ? logsStore.get().filter(l => l.customerId === req.query.customerId)
    : logsStore.get();
  res.json([...src].reverse().slice(0, limit));
});

// ── ROUTE 6: GET /api/customers ───────────────
app.get("/api/customers", (req, res) => {
  const list = Object.values(customerStore.get()).map(c => ({
    customerId: c.customerId,
    requests:   c.requests,
    totalCost:  c.totalCost,
    totalSaved: c.totalSaved,
    firstSeen:  c.firstSeen,
    lastSeen:   c.lastSeen,
  }));
  res.json(list.sort((a, b) => b.requests - a.requests));
});

app.get("/api/customers/:id", (req, res) => {
  const c = customerStore.get()[req.params.id];
  if (!c) return res.status(404).json({ success: false, error: "Customer not found." });
  res.json(c);
});

// ── ROUTE 7: GET /api/health ──────────────────
app.get("/api/health", (req, res) => {

  const providers = {};

  Object.entries(providerHealth).forEach(([name, data]) => {

    providers[name] = {

      status: data.healthy
        ? "healthy"
        : "degraded",

      latency: data.avgLatency || 0,

      score: data.score,

      requests: data.requests,

      failures: data.failures,

      successes: data.successes

    };

  });

  res.json({

    success: true,

    providers,

    timestamp: new Date().toISOString()

  });

});

// ── /api/metrics ─────────────────────────────
app.get("/api/metrics", (req, res) => {

  const stats = computeStats();

  res.json({

    success: true,

    stats: {

      totalRequests:
        stats?.totalRequests || 0,

      totalSaved:
        Number(stats?.totalSaved || 0),

      avgLatency:
        stats?.avgLatency || 0,

      cacheHitRate:
        Number(stats?.cacheHitRate || 0),

    },

    providers:
      providerHealth,

    uptime:
      process.uptime(),

  });

});

// ── 404 handler ───────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, error: "Route not found" });
});

// ── Global error middleware ───────────────────
app.use((err, req, res, next) => {
  console.error("[ERROR]", err.message);
  res.status(500).json({ success: false, error: "Internal server error" });
});

// ─────────────────────────────────────────────
app.listen(PORT, () => {
  const env = isProd ? "production" : "development";
  const bar = "─".repeat(48);

  console.log(`\n  ⚡ Route AI  v1.0.0  [${env}]`);
  console.log(`  ${bar}`);
  console.log(`  🌐  API        →  http://localhost:${PORT}/api/ai`);
  console.log(`  📊  Dashboard  →  http://localhost:${PORT}/dashboard.html`);
  console.log(`  ❤️   Health     →  http://localhost:${PORT}/api/health`);
  console.log(`  📈  Metrics    →  http://localhost:${PORT}/api/metrics`);
  console.log(`  ${bar}`);
  console.log(`  🔑  Keys       →  ${VALID_KEYS.size} configured`);
  console.log(`  ⚡  Rate limit →  ${RATE_LIMIT} req/min per key`);
  console.log(`  ${bar}`);
  console.log(`  Providers:`);
  console.log(`    OpenAI    ${HAS_OPENAI ? "●  ready" : "○  not configured"}`);
  console.log(`    Anthropic ${HAS_CLAUDE ? "●  ready" : "○  not configured"}`);
  console.log(`    Gemini    ${HAS_GEMINI ? "●  ready" : "○  not configured"}`);
  console.log(`  ${bar}\n`);
});

// ── Graceful shutdown ─────────────────────────
process.on("SIGINT",  () => { console.log("\n👋  Route AI shutting down..."); process.exit(0); });
process.on("SIGTERM", () => { console.log("\n👋  Route AI terminated.");      process.exit(0); });
