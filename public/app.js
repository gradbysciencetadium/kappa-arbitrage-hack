const startBtn = document.getElementById("start-btn");
const hero = document.getElementById("hero");
const chatSection = document.getElementById("chat-section");
const chatWindow = document.getElementById("chat-window");
const chatForm = document.getElementById("chat-form");
const chatText = document.getElementById("chat-text");
const sendBtn = document.getElementById("send-btn");
const resetBtn = document.getElementById("reset-btn");
const chatStatus = document.getElementById("chat-status");
const brandHome = document.getElementById("brand-home");

let conversationId = null;
let busy = false;

// Request headers including the auth token when the user is signed in.
const authHeaders = (extra) =>
  window.KappaAuth ? window.KappaAuth.headers(extra) : Object.assign({ "Content-Type": "application/json" }, extra || {});

const WELCOME =
  "Welcome to **Kappa Arbitrage**. I'm here to understand your business and the " +
  "decision you're facing, then deliver a data-backed consulting report.\n\n" +
  "To begin: what does your business do, and what question is on your mind?";

// --- View navigation (hero <-> consultation). Logo = home; browser back works too. ---
function showChat() {
  hero.hidden = true;
  chatSection.hidden = false;
  if (!chatWindow.childElementCount) addAgentMessage(WELCOME);
  chatText.focus();
}
function showHome() {
  chatSection.hidden = true;
  hero.hidden = false;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

startBtn.addEventListener("click", () => {
  showChat();
  if (location.hash !== "#consultation") history.pushState({ view: "chat" }, "", "#consultation");
});

// Browser back / forward
window.addEventListener("popstate", () => {
  if (location.hash === "#consultation") showChat();
  else showHome();
});

// Logo returns to home (and keeps the URL/history consistent).
if (brandHome) {
  const goHome = (e) => {
    if (e) e.preventDefault();
    if (chatSection.hidden) return; // already home
    showHome();
    if (location.hash === "#consultation") history.replaceState({ view: "home" }, "", location.pathname);
  };
  brandHome.addEventListener("click", goHome);
  brandHome.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); goHome(); }
  });
}

// Deep-link support: arriving with #consultation seeds a home history entry, then opens
// the chat — so BOTH the logo and the browser back button return home from any entry path.
if (location.hash === "#consultation") {
  history.replaceState({ view: "home" }, "", location.pathname);
  history.pushState({ view: "chat" }, "", "#consultation");
  showChat();
}

resetBtn.addEventListener("click", () => newConsultation());

// Start a fresh consultation (also reachable from the account menu).
function newConsultation() {
  if (busy) return;
  conversationId = null;
  showChat();
  if (location.hash !== "#consultation") history.pushState({ view: "chat" }, "", "#consultation");
  chatWindow.innerHTML = "";
  chatStatus.textContent = "Connected — tell us about your business to begin.";
  addAgentMessage(WELCOME);
  chatText.focus();
}

// Reopen a saved consultation: replay its messages, restore the report, keep chatting.
async function resumeConversation(id) {
  if (busy) return;
  showChat();
  if (location.hash !== "#consultation") history.pushState({ view: "chat" }, "", "#consultation");
  conversationId = id;
  chatWindow.innerHTML = "";
  chatStatus.textContent = "Loading your consultation…";
  try {
    const res = await fetch("/api/conversation/" + encodeURIComponent(id), { headers: authHeaders() });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not load this consultation.");
    chatWindow.innerHTML = "";
    (data.messages || []).forEach((m) => {
      if (m.role === "user") addUserMessage(m.text);
      else addAgentMessage(m.text || "");
    });
    if (!data.messages || !data.messages.length) addAgentMessage(WELCOME);
    if (data.report && data.report.status === "done" && data.report.result) {
      renderReport(data.report.result, data.report.meta);
    } else if (data.report && data.report.status === "failed") {
      addErrorMessage("The earlier analysis failed: " + (data.report.error || "unknown error"));
    }
    chatStatus.textContent = "Connected — continue the conversation, or ask Bara to dig deeper.";
  } catch (err) {
    addErrorMessage(err.message);
    chatStatus.textContent = "Connected";
  }
  chatText.focus();
}

// Let the accounts UI (auth.js) drive navigation.
window.KappaApp = { resumeConversation, newConsultation, onLogin: () => {}, onLogout: () => {} };

chatText.addEventListener("input", autoGrow);
chatText.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    chatForm.requestSubmit();
  }
});

chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const message = chatText.value.trim();
  if (!message || busy) return;

  addUserMessage(message);
  chatText.value = "";
  autoGrow();
  setBusy(true);

  const typing = addTyping();
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ message, conversationId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Something went wrong.");
    conversationId = data.conversationId;
    typing.remove();
    addAgentMessage(data.reply || "(no response)");

    // Kappy has produced the Context Brief — hand off to Bara.
    if (data.briefReady) {
      await runAnalysis();
    }
  } catch (err) {
    typing.remove();
    addErrorMessage(err.message);
  } finally {
    setBusy(false);
    chatText.focus();
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Bara pipeline stages — keys match the server's onProgress strings.
const BARA_STAGES = [
  { key: "plan", label: "Plan", match: ["planning"] },
  { key: "review", label: "Review", match: ["reviewing the plan"] },
  { key: "compute", label: "Compute", match: ["computing metrics"] },
  { key: "research", label: "Research", match: ["researching"] },
  { key: "validate", label: "Validate", match: ["validation"] },
  { key: "synth", label: "Synthesize", match: ["writing the report"] },
  { key: "audit", label: "Audit", match: ["reviewing the report", "revising"] },
];
const HEX = "0123456789abcdef";
const randHex = (n) => Array.from({ length: n }, () => HEX[(Math.random() * 16) | 0]).join("");

// Kick off Bara (async job), then poll for live progress, animating the pipeline.
async function runAnalysis() {
  const wrap = addBaraWorking();
  const finish = () => { if (wrap._cleanup) wrap._cleanup(); wrap.remove(); };
  const setProgress = (txt) => {
    if (!txt) return;
    const status = wrap.querySelector(".bara-status");
    if (status) status.textContent = "› " + txt;
    markStage(wrap, txt);
  };
  try {
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ conversationId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Analysis failed.");
    const reportId = data.reportId;

    const deadline = Date.now() + 15 * 60 * 1000;
    while (Date.now() < deadline) {
      await sleep(3000);
      const r = await fetch("/api/report/" + reportId, { headers: authHeaders() });
      const rd = await r.json();
      if (!r.ok) throw new Error(rd.error || "Could not fetch report.");
      if (rd.progress) setProgress(rd.progress);
      if (rd.status === "done") {
        markAllDone(wrap);
        await sleep(450);
        finish();
        renderReport(rd.result, rd.meta);
        addLeadForm();
        return;
      }
      if (rd.status === "failed") throw new Error(rd.error || "Analysis failed.");
    }
    throw new Error("Analysis timed out.");
  } catch (err) {
    finish();
    addErrorMessage("Bara: " + err.message);
  }
}

// Live Bara pipeline visualization: an animated agent orb + stage nodes + cryptic scramble.
function addBaraWorking() {
  const div = document.createElement("div");
  div.className = "msg agent bara-stage-wrap";
  const nodes = BARA_STAGES.map(
    (s) => `<div class="pl-node" data-key="${s.key}"><span class="pl-dot"></span><span class="pl-label">${s.label}</span></div>`
  ).join("");
  div.innerHTML =
    `<div class="bara-head">
       <div class="ksprite-host" data-scale="4"></div>
       <div class="bara-title">Bara is analysing<small>sovereign pipeline · FLock qwen3-30b</small></div>
     </div>
     <div class="bara-pipeline"><div class="pl-track"></div>${nodes}</div>
     <div class="bara-status">› queued</div>
     <div class="bara-crypt"></div>`;
  chatWindow.appendChild(div);
  if (window.KappaSprites) window.KappaSprites.mount(div.querySelector(".bara-head .ksprite-host"), "bara", { scale: 4, mood: "charging" });
  scrollDown();
  const crypt = div.querySelector(".bara-crypt");
  const id = setInterval(() => {
    crypt.textContent = "0x" + randHex(8) + "  sha256:" + randHex(24) + "…";
  }, 90);
  div._cleanup = () => clearInterval(id);
  return div;
}

function markStage(wrap, txt) {
  const t = txt.toLowerCase();
  let idx = -1;
  BARA_STAGES.forEach((s, i) => { if (s.match.some((m) => t.includes(m))) idx = i; });
  if (idx < 0) return;
  BARA_STAGES.forEach((s, i) => {
    const node = wrap.querySelector(`.pl-node[data-key="${s.key}"]`);
    if (!node) return;
    node.classList.toggle("done", i < idx);
    node.classList.toggle("live", i === idx);
    if (i > idx) node.classList.remove("done", "live");
  });
}

function markAllDone(wrap) {
  wrap.querySelectorAll(".pl-node").forEach((n) => { n.classList.remove("live"); n.classList.add("done"); });
  const status = wrap.querySelector(".bara-status");
  if (status) status.textContent = "✓ report ready";
}

// "Apply for a free deep-dive" lead capture, shown after the report.
function addLeadForm() {
  const div = document.createElement("div");
  div.className = "msg agent lead-form";
  div.innerHTML =
    "<strong>Want us to take this further?</strong>" +
    "<p>We select a few businesses each month for a free, in-depth project. Leave your email to apply.</p>" +
    "<form class='lead-row'><input type='email' placeholder='you@business.com' aria-label='Your email address' autocomplete='email' required />" +
    "<button type='submit'>Apply</button></form>" +
    "<div class='lead-msg' aria-live='polite'></div>";
  chatWindow.appendChild(div);
  scrollDown();
  const form = div.querySelector("form");
  const msg = div.querySelector(".lead-msg");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = form.querySelector("input").value.trim();
    try {
      const r = await fetch("/api/lead", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ email, conversationId }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Could not save.");
      form.remove();
      msg.textContent = "Thanks — we'll be in touch.";
    } catch (err) {
      msg.textContent = err.message;
    }
  });
}

