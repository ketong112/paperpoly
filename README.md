# PaperPoly — Polymarket paper trading on Even Realities G2

Paper trading for Polymarket, on smart glasses. Settle a "will the Fed cut?"
argument hands-free: glance at one market, speak a paper bet, confirm with one
tap. Zero real money, zero keys, zero login.

Track: Crypto & DeFi (Even Realities Hackathon, DoraHacks). Built 23–29 Nov 2026.

## What existed before 23 Nov 2026

- The official Even Hub minimal template (`even-realities/evenhub-templates`):
  `app.json`, `index.html`, `src/main.ts` (tap counter + double-tap exit),
  `vite.config.ts`, `tsconfig.json`. Everything else in this repo was written
  during the hackathon build week (23–29 Nov 2026).
- No code, markets, or ledger existed before 23 Nov. The paper ledger starts
  empty; all prices come live from Polymarket's public Gamma + CLOB APIs.

## What was written on Day 2 (23 Nov 2026)

- `src/main.ts` — rewritten from scratch (the template's tap counter is gone):
  market screen, tap-to-cycle top-5, long-press voice capture, confirm screen
  with 10 s auto-cancel, tap-only fallback (default YES $10 when voice fails),
  double-tap exit via `shutDownPageContainer(1)`.
- `src/parse.ts` — new: voice-command parser ("Yes, ten dollars" → YES 10).
  Unit-tested 15/15 (see `paperpoly-server` notes in `../NOTES.md`).
- `app.json` — `min_app_version` removed (the CLI derives the 2.2.10 floor for
  SDK 0.0.16 at pack time); `network` permission added with whitelist
  `["https://paperpoly.go.altare.global"]` (live backend, deployed 23 Nov).
- Backend lives in https://github.com/ketong112/paperpoly-server (own Node
  server, zero deps): polls Gamma + CLOB, holds the paper ledger, runs local
  Whisper for `/stt`. Live at https://paperpoly.go.altare.global.
- Verified 23 Nov in the simulator: market render, tap cycle, long-press →
  listening → fallback confirm → tap places the bet (portfolio: YES 10 @
  46.5¢, balance $990), 10 s auto-cancel, double-tap exit. Full evidence in
  `../evidence/day2/` and `../NOTES.md` (Day-2 status-log entry).

## How it works

- Read: one market question + Yes/No prices in cents + probability bar +
  24h volume. Tap cycles the top 5 markets by volume.
- Write: long-press, speak ("Yes, ten dollars"), a huge-type confirm screen
  ("BUY YES 10 @ 46c? WIN $21.74"), one ring tap places the paper bet.
  10-second auto-cancel. Tap-only fallback if voice fails.
- Voice: the G2 mic gives raw PCM (16 kHz s16le mono). Our own server runs
  local Whisper (whisper.cpp, tiny.en) — no audio leaves our server, no
  third-party STT key.
- Backend: our own Node server polls Polymarket Gamma/CLOB, holds the paper
  ledger, and serves the app. No API keys ship in the app.

## Run it

```bash
npm install
npm run dev        # Vite on :5173
npm run simulate   # Even Hub simulator
```

Packaging: `npm run pack` produces `paperpoly.ehpk`.

## Safety

Paper trading only. No real-money orders, no wallet, no private keys.
Demo data is live public market data; positions are play money.
