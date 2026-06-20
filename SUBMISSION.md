# Kappa Arbitrage — Verifiable, Accountable AI for High-Stakes UK SMB Decisions

**FLock UK Sovereign AI · Track 3 — AI Governance, Transparency & Trust**

---

## One line
A data-backed consulting platform for UK small businesses where **every figure is computed in code (never hallucinated), every analysis is cryptographically signed, and anyone can independently verify the whole audit trail on their own machine — without trusting our server.**

## The problem
UK SMBs face expensive, high-stakes decisions — *where to open, will it fill* — but a feasibility study costs £5–10k. AI could do it for a fraction of that, except SMBs (rightly) don't trust AI advice: it hallucinates numbers, and "trust me" dashboards are self-attested. Track 3 asks how AI can become **transparent, auditable, and accountable.** That's exactly the gap we close.

## What it does
Two agents run the engagement:
- **Kappy** holds a structured intake conversation and produces a typed brief. A data-aware gate (LA-name → ward index → model inference, constrained to the real covered list) means she never hands off a location the engine can't analyse.
- **Bara** analyses **real UK government data** — Ofsted's childcare register, ONS Census 2021 population, IMD 2019 deprivation — across **74 local authorities** (24,636 providers; group-based nurseries 99.9% geocoded). Crucially, **all headline numbers are computed deterministically in code** (supply-demand gap, childcare-desert index, deprivation-adjusted demand, competitive quality). The LLM only *narrates pre-computed, source-tagged numbers* — it structurally cannot invent the figures.

## Track 3 fit — three working governance artifacts (not slides)

1. **AI audit tool — a signed, hash-chained ledger + a *standalone offline verifier*.**
   Every analysis is recorded as an **Ed25519-signed, SHA-256 hash-chained** audit record (the question, the data sources, the model + a hash of its output, the prediction, and a code-checked grounding result). The headline: **`scripts/verify-ledger.js`** — a dependency-free verifier *anyone* runs on *their own machine* to re-check the chain, the signatures, and **re-derive the grounding offline** (proving every figure traces to data), all from a brief-**redacted** proof bundle that exposes **no private client data.** This is the "don't trust — verify" principle, runnable live.

2. **AI risk-monitoring system.**
   `/api/risk-monitor` computes, over the signed ledger: **caught hallucinations** (wards the verifier rejected), grounding-failure rate, low-confidence/low-coverage counts, and sovereign-inference share — with threshold alerts, gated behind a minimum sample size. Every figure is independently re-derivable.

3. **External notarisation — OpenTimestamps (Bitcoin).**
   The chain head is stamped to Bitcoin via OpenTimestamps (free, no wallet). This is the one place blockchain is genuinely warranted: a **neutral external notary for the audit-chain head** — explicitly *not* the app, *not* the data — turning tamper-*evident* into tamper-*resistant* (no one, including us, can backdate or rewrite history).

## Where FLock comes in
The platform is model-agnostic; in **sovereign mode** (`SOVEREIGN_AI=1`) all inference routes through **FLock's UK-sovereign-aligned model (qwen3-30b)**, and each audit record **binds the provider + a SHA-256 of the model's output**, so the signed record proves a FLock-served model produced that exact analysis. FLock is the sovereign inference engine; our governance layer makes its every output grounded, signed, and independently auditable.

## What we claim — and what we don't (honesty is the point of a Trust track)
- We **do not** claim the public input data is "sovereign" — it's open; anyone has it.
- We **do not** claim the app itself is decentralised — it's a centralised service whose *outputs* are independently verifiable.
- We **do** claim: numbers are computed not hallucinated; the audit trail is signed, tamper-evident, externally notarised, and verifiable by a third party without trusting us.

## Roadmap — the deep FLock fit
Our true alignment with FLock's core (**federated learning, "bring the model to the data"**) is a **Federated SMB Intelligence Network** on the **FL Alliance**: each nursery is a node, its **private** operating data (occupancy, outcomes) **never leaves its premises**, and a shared *"will a nursery here fill?"* model is federated-trained across hundreds of them — FLock's Sarawak sovereign-AI playbook applied to UK SMBs, and a moat no competitor can assemble.

## Verify it yourself (no trust required)
```bash
curl https://<deployed-url>/api/ledger > ledger.json
curl https://<deployed-url>/api/ledger/pubkey         # the public key
node scripts/verify-ledger.js ledger.json <publicKeyBase64> --anchor anchor.json
# ✓ chain intact · signatures valid · grounding re-derived offline · anchor matches
```

## Stack
Node/Express · Supabase (Postgres) · vanilla JS frontend · model-agnostic adapter (FLock / Gemini / OpenAI-compatible) · Ed25519 + SHA-256 (Node crypto) · OpenTimestamps · all UK-gov data connectors keyless.