function renderReport(report, meta) {
  if (!report) {
    addErrorMessage("Bara returned no report.");
    return;
  }
  const esc = (s) => DOMPurify.sanitize(String(s == null ? "" : s));
  const parts = [];

  const baraAv = window.KappaSprites ? `<span class="report-avatar">${window.KappaSprites.staticSprite("bara", 2)}</span>` : "";
  parts.push(`<div class="report-head">${baraAv}<span class="report-badge">Bara · Kappa Arbitrage report</span>`);
  if (meta && meta.isFixture) {
    parts.push(
      '<span class="report-fixture">⚠ Built on FIXTURE sample data — not live Ofsted/ONS. For demonstration.</span>'
    );
  }
  parts.push("</div>");

  if (report.confidence != null) {
    parts.push(`<p class="report-confidence">Confidence: ${Math.round(report.confidence * 100)}%</p>`);
  }

  // Deterministic grounding proof + data coverage (from Bara's verifier).
  if (meta && meta.verification) {
    const v = meta.verification;
    const unknown = (v.ward_check && v.ward_check.unknown) || [];
    if (v.grounded) {
      parts.push(`<p class="report-verify ok">✓ Grounding verified — ${v.numbers_checked} figures traced to source data, every recommended ward exists.</p>`);
    } else {
      parts.push(
        `<p class="report-verify warn">⚠ Grounding check: ${v.ungrounded_numbers.length} figure(s) untraceable` +
          (unknown.length ? `, ${unknown.length} unknown ward(s)` : "") +
          ` — confidence reduced.</p>`
      );
    }
  }
  if (meta && meta.coverage && meta.coverage.group_based) {
    const c = meta.coverage;
    parts.push(
      `<p class="report-coverage">Data coverage: ${c.group_based.geocoded}/${c.group_based.total} nurseries mapped to wards ` +
        `(${c.group_based.geocoded_pct}%)` +
        (c.childminders ? `; ${c.childminders.count} childminders counted LA-wide (no ward-level address).` : ".") +
        `</p>`
    );
  }

  parts.push(`<h3>Executive summary</h3><p>${esc(report.executive_summary)}</p>`);
  parts.push(`<h3>Strategic question</h3><p>${esc(report.strategic_question)}</p>`);

  if (report.recommended_locations && report.recommended_locations.length) {
    parts.push("<h3>Recommended locations</h3>");
    report.recommended_locations.forEach((loc, i) => {
      parts.push(
        `<div class="report-rec"><strong>${esc(loc.rank || i + 1)}. ${esc(loc.ward_name)}</strong>` +
          `<p>${esc(loc.rationale)}</p>` +
          (loc.key_metrics ? `<p class="report-metrics">${esc(loc.key_metrics)}</p>` : "") +
          "</div>"
      );
    });
  }

  if (report.data_analysis && report.data_analysis.length) {
    parts.push("<h3>Data analysis</h3>");
    report.data_analysis.forEach((d) => {
      parts.push(
        `<div class="report-dim"><strong>${esc(d.dimension)}</strong><p>${esc(d.finding)}</p>` +
          (d.sources ? `<p class="report-src">Sources: ${esc(d.sources)}</p>` : "") +
          "</div>"
      );
    });
  }

  if (report.validation_cross_check) {
    parts.push(`<h3>Validation cross-check</h3><p>${esc(report.validation_cross_check)}</p>`);
  }

  if (report.implementation_roadmap && report.implementation_roadmap.length) {
    parts.push("<h3>Implementation roadmap</h3><ul>");
    report.implementation_roadmap.forEach((r) => {
      parts.push(`<li><strong>${esc(r.phase)}:</strong> ${esc(r.action)}</li>`);
    });
    parts.push("</ul>");
  }

  if (report.risks && report.risks.length) {
    parts.push("<h3>Risks</h3><ul>");
    report.risks.forEach((r) => parts.push(`<li>${esc(r)}</li>`));
    parts.push("</ul>");
  }

  if (report.data_sources && report.data_sources.length) {
    parts.push("<h3>Data sources</h3><ul>");
    report.data_sources.forEach((s) => parts.push(`<li>${esc(s)}</li>`));
    parts.push("</ul>");
  }

  if (report.caveats) {
    parts.push(`<p class="report-caveat">${esc(report.caveats)}</p>`);
  }

  const div = document.createElement("div");
  div.className = "msg agent report";
  div.innerHTML = parts.join("");
  chatWindow.appendChild(div);
  scrollDown();
}

