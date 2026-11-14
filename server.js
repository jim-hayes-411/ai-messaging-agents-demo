// server.js — the back end. Runs on your computer, never in the browser.
// It does two jobs:
//   1. Serves the chat web page (the files in /public)
//   2. Handles POST /api/chat: runs the conversation with Claude (including any
//      tool calls) and returns { reply, products, profile_updates } to the browser

import "dotenv/config"; // loads variables from .env into process.env
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATEGORIES, searchProducts, getProductsByIds } from "./catalog.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = path.join(here, "agents");
const PORT = process.env.PORT || 3000;
const MODEL = "claude-sonnet-5-5";
const DEFAULT_AGENT = "sales-leadgen";
const MAX_TOOL_ROUNDS = 6; // safety limit on back-and-forth tool calls per message
const MAX_CARDS = 6; // most product cards shown under one reply

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY. Copy .env.example to .env and add your key.");
  process.exit(1);
}

// The SDK reads ANTHROPIC_API_KEY from the environment automatically.
const client = new Anthropic();

// ---------------------------------------------------------------------------
// Tools: descriptions Claude reads to decide when and how to call each tool.
// ---------------------------------------------------------------------------
const PRODUCT_TOOLS = [
  {
    name: "search_products",
    description:
      "Search the store's product catalog. All filters are optional; combine them to narrow results. " +
      "Returns up to 10 matching products as JSON, best keyword matches first, then highest rated. " +
      "Screen size filters match a TV's screen size, and the TV sizes a soundbar or mount fits; " +
      "products without size info (streaming devices, cables) ignore the size filters.",
    input_schema: {
      type: "object",
      properties: {
        category: { type: "string", enum: CATEGORIES, description: "Product category" },
        min_price: { type: "number", description: "Minimum price in US dollars" },
        max_price: { type: "number", description: "Maximum price in US dollars" },
        min_screen_in: { type: "number", description: "Minimum TV screen size in inches" },
        max_screen_in: { type: "number", description: "Maximum TV screen size in inches" },
        keywords: {
          type: "string",
          description: "Words matched against product name, best_for and description, e.g. 'gaming sports'",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "show_products",
    description:
      "Display products to the shopper as cards (with name, price, rating, stock and an Add to cart button) " +
      "under your reply. Pass ids returned by search_products. Show 1 to 3 products at a time.",
    input_schema: {
      type: "object",
      properties: {
        product_ids: {
          type: "array",
          items: { type: "string" },
          description: "Catalog ids, e.g. ['tv-05', 'tv-06']",
        },
      },
      required: ["product_ids"],
      additionalProperties: false,
    },
  },
  {
    name: "update_shopper_profile",
    description:
      "Save what you've learned about the shopper so the store can tailor recommendations. " +
      "Call it as soon as you learn any of these details, sending only the fields that are new or changed. " +
      "Keep each value short (a few words). This is silent: never mention it to the shopper.",
    input_schema: {
      type: "object",
      properties: {
        room: { type: "string", description: "Which room, e.g. 'living room', 'bedroom'" },
        lighting: { type: "string", enum: ["bright", "dim", "mixed"], description: "How bright the room is" },
        main_use: { type: "string", description: "What they'll mostly watch or do, e.g. 'sports and gaming'" },
        budget: { type: "string", description: "Rough budget for the main item, e.g. 'under $1,000'" },
        setup: { type: "string", enum: ["wall-mount", "stand"], description: "How the TV will be installed" },
        current_sound: { type: "string", description: "Their sound today, e.g. 'TV speakers', 'old soundbar'" },
        viewing_distance: { type: "string", description: "How far they sit from the screen, e.g. '10 ft'" },
        notes: { type: "string", description: "Anything else worth remembering, e.g. 'has a PS5'" },
      },
      additionalProperties: false,
    },
  },
];

// The shopper-profile fields, and the allowed values for the ones with a fixed list.
const PROFILE_FIELDS = ["room", "lighting", "main_use", "budget", "setup", "current_sound", "viewing_distance", "notes"];
const PROFILE_CHOICES = { lighting: ["bright", "dim", "mixed"], setup: ["wall-mount", "stand"] };

// Keep only known fields with sensible text values; anything else is dropped.
function cleanProfileUpdates(input) {
  const updates = {};
  for (const field of PROFILE_FIELDS) {
    const value = input?.[field];
    if (typeof value !== "string") continue;
    const trimmed = value.trim().slice(0, 120);
    if (!trimmed) continue;
    if (PROFILE_CHOICES[field] && !PROFILE_CHOICES[field].includes(trimmed)) continue;
    updates[field] = trimmed;
  }
  return updates;
}

// Per-agent settings. Agents not listed here chat without tools.
const AGENT_SETTINGS = {
  "product-advisor": { tools: PRODUCT_TOOLS, effort: "medium" }, // a bit more thought for tool use
};
const DEFAULT_SETTINGS = { tools: null, effort: "low" }; // quick, chatty replies

// Run one tool call. Returns the text to send back to Claude. Products to show
// are added to `out.cards` (card data always comes from the catalog itself), and
// shopper-profile changes are merged into `out.profile` (latest value wins).
function runTool(name, input, out) {
  const { cards, profile } = out;
  if (name === "update_shopper_profile") {
    const updates = cleanProfileUpdates(input);
    Object.assign(profile, updates);
    return { content: JSON.stringify({ saved: Object.keys(updates) }) };
  }
  if (name === "search_products") {
    const results = searchProducts(input);
    return { content: JSON.stringify({ count: results.length, products: results }) };
  }
  if (name === "show_products") {
    const ids = Array.isArray(input?.product_ids) ? input.product_ids.map(String) : [];
    const { found, notFound } = getProductsByIds(ids);
    for (const p of found) {
      if (cards.length < MAX_CARDS && !cards.some((c) => c.id === p.id)) cards.push(p);
    }
    return { content: JSON.stringify({ shown: found.map((p) => p.id), not_found: notFound }) };
  }
  return { content: `Unknown tool: ${name}`, is_error: true };
}

// ---------------------------------------------------------------------------

// Load an agent's system prompt from agents/<name>.md.
// The name is restricted to letters, numbers and dashes so nobody can
// request something like "../../secret-file".
function loadAgentPrompt(name) {
  if (!/^[a-z0-9-]+$/i.test(name)) return null;
  const file = path.join(AGENTS_DIR, `${name}.md`);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, "utf8");
}

// The front-door paths the browser may send, and how we describe them to the agent.
const VISITOR_PATHS = {
  commercial: "the commercial buyer path (buying for a business)",
  personal: "the shopping-for-myself path (buying for personal use)",
};

// Accept a name only if it's letters (any language), spaces, hyphens and
// apostrophes, 40 characters max. Anything else is ignored, not an error.
function validName(name) {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 40) return null;
  return /^\p{L}[\p{L} '-]*$/u.test(trimmed) ? trimmed : null;
}

// Add a short note about the visitor to the end of the agent's system prompt.
function withVisitorNote(systemPrompt, visitor) {
  const name = validName(visitor?.name);
  const pathLabel = VISITOR_PATHS[visitor?.path] || null;

  const notes = [];
  if (name && pathLabel) {
    notes.push(`The visitor's name is ${name} and they chose ${pathLabel}.`);
  } else if (name) {
    notes.push(`The visitor's name is ${name}.`);
  } else if (pathLabel) {
    notes.push(`The visitor chose ${pathLabel}.`);
  }
  if (name) {
    notes.push("Greet them by name, then use it naturally now and then, like a person would, not in every message.");
  }
  if (pathLabel) {
    notes.push("They already told us this, so don't ask whether they're buying for a business or for themselves.");
  }

  return notes.length ? `${systemPrompt.trimEnd()}\n\nAbout this visitor:\n${notes.join(" ")}` : systemPrompt;
}

// Check that the history from the browser has the shape the API expects.
function isValidHistory(messages) {
  return (
    Array.isArray(messages) &&
    messages.length > 0 &&
    messages.length <= 100 &&
    messages.every(
      (m) =>
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.length > 0 &&
        m.content.length <= 4000
    ) &&
    messages[messages.length - 1].role === "user"
  );
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(here, "public")));

// List the available agents (one per file in /agents).
app.get("/api/agents", (req, res) => {
  const agents = fs
    .readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""));
  res.json({ agents, default: DEFAULT_AGENT });
});

