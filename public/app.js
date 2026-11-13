// app.js — runs in the visitor's browser. It never sees the API key;
// it only talks to our own server at /api/chat.

// Which agent to talk to comes from the URL, e.g. /?agent=product-advisor
const AGENT = new URLSearchParams(location.search).get("agent") || "sales-leadgen";

// Display names for the header. (Keep in sync with the names in each agent's prompt.)
const AGENT_NAMES = {
  "sales-leadgen": "Zoltan",
  "product-advisor": "Nova",
};

const messagesEl = document.getElementById("messages");
const form = document.getElementById("chat-form");
const input = document.getElementById("chat-input");
const sendBtn = document.getElementById("send-btn");
const cartEl = document.getElementById("cart");
const cartCountEl = document.getElementById("cart-count");

const agentName = AGENT_NAMES[AGENT] || "Assistant";
document.getElementById("agent-name").textContent = agentName;
document.getElementById("agent-avatar").textContent = agentName[0];

// The whole conversation, sent to the server each time so the agent remembers context.
const history = [];
let cartCount = 0;

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// Add a message bubble to the window. We use textContent (not innerHTML)
// so nothing the user or agent types can inject HTML into the page.
function addBubble(text, kind) {
  const div = document.createElement("div");
  div.className = `bubble ${kind}`;
  div.textContent = text;
  messagesEl.appendChild(div);
  scrollToBottom();
  return div;
}

function showTyping() {
  const div = document.createElement("div");
  div.className = "bubble assistant typing";
  div.innerHTML = "<span></span><span></span><span></span>";
  messagesEl.appendChild(div);
  scrollToBottom();
  return div;
}

// Small helper: make an element with a class and text.
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
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
// catalog (via the server), and are inserted as text, never as HTML.
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

function setBusy(busy) {
  input.disabled = busy;
  sendBtn.disabled = busy;
  if (!busy) input.focus();
}

async function sendToAgent() {
  setBusy(true);
  const typing = showTyping();
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: AGENT, messages: history }),
    });
    const data = await res.json();
    typing.remove();

    if (!res.ok) throw new Error(data.error || "Request failed");

    history.push({ role: "assistant", content: data.reply });
    addBubble(data.reply, "assistant");
    addProductCards(data.products);
  } catch (err) {
    typing.remove();
    history.pop(); // drop the message that failed so the visitor can resend it
    addBubble(`⚠️ ${err.message}`, "error");
  } finally {
    setBusy(false);
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault(); // stop the page from reloading
  const text = input.value.trim();
  if (!text) return;

  history.push({ role: "user", content: text });
  addBubble(text, "user");
  input.value = "";
  sendToAgent();
});

// Kick off the conversation so the agent greets the visitor first.
// (The API needs a user message to start, so we send a hidden one.)
history.push({ role: "user", content: "Hi! I just landed on your website." });
sendToAgent();