function setBusy(state) {
  busy = state;
  sendBtn.disabled = state;
  chatStatus.textContent = state
    ? "Analysing — this can take a minute for full reports…"
    : "Connected";
}

function addUserMessage(text) {
  const div = document.createElement("div");
  div.className = "msg user";
  div.textContent = text;
  chatWindow.appendChild(div);
  scrollDown();
}

function addAgentMessage(markdown) {
  const row = document.createElement("div");
  row.className = "msg-row agent-row";
  const av = document.createElement("div");
  av.className = "msg-avatar";
  if (window.KappaSprites) av.innerHTML = window.KappaSprites.staticSprite("kappy", 2);
  const div = document.createElement("div");
  div.className = "msg agent";
  div.innerHTML = DOMPurify.sanitize(marked.parse(markdown));
  row.appendChild(av);
  row.appendChild(div);
  chatWindow.appendChild(row);
  scrollDown();
}

function addErrorMessage(text) {
  const div = document.createElement("div");
  div.className = "msg error";
  div.textContent = text;
  chatWindow.appendChild(div);
  scrollDown();
}

// Kappy "thinking" — an animated agent orb while intake processes your message.
const KAPPY_DOING = ["parsing your context…", "forming the next question…", "structuring the brief…"];
function addTyping() {
  const div = document.createElement("div");
  div.className = "agent-thinking kappy";
  div.innerHTML =
    `<div class="ksprite-host" data-scale="4"></div>
     <div><span class="agent-name">Kappy</span> <span class="agent-do"></span></div>`;
  div.querySelector(".agent-do").textContent = KAPPY_DOING[(Math.random() * KAPPY_DOING.length) | 0];
  chatWindow.appendChild(div);
  if (window.KappaSprites) window.KappaSprites.mount(div.querySelector(".ksprite-host"), "kappy", { scale: 4 });
  scrollDown();
  return div;
}

function autoGrow() {
  chatText.style.height = "auto";
  chatText.style.height = Math.min(chatText.scrollHeight, 144) + "px";
}

function scrollDown() {
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

// Hero coverage stats — count up to live numbers (falls back to baked values).
(function initHeroStats() {
  const nums = document.querySelectorAll("#hero-stats .stat-num[data-target]");
  if (!nums.length) return;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const animate = (el, target) => {
    const dur = 1100, t0 = performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(target * eased).toLocaleString();
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  const run = () => nums.forEach((el) => {
    const t = Number(el.dataset.target);
    if (reduce) el.textContent = t.toLocaleString();
    else animate(el, t);
  });
  fetch("/api/stats")
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (d) {
        const live = [d.localAuthorities, d.providers, d.wards];
        nums.forEach((el, i) => { if (live[i] != null) el.dataset.target = live[i]; });
        // Only claim "Sovereign" when inference is actually routed through FLock.
        const pill = document.getElementById("hero-pill");
        if (pill) pill.textContent = d.sovereign ? "Sovereign · auditable AI for UK SMBs" : "Auditable AI for UK SMBs";
      }
    })
    .catch(() => {})
    .finally(run);
})();
