// Renders the AI Accountability Ledger from /api/ledger.
const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
const short = (h) => (h ? esc(h).slice(0, 12) + "…" : "—");

(async () => {
  const summary = document.getElementById("gov-summary");
  const backtest = document.getElementById("gov-backtest");
  const records = document.getElementById("gov-records");

  try {
    const r = await fetch("/api/ledger");
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Failed to load ledger.");

    const intact = d.integrity && d.integrity.intact;
    const acc = d.backtest.directional_accuracy_pct;

    // --- summary cards ---
    summary.innerHTML = [
      card(
        intact ? "✓ Verified" : "✗ Broken",
        "Hash-chain integrity",
        `${d.analyses} live ${d.analyses === 1 ? "analysis" : "analyses"} recorded`,
        intact ? "ok" : "bad"
      ),
      card(
        acc == null ? "—" : acc + "%",
        "Directional accuracy",
        `${d.backtest.agreements}/${d.backtest.validated} backtested openings`,
        "accent"
      ),
      card(
        d.sovereign.active ? "Sovereign" : d.sovereign.provider,
        "Inference model",
        esc(d.sovereign.model || d.sovereign.provider),
        d.sovereign.active ? "ok" : "dim"
      ),
    ].join("");

    // --- live verify + tamper demo (the money shot) ---
    summary.insertAdjacentHTML(
      "beforeend",
      `<div class="gov-verify">
        <button id="btn-verify">Verify chain</button>
        <button id="btn-tamper" class="ghost">Simulate tamper</button>
        <span id="verify-result" class="verify-result"></span>
      </div>`
    );
    document.getElementById("btn-verify").addEventListener("click", () => runVerify(false));
    document.getElementById("btn-tamper").addEventListener("click", () => runVerify(true));

    // --- backtest library ---
    const rows = (d.backtest.cases || [])
      .map(
        (c) => `<tr>
          <td>${esc(c.area)}</td>
          <td>${esc(c.opened)}</td>
          <td>${esc(c.model_signal)} (${esc(c.model_gap_pct)}%)</td>
          <td>${Math.round((c.actual_occupancy_12m || 0) * 100)}% · ${esc(c.actual_ofsted)}</td>
          <td class="${c.agreement === "agrees" ? "ag-ok" : "ag-bad"}">${esc(c.agreement)}</td>
        </tr>`
      )
      .join("");
    backtest.innerHTML = `
      <h2>Backtest library — predicted vs. actual</h2>
      <p class="gov-sub">${esc(d.backtest.note || "")}</p>
      <table class="gov-table">
        <thead><tr><th>Area</th><th>Opened</th><th>Model signal</th><th>Actual outcome</th><th>Match</th></tr></thead>
        <tbody>${rows || "<tr><td colspan=5>No cases.</td></tr>"}</tbody>
      </table>`;

    // --- live audit records ---
    if (!d.records.length) {
      records.innerHTML =
        "<h2>Live audit trail</h2><p class='gov-sub'>No analyses recorded yet — run a consultation and the entry appears here, hash-chained.</p>";
    } else {
      const items = d.records
        .map((rec, i) => {
          const p = rec.payload || {};
          return `<div class="gov-rec" id="rec-${i}">
            <div class="gov-rec-top">
              <span class="gov-hash">#${i + 1} · ${short(rec.hash)}</span>
              ${p.model && p.model.sovereign ? '<span class="gov-badge">FLock sovereign</span>' : ""}
            </div>
            <p class="gov-q">${esc(p.question)}</p>
            <div class="gov-meta">
              <span>Model: ${esc(p.model ? p.model.id : "?")}</span>
              <span>Prediction: ${esc(p.prediction ? p.prediction.top_recommendation : "?")}</span>
              ${p.validation && p.validation.agreement ? `<span>Validation: ${esc(p.validation.agreement)}</span>` : ""}
            </div>
            <div class="gov-sources">Sources: ${esc((p.data_sources || []).join("; ") || p.data_provenance || "—")}</div>
            <div class="gov-chain">prev ${short(rec.prev_hash)} → ${short(rec.hash)}</div>
          </div>`;
        })
        .join("");
      records.innerHTML = `<h2>Live audit trail (hash-chained)</h2>${items}`;
    }
  } catch (e) {
    summary.innerHTML = `<div class="gov-err">${esc(e.message)}</div>`;
  }
})();

async function runVerify(tamper) {
  const el = document.getElementById("verify-result");
  document.querySelectorAll(".gov-rec.broken").forEach((n) => n.classList.remove("broken"));
  el.textContent = "Verifying…";
  el.className = "verify-result";
  try {
    const r = await fetch("/api/ledger/verify" + (tamper ? "?tamper=1" : ""));
    const d = await r.json();
    if (d.intact) {
      el.textContent = `✓ Chain intact — ${d.count} ${d.count === 1 ? "entry" : "entries"}, head ${short(d.head)}`;
      el.className = "verify-result ok";
    } else {
      const idx = d.tampered_index == null ? 0 : d.tampered_index;
      el.textContent = `✗ Tamper detected — hash mismatch at entry #${idx + 1}`;
      el.className = "verify-result bad";
      const row = document.getElementById("rec-" + idx);
      if (row) row.classList.add("broken");
    }
  } catch (e) {
    el.textContent = e.message;
    el.className = "verify-result bad";
  }
}

function card(big, label, sub, tone) {
  return `<div class="gov-card tone-${tone}">
    <div class="gov-big">${esc(big)}</div>
    <div class="gov-label">${esc(label)}</div>
    <div class="gov-cardsub">${sub}</div>
  </div>`;
}
