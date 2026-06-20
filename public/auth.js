// Accounts UI: sign in / create account modal, the account dropdown, and the
// "My consultations" list (resume a saved consultation). Talks to /api/auth/* and
// /api/conversations. Exposes window.KappaAuth (token + headers) for app.js to use,
// and calls into window.KappaApp to resume / start consultations.

(function () {
  const TKEY = "kappa_token";
  const EKEY = "kappa_email";

  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const token = () => lsGet(TKEY);
  const email = () => lsGet(EKEY);
  const setSession = (t, e) => { try { localStorage.setItem(TKEY, t); localStorage.setItem(EKEY, e); } catch {} };
  const clearSession = () => { try { localStorage.removeItem(TKEY); localStorage.removeItem(EKEY); } catch {} };

  let state = { enabled: true, user: null };
  let convos = [];

  // --- DOM helpers (textContent everywhere — no innerHTML for user data) ---
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function input(type, placeholder, autocomplete) {
    const i = document.createElement("input");
    i.type = type; i.placeholder = placeholder; i.required = true;
    if (autocomplete) i.autocomplete = autocomplete;
    return i;
  }
  function field(label, inputEl) {
    const f = el("label", "auth-field");
    f.appendChild(el("span", "auth-label", label));
    f.appendChild(inputEl);
    return f;
  }

  // --- Request headers (attach the bearer token when signed in) ---
  function headers(extra) {
    const h = Object.assign({ "Content-Type": "application/json" }, extra || {});
    const t = token();
    if (t) h["Authorization"] = "Bearer " + t;
    return h;
  }

  // --- Account area in the topbar ---
  function render() {
    const area = document.getElementById("auth-area");
    if (!area) return;
    area.innerHTML = "";
    if (!state.enabled) return;

    if (!state.user) {
      const btn = el("button", "auth-btn", "Sign in");
      btn.addEventListener("click", () => openModal("login"));
      area.appendChild(btn);
      return;
    }

    const wrap = el("div", "account");
    const btn = el("button", "auth-btn account-btn");
    btn.appendChild(el("span", "account-dot"));
    btn.appendChild(el("span", "account-email", state.user.email));
    btn.appendChild(el("span", "account-caret", "▾"));
    const menu = buildMenu();
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = menu.classList.contains("open");
      closeMenus();
      if (!open) { menu.classList.add("open"); loadConvos(); }
    });
    wrap.appendChild(btn);
    wrap.appendChild(menu);
    area.appendChild(wrap);
  }

  function buildMenu() {
    const menu = el("div", "auth-menu");
    menu.appendChild(el("div", "auth-menu-head", "My consultations"));
    const list = el("div", "convo-list");
    list.id = "convo-list";
    renderConvos(list);
    menu.appendChild(list);
    menu.appendChild(el("div", "auth-divider"));
    const nw = el("button", "auth-menu-item", "+ New consultation");
    nw.addEventListener("click", () => { closeMenus(); window.KappaApp && window.KappaApp.newConsultation(); });
    menu.appendChild(nw);
    const out = el("button", "auth-menu-item danger", "Sign out");
    out.addEventListener("click", signOut);
    menu.appendChild(out);
    menu.addEventListener("click", (e) => e.stopPropagation());
    return menu;
  }

  function renderConvos(list) {
    list.innerHTML = "";
    if (!convos.length) {
      list.appendChild(el("div", "convo-empty", "No saved consultations yet."));
      return;
    }
    convos.forEach((c) => {
      const item = el("button", "convo-item");
      item.appendChild(el("span", "convo-title", c.title || "Untitled consultation"));
      if (c.reportStatus === "done") item.appendChild(el("span", "convo-badge", "report"));
      else if (c.reportStatus) item.appendChild(el("span", "convo-badge pending", c.reportStatus));
      item.addEventListener("click", () => { closeMenus(); window.KappaApp && window.KappaApp.resumeConversation(c.id); });
      list.appendChild(item);
    });
  }

  async function loadConvos() {
    if (!state.user) return;
    try {
      const res = await fetch("/api/conversations", { headers: headers() });
      const d = await res.json();
      convos = d.conversations || [];
    } catch { convos = []; }
    const list = document.getElementById("convo-list");
    if (list) renderConvos(list);
  }

  function closeMenus() {
    document.querySelectorAll(".auth-menu.open").forEach((m) => m.classList.remove("open"));
  }
  document.addEventListener("click", closeMenus);

  // --- Sign in / create account modal ---
  function openModal(mode) {
    closeMenus();
    const existing = document.getElementById("auth-modal");
    if (existing) existing.remove();

    const overlay = el("div", "auth-modal");
    overlay.id = "auth-modal";
    const card = el("div", "auth-card");

    const close = el("button", "auth-close", "✕");
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", () => overlay.remove());

    const tabs = el("div", "auth-tabs");
    const tabLogin = el("button", "auth-tab", "Sign in");
    const tabSignup = el("button", "auth-tab", "Create account");
    tabs.appendChild(tabLogin);
    tabs.appendChild(tabSignup);

    const title = el("h2", "auth-title", "Welcome back");
    const sub = el("p", "auth-sub", "Sign in to save and revisit your consultations.");

    const form = el("form", "auth-form");
    const emailIn = input("email", "you@business.com", "email");
    const passIn = input("password", "Password (min 8 characters)", "current-password");
    const err = el("div", "auth-err");
    err.setAttribute("aria-live", "polite");
    const submit = el("button", "auth-submit", "Sign in");
    submit.type = "submit";
    form.appendChild(field("Email", emailIn));
    form.appendChild(field("Password", passIn));
    form.appendChild(err);
    form.appendChild(submit);

    let mode_ = mode === "signup" ? "signup" : "login";
    const setMode = (m) => {
      mode_ = m;
      tabLogin.classList.toggle("active", m === "login");
      tabSignup.classList.toggle("active", m === "signup");
      title.textContent = m === "signup" ? "Create your account" : "Welcome back";
      sub.textContent = m === "signup"
        ? "One account to save every consultation Bara runs for you."
        : "Sign in to save and revisit your consultations.";
      submit.textContent = m === "signup" ? "Create account" : "Sign in";
      submit.disabled = false;
      passIn.setAttribute("autocomplete", m === "signup" ? "new-password" : "current-password");
      err.textContent = "";
    };
    tabLogin.addEventListener("click", () => setMode("login"));
    tabSignup.addEventListener("click", () => setMode("signup"));

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.textContent = "";
      const em = emailIn.value.trim();
      const pw = passIn.value;
      if (!em || !pw) { err.textContent = "Email and password are required."; return; }
      submit.disabled = true;
      submit.textContent = "…";
      try {
        const res = await fetch("/api/auth/" + mode_, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: em, password: pw }),
        });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || "Could not authenticate.");
        setSession(d.token, d.user.email);
        state.user = d.user;
        overlay.remove();
        render();
        loadConvos();
        if (window.KappaApp && window.KappaApp.onLogin) window.KappaApp.onLogin();
      } catch (e2) {
        err.textContent = e2.message;
        setMode(mode_);
      }
    });

    card.appendChild(close);
    card.appendChild(tabs);
    card.appendChild(title);
    card.appendChild(sub);
    card.appendChild(form);
    overlay.appendChild(card);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    document.addEventListener("keydown", function esc(ev) {
      if (ev.key === "Escape") { overlay.remove(); document.removeEventListener("keydown", esc); }
    });
    document.body.appendChild(overlay);
    setMode(mode_);
    emailIn.focus();
  }

  function signOut() {
    closeMenus();
    clearSession();
    state.user = null;
    convos = [];
    render();
    if (window.KappaApp && window.KappaApp.onLogout) window.KappaApp.onLogout();
  }

  // --- Boot: restore session, confirm with the server ---
  async function init() {
    if (token() && email()) state.user = { email: email() };
    render();
    try {
      const res = await fetch("/api/auth/me", { headers: headers() });
      const d = await res.json();
      state.enabled = d.enabled;
      state.user = d.user || null;
      if (!d.user) clearSession();
      else if (d.user.email) { try { localStorage.setItem(EKEY, d.user.email); } catch {} }
    } catch {}
    render();
    if (state.user) loadConvos();
  }

  window.KappaAuth = {
    init,
    headers,
    isLoggedIn: () => !!state.user,
    email: () => state.user && state.user.email,
    openModal,
    signOut,
    refreshConvos: loadConvos,
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
