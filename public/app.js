// app.js — runs in the visitor's browser. It never sees the API key;
// it only talks to our own server at /api/chat.
//
// The chat has two stages:
//   1. The "front door": a few scripted questions (name, then which path).
//      No AI is involved here; it's all in this file.
//   2. The agent conversation: messages go to /api/chat and the agent replies.

// Display names for the header. (Keep in sync with the names in each agent's prompt.)
const AGENT_NAMES = {
  "sales-leadgen": "Zoltan",
  "product-advisor": "Nova",
};

// The two front-door choices: button label, which agent, and the path id sent to the server.
const PATHS = [
  { label: "Commercial buyer", agent: "sales-leadgen", path: "commercial" },
  { label: "Shopping for myself", agent: "product-advisor", path: "personal" },
];

// Shortcut: /?agent=product-advisor skips the front door.
const URL_AGENT = new URLSearchParams(location.search).get("agent");

const messagesEl = document.getElementById("messages");
const form = document.getElementById("chat-form");
const input = document.getElementById("chat-input");
const sendBtn = document.getElementById("send-btn");
const cartEl = document.getElementById("cart");
const cartCountEl = document.getElementById("cart-count");
const nameEl = document.getElementById("agent-name");
const avatarEl = document.getElementById("agent-avatar");
const statusEl = document.getElementById("agent-status");

// ---- Conversation state (all reset by "Start over") ----
let stage = "name"; // "name" → "path" → "agent"
let agent = null; // which agent we're talking to, once routed
let visitor = { name: null, path: null };
let history = []; // the agent conversation, sent to the server each time
let cartCount = 0;
let conversationId = 0; // bumps on Start over so late replies from an old chat are ignored

// ---------------------------------------------------------------------------
// Small UI helpers
// ---------------------------------------------------------------------------

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// Make an element with a class and text. Text is always inserted as text,
// never as HTML, so nothing typed by anyone can inject HTML into the page.
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function addBubble(text, kind) {
  const div = el("div", `bubble ${kind}`, text);
  messagesEl.appendChild(div);
  scrollToBottom();
  return div;
}

function showTyping() {
  const div = el("div", "bubble assistant typing");
  div.innerHTML = "<span></span><span></span><span></span>";
  messagesEl.appendChild(div);
  scrollToBottom();
  return div;
}

function setHeader(name, status) {
  nameEl.textContent = name;
  avatarEl.textContent = name[0];
  statusEl.textContent = status;
}

// Turn the text box on or off. `placeholder` explains why it's off.
function setInputEnabled(enabled, placeholder = "Type a message…") {
  input.disabled = !enabled;
  sendBtn.disabled = !enabled;
  input.placeholder = placeholder;
  if (enabled) input.focus();
}

// ---------------------------------------------------------------------------
// Front door
// ---------------------------------------------------------------------------

// Words that tell us the visitor answered with something other than a name.
const NOT_NAME_WORDS = new Set([
  "no", "nope", "nah", "not", "thanks", "thank", "you", "skip", "pass", "rather",
  "hi", "hello", "hey", "yes", "yeah", "ok", "okay", "sure", "none", "nothing",
  "anonymous", "later", "why", "what", "just", "looking", "want", "need", "help",
  "the", "and", "for", "with", "buy", "buying", "shopping",
]);

