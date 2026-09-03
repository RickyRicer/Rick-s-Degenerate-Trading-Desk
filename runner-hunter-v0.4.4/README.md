# Runner Hunter v0.4.4

Cross-chain Telegram runner hunter. Mock/paper trading only.

## What changed

### Blockscout PRO API for Robinhood Chain

Robinhood source verification now uses Blockscout's unified PRO API gateway for chain ID `4663`:

```text
https://api.blockscout.com/4663/api/v2/...
```

Set your local key in `.env`:

```env
BLOCKSCOUT_API_KEY=proapi_your_key_here
```

The key is sent as a Bearer token and is never printed in normal logs. On Windows, the Blockscout client also falls back to the system `curl.exe` if Node `fetch()` fails.

GoPlus remains the primary token-risk provider. A verified Blockscout source resolves only the source-verification gap; missing honeypot, tax, sellability, holder, or bundle coverage still leaves security `UNKNOWN` and blocks paper trading.

### Compact `/scan` cards

`/scan` now returns fast-glance cards with the key market, flow, security, AI, and hard-risk information only. Each card includes a `🔍 Deep Dive` button that opens the full report using the analysis already generated during the scan, so pressing it does not spend another OpenAI request.

`/analyze` continues to return the full deep-dive report directly.

### Dev watch mode

Use:

```bash
npm run dev
```

`tsx watch` now restarts Runner Hunter automatically whenever source files change.

### Automatic version banner

The runtime banner, `/start`, leaderboard header, and request user-agent read the version from `package.json`. Future releases only need the package version changed in one place.

## Pipeline

DEX Screener → Runner Score → GoPlus + Blockscout → AI finalists → hard risk gate → mock paper trade

## Commands

- `/scan`
- `/scan sol`
- `/scan rh`
- `/scan bsc`
- `/scan evm`
- `/analyze <address>`
- `/analyze <chain> <address>`
- `/portfolio`
- `/positions`

## Setup

Copy your existing `.env` into this folder and add your Blockscout key, then:

```bash
npm install
npm run typecheck
npm run dev
```

For the first Robinhood test, keep:

```env
SECURITY_DEBUG_LOG=true
```

Then run `/scan rh` and check the terminal for `[GoPlus]`, `[Blockscout]`, and merged `[Security]` lines.

True linked-wallet / launch-bundle analysis remains `UNKNOWN` until the dedicated bundle module is connected.


## v0.4.4
- Contract addresses are inline Telegram code, so tapping the CA copies it; the separate Copy CA button is removed.
- Robinhood security stays PARTIAL/UNKNOWN when GoPlus omits core honeypot, sellability, or tax fields, even if Blockscout verifies source.
- Blockscout now enriches the creator/deployer address and the scanner flags repeated deployers among current finalists.
- Deep Dive shows deployer address, known Blockscout name/type, repeated scan deployments, and creation transaction when available.