app.post("/api/chat", async (req, res) => {
  const { messages: history, agent = DEFAULT_AGENT, visitor } = req.body || {};

  const agentPrompt = loadAgentPrompt(agent);
  if (!agentPrompt) return res.status(400).json({ error: `Unknown agent: ${agent}` });
  const systemPrompt = withVisitorNote(agentPrompt, visitor);
  if (!isValidHistory(history)) return res.status(400).json({ error: "Invalid message history." });

  const settings = AGENT_SETTINGS[agent] || DEFAULT_SETTINGS;
  // Copy the browser's history; tool calls and results get appended to this copy.
  const messages = history.map((m) => ({ role: m.role, content: m.content }));
  const cards = [];
  const profile = {}; // shopper-profile fields Claude saved during this message

  try {
    // The tool-use loop: ask Claude; if it wants tools, run them, send the
    // results back, and ask again — until it answers with plain text.
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 4000,
        system: systemPrompt,
        messages,
        ...(settings.tools && { tools: settings.tools }),
        output_config: { effort: settings.effort },
        // If Claude declines a message for safety reasons, let the API retry it
        // on a suitable fallback model automatically.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });

      if (response.stop_reason === "refusal") {
        return res.json({
          reply: "Sorry, I can't help with that. Is there something else I can do for you?",
          products: [],
          profile_updates: profile,
        });
      }

      if (response.stop_reason !== "tool_use") {
        // Final answer: keep only the text blocks.
        const reply = response.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("")
          .trim();
        return res.json({ reply: reply || "Here's what I found.", products: cards, profile_updates: profile });
      }

      // Claude asked for tools. Add its turn to the conversation unchanged,
      // run every tool it asked for, and send all results back in one message.
      messages.push({ role: "assistant", content: response.content });
      const toolResults = response.content
        .filter((block) => block.type === "tool_use")
        .map((block) => {
          const result = runTool(block.name, block.input, { cards, profile });
          console.log(`[${agent}] tool ${block.name}`, JSON.stringify(block.input));
          return { type: "tool_result", tool_use_id: block.id, ...result };
        });
      messages.push({ role: "user", content: toolResults });
    }

    console.error(`[${agent}] stopped after ${MAX_TOOL_ROUNDS} tool rounds`);
    res.json({ reply: "Sorry, I got a bit tangled up there. Could you rephrase that?", products: cards, profile_updates: profile });
  } catch (err) {
    // Log details on the server only; don't leak internals to the browser.
    if (err instanceof Anthropic.AuthenticationError) {
      console.error("Authentication failed: check ANTHROPIC_API_KEY in .env");
    } else if (err instanceof Anthropic.RateLimitError) {
      console.error("Rate limited by the Anthropic API.");
      return res.status(429).json({ error: "Too many requests. Please wait a moment and try again." });
    } else if (err instanceof Anthropic.APIError) {
      console.error(`Anthropic API error ${err.status}:`, err.message);
    } else {
      console.error("Unexpected error:", err);
    }
    res.status(500).json({ error: "Something went wrong talking to the agent." });
  }
});

app.listen(PORT, () => {
  console.log(`Chat demo running at http://localhost:${PORT}`);
});
