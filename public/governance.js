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
    const signed = (d.integrity && d.integrity.signed) || 0;
    const seed = (d.backtest && d.backtest.seed_demo) || {};
    const live = (d.backtest && d.backtest.live) || {};
    const sign = d.signing || {};

    // --- summary cards ---
    summary.innerHTML = [
      card(
        intact ? "✓ Verified" : "✗ Broken",
        "Hash-chain integrity",
        `${d.analyses} ${d.analyses === 1 ? "analysis" : "analyses"} · ${signed} signed`,
        intact ? "ok" : "bad"
      ),
      card(
        sign.signer ? short(sign.signer).replace("…", "") : "—",
        "Signing key (Ed25519)",
        sign.ephemeral ? "ephemeral — set LEDGER_SIGNING_KEY" : "persistent · publicly verifiable",
        sign.ephemeral ? "dim" : "ok"
      ),
      card(
        live.accuracy_pct == null ? "pending" : live.accuracy_pct + "%",
        "Live accuracy (out-of-sample)",
        `${live.validated || 0} resolved predictions`,
        "accent"
      ),
      card(
        d.sovereign.active ? "Sovereign" : esc(d.sovereign.provider),
        "Inference model",
        esc(d.sovereign.model || d.sovereign.provider),
        d.sovereign.active ? "ok" : "dim"
      ),
    ].join("");

    // --- trust panel: what it proves / doesn't, + anchor status ---
    const anchor = d.anchor;
    const anchorLine = anchor
      ? `Head anchored ${esc((anchor.created_at || "").slice(0, 16))} — receipt ${anchor.verified ? "✓ valid" : "✗ invalid"}` +
        (anchor.external_proof ? ` · <a href="${esc(anchor.external_proof)}" target="_blank" rel="noopener">external proof ↗</a>` : " (portable receipt — publish externally)")
      : "Not yet anchored externally — anchor the head so outsiders can witness it.";
    backtest.innerHTML = `
      <section class="gov-trust">
        <h2>What this proves</h2>
        <ul class="gov-proves">${(d.what_this_proves || []).map((x) => `<li class="ok">${esc(x)}</li>`).join("")}</ul>
        <ul class="gov-proves">${(d.what_this_does_not_prove || []).map((x) => `<li class="dim">${esc(x)}</li>`).join("")}</ul>
        <div class="gov-anchor">🔗 ${anchorLine}</div>
      </section>

      <h2>Backtest library — illustrative</h2>
      <p class="gov-sub gov-warn">${esc(seed.disclaimer || "")}</p>
      <p class="gov-sub">${esc(seed.note || "")}</p>
      <table class="gov-table">
        <thead><tr><th>Area</th><th>Opened</th><th>Model signal</th><th>Actual outcome</th><th>Match</th></tr></thead>
        <tbody>${
          (seed.cases || [])
            .map(
              (c) => `<tr>
                <td>${esc(c.area)}</td>
                <td>${esc(c.opened)}</td>
                <td>${esc(c.model_signal)} (${esc(c.model_gap_pct)}%)</td>
                <td>${Math.round((c.actual_occupancy_12m || 0) * 100)}% · ${esc(c.actual_ofsted)}</td>
                <td class="${c.agreement === "agrees" ? "ag-ok" : "ag-bad"}">${esc(c.agreement)}</td>
              </tr>`
            )
            .join("") || "<tr><td colspan=5>No cases.</td></tr>"
        }</tbody>
      </table>
      <p class="gov-sub">${esc((seed.accuracy_pct != null ? seed.accuracy_pct + "% on illustrative cases. " : "") + (live.note || ""))}</p>`;

    // --- live audit records ---
    if (!d.records.length) {
      records.innerHTML =
        "<h2>Live audit trail</h2><p class='gov-sub'>No analyses recorded yet — run a consultation and the entry appears here, hash-chained and signed.</p>";
    } else {
      const items = d.records
        .map((rec, i) => {
          const p = rec.payload || {};
          const g = p.grounding;
          const sov = p.model && p.model.sovereign;
          return `<div class="gov-rec" id="rec-${i}">
            <div class="gov-rec-top">
              <span class="gov-hash">#${i + 1} · ${short(rec.hash)}</span>
              ${rec.signature ? '<span class="gov-badge sig">✓ signed</span>' : ""}
              ${sov ? '<span class="gov-badge">FLock sovereign</span>' : ""}
              ${g ? `<span class="gov-badge ${g.grounded ? "sig" : "warn"}">${g.grounded ? "✓ grounded" : "⚠ ungrounded"}</span>` : ""}
            </div>
            <p class="gov-q">${esc(p.question)}</p>
            <div class="gov-meta">
              <span>Model: ${esc(p.model ? p.model.id : "?")}</span>
              <span>Prediction: ${esc(p.prediction ? p.prediction.top_recommendation : "?")}</span>
              ${g ? `<span>Figures checked: ${esc(g.numbers_checked)}</span>` : ""}
              ${p.validation && p.validation.agreement ? `<span>Validation: ${esc(p.validation.agreement)}</span>` : ""}
            </div>
            ${p.model && p.model.output_sha256 ? `<div class="gov-chain">output sha256 ${short(p.model.output_sha256)}</div>` : ""}
            <div class="gov-sources">Sources: ${esc((p.data_sources || []).join("; ") || p.data_provenance || "—")}</div>
            <div class="gov-chain">prev ${short(rec.prev_hash)} → ${short(rec.hash)}</div>
          </div>`;
        })
        .join("");
      records.innerHTML = `<h2>Live audit trail (hash-chained · signed)</h2>${items}`;
    }
  } catch (e) {
    summary.innerHTML = `<div class="gov-err">${esc(e.message)}</div>`;
  } finally {
    // Verify/tamper/anchor controls always render, even if the ledger fetch failed.
    summary.insertAdjacentHTML(
      "beforeend",
      `<div class="gov-verify">
        <button id="btn-verify">Verify chain</button>
        <button id="btn-tamper" class="ghost">Simulate tamper</button>
        <button id="btn-anchor" class="ghost">Anchor head externally</button>
        <span id="verify-result" class="verify-result" aria-live="polite"></span>
      </div>`
    );
    document.getElementById("btn-verify").addEventListener("click", () => runVerify(false));
    document.getElementById("btn-tamper").addEventListener("click", () => runVerify(true));
    document.getElementById("btn-anchor").addEventListener("click", runAnchor);
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
      el.textContent = `✗ Tamper detected — ${esc(d.reason || "hash")} mismatch at entry #${idx + 1}`;
      el.className = "verify-result bad";
      const row = document.getElementById("rec-" + idx);
      if (row) row.classList.add("broken");
    }
  } catch (e) {
    el.textContent = e.message;
    el.className = "verify-result bad";
  }
}

async function runAnchor() {
  const el = document.getElementById("verify-result");
  el.textContent = "Anchoring…";
  el.className = "verify-result";
  try {
    const r = await fetch("/api/ledger/anchor", { method: "POST" });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Anchor failed.");
    const a = d.anchor || {};
    el.innerHTML =
      `✓ Head anchored — receipt ${d.verified ? "valid" : "invalid"}, head ${short(a.head)}` +
      (a.external_proof ? ` · <a href="${esc(a.external_proof)}" target="_blank" rel="noopener">external proof ↗</a>` : " (portable receipt — publish externally)");
    el.className = "verify-result ok";
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
