# Runner Hunter v0.5.3

Cross-chain Telegram runner hunter. **Mock/paper execution remains the default.**

## v0.5.3 — Cove MCP lifecycle fix

- Uses the production Cove MCP endpoint by default: `https://production.cove.trade/api/mcp`.
- Completes the MCP 2025-06-18 lifecycle: `initialize` → negotiated protocol capture → `notifications/initialized` → `tools/list`.
- Sends `MCP-Protocol-Version` on every post-initialize HTTP request.
- Keeps `Mcp-Session-Id` when Cove issues one.
- Parses all JSON-RPC messages from Streamable HTTP / SSE and matches responses by request ID instead of assuming the final `data:` line is the answer.
- `/cove` now shows server info, negotiated protocol, session state, and the complete exposed tool list (up to 40 names).
- An unexpected `tools/list` response shape now throws a diagnostic error instead of silently reporting zero tools.


## v0.5.2 — Cove MCP read integration

This build begins the Cove integration without turning on autonomous execution. Runner Hunter can now establish an MCP session with Cove using the local `COVE_READ_TOKEN`, discover the tools Cove exposes to your account, and use Cove's token-security report as an additional independent security sensor when that tool is available.

GoPlus is still supported, but it is not the authority. Robinhood security can now combine:
- direct Robinhood RPC
- Blockscout contract / ABI / deployer data
- Blockscout holder concentration
- GoPlus
- Cove MCP security evidence

Concrete Cove results can fill otherwise-unknown honeypot, buyability, sellability, and tax controls. A missing Cove field remains UNKNOWN; nothing is guessed.

### New `/cove` command

Use `/cove` in Telegram to test the MCP handshake and list the relevant tools exposed to your account. The command never prints your token.

### Safety boundary

`BROKER_MODE=mock` remains recommended. v0.5.2 does **not** enable automatic Cove writes. `COVE_WRITE_TOKEN` can remain blank. We will validate read access and security/tool schemas first, then wire Cove paper execution in a later build with explicit limits and idempotency.

### Git hygiene

A `.gitignore` is now included. `.env`, `security-debug/`, `node_modules/`, editor state, logs, and build artifacts are excluded. `.env.example` stays tracked.

## Setup

Copy your existing `.env` and add your Cove read credential locally:

```env
COVE_READ_TOKEN=your_local_read_token
COVE_MCP_URL=https://production.cove.trade/api/mcp
BROKER_MODE=mock
```

Do not paste Cove/OpenAI/Telegram/Blockscout credentials into Telegram, GitHub, or chat.

Then:

```bash
npm install
npm run typecheck
npm run dev
```

Telegram test order:

```text
/cove
/scan rh
```

Useful terminal lines include `[Cove]`, `[RPC]`, `[Blockscout]`, `[Holders]`, and `[Security]`.
