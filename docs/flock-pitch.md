# Kappa Arbitrage — FLock Sovereign AI Challenge (Track 3: Governance, Transparency & Trust)

## Positioning (one sentence)
> "Kappa Arbitrage makes every AI recommendation reproducible and auditable: all quantitative
> claims are computed deterministically in code from cited public data — never by the model —
> routed through FLock's sovereign inference, and recorded in a tamper-evident hash-chained
> ledger a judge can verify live."

Every clause is checkable in the repo. (Say **"no fabricated figures,"** never "no hallucination.")

## Why this is a real Track-3 entry (not an API swap)
Everyone in this challenge uses the FLock API Platform for inference — that's table stakes. What
differentiates us is **governance depth on top of it**:

1. **The model writes, the code decides.** [src/data/derivations.js](../src/data/derivations.js):
   every metric carries its `inputs` + a `source` string; the LLM only interprets, never sources a
   number. This is the most defensible anti-fabrication claim in the room — we show the function,
   not an assertion.
2. **Tamper-evident accountability ledger.** One hash-chained row per analysis (input hash →
   public source IDs → `isFixture` flag → deterministic outputs → **FLock model id** → prediction →
   validation → `prev_hash`/`hash`). Maps to **EU AI Act Art. 12/19** automatic-logging obligations.
3. **Public, re-derivable data only** (Ofsted/ONS/IMD) — a third party can reproduce every number.
4. **Disclosed, not hidden, limitations** — sample data labelled on screen; backtest reported
   honestly (with a logged miss). Self-disclosure *is* a trust signal on a trust track.

## The 3-minute demo
1. **(0:00–0:30) The claim.** Positioning sentence + three pillars: *auditable · transparent · accountable.*
2. **(0:30–1:15) Show the spine, don't assert it.** Open `derivations.js`; point at a metric carrying
   its `inputs` + `source`: *"the model never sources a number."* Show the on-screen `SAMPLE DATA`
   label — disclose first.
3. **(1:15–2:15) Run one analysis end-to-end through FLock.** Real Croydon question → grounded report.
   Open `/governance.html`; point to the new ledger row naming the **FLock `qwen3-30b` model id** that
   produced it. (Sovereign run verified at ~35s.)
4. **(2:15–2:50) The money shot — live verify + tamper.** Click **Verify chain** → all green. Click
   **Simulate tamper** → one byte flips, the entry's row turns **red**, the chain reports the break at
   that entry. Tamper-evidence, demonstrated, not claimed.
5. **(2:50–3:00) Close on honesty.** *"Validation is a growing backtest, the ledger is tamper-evident
   not tamper-proof, the demo data is labelled sample — and every one of those is disclosed, in the
   chain, and checkable."* Tie to EU AI Act Art. 12/19.

> Demo prep: run **one** consultation before the tamper step so the ledger has a live entry to verify.

## Objection handling (pre-emptive)
- **"It's a Gemini app with FLock bolted on."** → Flip `SOVEREIGN_AI=1` and *every* stage runs on
  FLock `qwen3-30b`; the model id is written into every ledger row as per-analysis evidence. Verified
  end-to-end (~35s). README matches the repo.
- **"'No hallucination' is overclaiming."** → "No fabricated *figures* — every quantitative claim is
  code-computed and cited; prose is grounding-checked by [src/bara/judge.js](../src/bara/judge.js)."
- **"Your backtest isn't real."** → Agree: it's a directional-agreement check on labelled comparables,
  honestly reported (incl. a miss), that grows with engagements.
- **"Where's the federated learning?"** → Don't pretend. "FL is FLock's *training* stack — relevant to
  model-building tracks. Track-3 is governance/transparency/trust; our contribution is verifiable
  provenance + deterministic computation + auditable sovereign inference, squarely on-theme."
- **"What stops someone editing the ledger file?"** → "Tamper-*evident*, not tamper-*proof*. Roadmap:
  anchor the head hash to an external notary / signed timestamp / on-chain."
- **"The data's a fixture."** → Disclosed up front; labelled `SAMPLE` on screen.

## Do not oversell
No "no hallucination." No federated learning. No claimed immutability. No inflated track record.
Our edge is that a judge can **check every claim live** — protect it by claiming only what the repo proves.
