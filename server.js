// server.js — the back end. Runs on your computer, never in the browser.
// It does two jobs:
//   1. Serves the chat web page (the files in /public)
//   2. Handles POST /api/chat: forwards the conversation to Claude and returns the reply

import "dotenv/config"; // loads variables from .env into process.env
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = path.join(here, "agents");
const PORT = process.env.PORT || 3000;
const MODEL = "claude-sonnet-5-5";
const DEFAULT_AGENT = "sales-leadgen";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY. Copy .env.example to .env and add your key.");
  process.exit(1);
}

// The SDK reads ANTHROPIC_API_KEY from the environment automatically.
const client = new Anthropic();

// Load an agent's system prompt from agents/<name>.md.
// The name is restricted to letters, numbers and dashes so nobody can
// request something like "../../secret-file".
function loadAgentPrompt(name) {
  if (!/^[a-z0-9-]+$/i.test(name)) return null;
  const file = path.join(AGENTS_DIR, `${name}.md`);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, "utf8");
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
  const { messages, agent = DEFAULT_AGENT } = req.body || {};

  const systemPrompt = loadAgentPrompt(agent);
  if (!systemPrompt) return res.status(400).json({ error: `Unknown agent: ${agent}` });
  if (!isValidHistory(messages)) return res.status(400).json({ error: "Invalid message history." });

  try {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system: systemPrompt,
      messages, // the full conversation so far, so Claude has context
      output_config: { effort: "low" }, // quick, chatty replies
      // If Claude declines a message for safety reasons, let the API retry it
      // on a suitable fallback model automatically.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });

    if (response.stop_reason === "refusal") {
      return res.json({ reply: "Sorry, I can't help with that. Is there something else I can do for you?" });
    }

    // The reply is a list of content blocks; we only want the text ones.
    const reply = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();

    res.json({ reply });
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