// Clean up what the visitor typed and return a name, or null if it isn't clearly one.
function cleanName(raw) {
  let s = raw
    .trim()
    .replace(/[’‘]/g, "'") // curly apostrophes → plain (O’Brien → O'Brien)
    .replace(/\s+/g, " "); // collapse repeated spaces

  // Accept friendly answers like "I'm Sam" or "my name is Sam".
  s = s.replace(/^(my name is|my name's|name's|i am|i'm|im|it's|its|this is|call me)\s+/i, "");
  s = s.replace(/[.!]+$/, ""); // drop trailing "." or "!"
  s = s.slice(0, 40).trim();

  if (!s) return null;
  // Letters (any language), spaces, hyphens and apostrophes; must start with a letter.
  if (!/^\p{L}[\p{L} '-]*$/u.test(s)) return null;
  const words = s.toLowerCase().split(" ");
  if (words.length > 3) return null; // a sentence, not a name
  if (words.some((w) => NOT_NAME_WORDS.has(w))) return null;

  return s[0].toUpperCase() + s.slice(1);
}

function startFrontDoor() {
  stage = "name";
  setHeader("Welcome", "We usually reply instantly");
  addBubble("Hi! Welcome. What's your name?", "assistant");
  setInputEnabled(true, "Type your name…");
}

function handleNameAnswer(text) {
  visitor.name = cleanName(text);
  const greeting = visitor.name ? `Nice to meet you, ${visitor.name}!` : "Thanks!";
  addBubble(`${greeting} Are you a commercial buyer, or shopping for yourself?`, "assistant");
  showPathButtons();
}

function showPathButtons() {
  stage = "path";
  setInputEnabled(false, "Choose an option above");

  const wrap = el("div", "quick-replies");
  for (const choice of PATHS) {
    const btn = el("button", "quick-reply", choice.label);
    btn.type = "button";
    btn.addEventListener("click", () => {
      wrap.remove(); // hide the buttons
      addBubble(choice.label, "user"); // show the choice as the visitor's own message
      visitor.path = choice.path;
      startAgent(choice.agent);
    });
    wrap.append(btn);
  }
  messagesEl.appendChild(wrap);
  scrollToBottom();
}

// ---------------------------------------------------------------------------
// Agent conversation
// ---------------------------------------------------------------------------

function startAgent(agentId) {
  stage = "agent";
  agent = agentId;
  setHeader(AGENT_NAMES[agent] || "Assistant", "AI assistant · online");
  // The API needs a user message to start, so we send a hidden one;
  // the agent replies with its greeting.
  history.push({ role: "user", content: "Hi!" });
  sendToAgent();
}

// Pick one or two headline specs for each kind of product.
function keySpecs(p) {
  const s = p.specs || {};
  switch (p.category) {
    case "tv":
      return [`${s.screen_in}" ${s.panel}`, `${s.refresh_hz}Hz`];
    case "streaming":
      return [s.resolution, s.voice_remote ? "Voice remote" : null];
    case "soundbar":
      return [`${s.channels} channel`, s.dolby_atmos ? "Dolby Atmos" : null];
    case "mount":
      return [`${s.type} mount`, s.tv_size_in ? `Fits ${s.tv_size_in[0]}–${s.tv_size_in[1]}" TVs` : null];
    case "cable":
      return [`HDMI ${s.hdmi_version}`, s.length_ft ? `${s.length_ft} ft` : null];
    default:
      return [];
  }
}

function addToCart(button) {
  cartCount++;
  cartCountEl.textContent = cartCount;
  cartEl.classList.remove("bump");
  void cartEl.offsetWidth; // restart the little "bump" animation
  cartEl.classList.add("bump");
  button.textContent = "Added ✓";
  setTimeout(() => (button.textContent = "Add to cart"), 1200);
}

// Render product cards under the agent's message. All values come from the
// catalog (via the server).
function addProductCards(products) {
  if (!products || products.length === 0) return;
  cartEl.hidden = false;

  const wrap = el("div", "cards");
  for (const p of products) {
    const card = el("div", "card");
    card.append(el("div", "card-brand", p.brand), el("div", "card-name", p.name));

    const specs = keySpecs(p).filter(Boolean).join(" · ");
    if (specs) card.append(el("div", "card-specs", specs));

    const row = el("div", "card-row");
    row.append(
      el("span", "card-price", `$${p.price.toLocaleString()}`),
      el("span", "card-rating", `★ ${p.rating.toFixed(1)}`),
      el("span", p.in_stock ? "badge in" : "badge out", p.in_stock ? "In stock" : "Out of stock")
    );
    card.append(row);

    const btn = el("button", "add-btn", p.in_stock ? "Add to cart" : "Unavailable");
    btn.type = "button";
    btn.disabled = !p.in_stock;
    btn.addEventListener("click", () => addToCart(btn));
    card.append(btn);

    wrap.append(card);
  }
  messagesEl.appendChild(wrap);
  scrollToBottom();
}

async function sendToAgent() {
  const myConversation = conversationId;
  setInputEnabled(false);
  const typing = showTyping();
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent, visitor, messages: history }),
    });
    const data = await res.json();
    if (myConversation !== conversationId) return; // visitor clicked Start over meanwhile
    typing.remove();

    if (!res.ok) throw new Error(data.error || "Request failed");

    history.push({ role: "assistant", content: data.reply });
    addBubble(data.reply, "assistant");
    addProductCards(data.products);
  } catch (err) {
    if (myConversation !== conversationId) return;
    typing.remove();
    history.pop(); // drop the message that failed so the visitor can resend it
    addBubble(`⚠️ ${err.message}`, "error");
  } finally {
    if (myConversation === conversationId) setInputEnabled(true);
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

form.addEventListener("submit", (event) => {
  event.preventDefault(); // stop the page from reloading
  const text = input.value.trim();
  if (!text) return;
  addBubble(text, "user");
  input.value = "";

  if (stage === "name") {
    handleNameAnswer(text);
  } else if (stage === "agent") {
    history.push({ role: "user", content: text });
    sendToAgent();
  }
});

// "Start over": clear the chat, name and cart, and go back to the first question.
document.getElementById("start-over").addEventListener("click", () => {
  conversationId++;
  agent = null;
  visitor = { name: null, path: null };
  history = [];
  cartCount = 0;
  cartCountEl.textContent = "0";
  cartEl.hidden = true;
  messagesEl.replaceChildren();
  // Drop any ?agent= shortcut from the address bar so a refresh also starts fresh.
  if (URL_AGENT) window.history.replaceState(null, "", location.pathname);
  startFrontDoor();
});

// On page load: the ?agent= shortcut goes straight to that agent; otherwise the front door.
if (URL_AGENT) {
  startAgent(URL_AGENT);
} else {
  startFrontDoor();
}
