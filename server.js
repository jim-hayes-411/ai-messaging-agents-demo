// server.js — the back end. Runs on your computer, never in the browser.
// It does two jobs:
//   1. Serves the chat web page (the files in /public)
//   2. Handles POST /api/chat: runs the conversation with Claude (including any
//      tool calls) and returns { reply, products, profile_updates, cart_removals }
//      to the browser

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
        name: { type: "string", description: "The shopper's first name, only if they tell you it" },
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
  {
    name: "remove_from_cart",
    description:
      "Remove an item from the shopper's cart, e.g. when they say they added something by mistake or changed their mind. " +
      "Only items listed in the current cart can be removed. If it's unclear which item they mean, ask before removing.",
    input_schema: {
      type: "object",
      properties: {
        product_id: { type: "string", description: "Catalog id of the item to remove, from the current cart" },
        quantity: { type: "integer", minimum: 1, description: "How many to remove (default 1)" },
      },
      required: ["product_id"],
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
  const name = validName(input?.name);
  if (name) updates.name = name;
  return updates;
}

// The cart the browser sent: a list of catalog ids in the order they were added
// (repeats allowed). Unknown ids are dropped. Returns { id: count }.
function cartCounts(cart) {
  const counts = {};
  if (!Array.isArray(cart)) return counts;
  for (const id of cart.slice(0, 50)) {
    if (typeof id !== "string") continue;
    if (getProductsByIds([id]).found.length) counts[id] = (counts[id] || 0) + 1;
  }
  return counts;
}

// Describe the cart for the agent's system prompt, one line per product.
function cartNote(counts) {
  const ids = Object.keys(counts);
  if (ids.length === 0) return "The shopper's cart is empty.";
  const { found } = getProductsByIds(ids);
  const lines = found.map((p) => `- ${p.id}: ${p.name}, $${p.price}${counts[p.id] > 1 ? ` (quantity ${counts[p.id]})` : ""}`);
  return `The shopper's cart right now (they add items with the buttons on the product cards):\n${lines.join("\n")}`;
}

// Per-agent settings. Agents not listed here chat without tools.
const AGENT_SETTINGS = {
  // A bit more thought for tool use; `cart: true` shows the agent the shopper's cart.
  "product-advisor": { tools: PRODUCT_TOOLS, effort: "medium", cart: true },
};
const DEFAULT_SETTINGS = { tools: null, effort: "low" }; // quick, chatty replies

// Run one tool call. Returns the text to send back to Claude. Products to show
// are added to `out.cards` (card data always comes from the catalog itself),
// shopper-profile changes are merged into `out.profile` (latest value wins), and
// removals are counted in `out.removals` and taken off `out.cart`, so the same
// item can't be removed more times than it's in the cart.
function runTool(name, input, out) {
  const { cards, profile, cart, removals } = out;
  if (name === "remove_from_cart") {
    const id = String(input?.product_id ?? "");
    const inCart = cart[id] || 0;
    if (inCart === 0) {
      return { content: JSON.stringify({ error: `${id} is not in the cart`, cart: cart }), is_error: true };
    }
    const qty = Math.min(Number.isInteger(input?.quantity) && input.quantity > 0 ? input.quantity : 1, inCart);
    cart[id] = inCart - qty;
    if (cart[id] === 0) delete cart[id];
    removals[id] = (removals[id] || 0) + qty;
    return { content: JSON.stringify({ removed: id, quantity: qty, remaining_in_cart: cart }) };
  }
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
  const { messages: history, agent = DEFAULT_AGENT, visitor, cart: cartIds } = req.body || {};

  const agentPrompt = loadAgentPrompt(agent);
  if (!agentPrompt) return res.status(400).json({ error: `Unknown agent: ${agent}` });
  if (!isValidHistory(history)) return res.status(400).json({ error: "Invalid message history." });

  const settings = AGENT_SETTINGS[agent] || DEFAULT_SETTINGS;
  const cart = cartCounts(cartIds); // { id: count }; remove_from_cart updates it as it goes
  let systemPrompt = withVisitorNote(agentPrompt, visitor);
  if (settings.cart) systemPrompt += `\n\n${cartNote(cart)}`;
  // Copy the browser's history; tool calls and results get appended to this copy.
  const messages = history.map((m) => ({ role: m.role, content: m.content }));
  const cards = [];
  const profile = {}; // shopper-profile fields Claude saved during this message
  const removals = {}; // { id: quantity } Claude removed from the cart during this message
  // Everything the browser gets back, apart from the reply text.
  const extras = () => ({ products: cards, profile_updates: profile, cart_removals: removals });

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
          ...extras(),
          products: [],
        });
      }

      if (response.stop_reason !== "tool_use") {
        // Final answer: keep only the text blocks.
        const reply = response.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("")
          .trim();
        return res.json({ reply: reply || "Here's what I found.", ...extras() });
      }

      // Claude asked for tools. Add its turn to the conversation unchanged,
      // run every tool it asked for, and send all results back in one message.
      messages.push({ role: "assistant", content: response.content });
      const toolResults = response.content
        .filter((block) => block.type === "tool_use")
        .map((block) => {
          const result = runTool(block.name, block.input, { cards, profile, cart, removals });
          console.log(`[${agent}] tool ${block.name}`, JSON.stringify(block.input));
          return { type: "tool_result", tool_use_id: block.id, ...result };
        });
      messages.push({ role: "user", content: toolResults });
    }

    console.error(`[${agent}] stopped after ${MAX_TOOL_ROUNDS} tool rounds`);
    res.json({ reply: "Sorry, I got a bit tangled up there. Could you rephrase that?", ...extras() });
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

const server = app.listen(PORT);
server.on("listening", () => {
  console.log(`Chat demo running at http://localhost:${PORT}`);
});
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `Port ${PORT} is already in use (probably another copy of this server).\n` +
        `Stop it first, or pick another port, e.g.  PORT=${Number(PORT) + 1} npm start`
    );
  } else {
    console.error("Server failed to start:", err.message);
  }
  process.exit(1);
});
