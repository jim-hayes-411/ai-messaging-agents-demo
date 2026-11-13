// app.js — runs in the visitor's browser. It never sees the API key;
// it only talks to our own server at /api/chat.

const AGENT = "sales-leadgen"; // which file in /agents to use

const messagesEl = document.getElementById("messages");
const form = document.getElementById("chat-form");
const input = document.getElementById("chat-input");
const sendBtn = document.getElementById("send-btn");

// The whole conversation, sent to the server each time so the agent remembers context.
const history = [];

// Add a message bubble to the window. We use textContent (not innerHTML)
// so nothing the user or agent types can inject HTML into the page.
function addBubble(text, kind) {
  const div = document.createElement("div");
  div.className = `bubble ${kind}`;
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function showTyping() {
  const div = document.createElement("div");
  div.className = "bubble assistant typing";
  div.innerHTML = "<span></span><span></span><span></span>";
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
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
