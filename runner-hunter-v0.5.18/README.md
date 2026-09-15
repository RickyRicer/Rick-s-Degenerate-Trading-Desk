# Runner Hunter v0.5.18

## v0.5.18 — paper liquidity + eligibility grace

- Paper execution liquidity floor is now **$30,000** by default.
- Future/live `MIN_LIQUIDITY_USD` remains **$50,000** by default.
- A token that was already BUY + risk-approved gets a **5 minute paper eligibility window**.
- During that window, a fresh market check may use a **$25,000 hard liquidity floor** only when liquidity is the *only* newly failing risk.
- Portfolio state and fresh market state are rechecked before every paper buy.
- Security failures, concentration failures, volume/market-cap failures, existing-position checks, and portfolio lookup failures are never bypassed by the grace rule.

8 — RH Runtime Tradeability Coverage

## v0.5.17 — Resilient Blockscout evidence

- Retries transient Blockscout HTTP 429/5xx/network failures with short backoff.
- Reuses successful immutable contract/source/ABI evidence in-process if Blockscout later degrades.
- Cached fallback is explicitly annotated; it does not fabricate fresh dynamic safety data.
- Holder lookups also retry transient Blockscout failures, but holder concentration remains dynamic and is never replaced by the immutable contract cache.
- Security thresholds, Paper verifier, execution gates, and money-out deny list are unchanged.


## v0.5.17 patch

- Cove security parsing now searches both `get_token_security_report` and `get_token_info` for concrete buy/sell/tax/honeypot evidence instead of discarding security-relevant token-info fields.
- Adds an explicit GoPlus sellability evidence row from `cannot_sell_all` when present.
- Adds a conservative composite runtime-tradeability attestation: only when buyability PASS + sellability PASS + tax PASS/WARN are all concretely observed. This can de-criticalize a missing dedicated honeypot boolean without pretending the honeypot field itself was returned.
- For known launchpad infrastructure such as Pons V2, unverified source becomes a visible non-critical coverage gap only when runtime bytecode is present and the composite tradeability attestation passes. It does not become PASS.
- Adds direct Robinhood RPC bytecode selector hints for common mint/pause/admin functions and EIP-1167 minimal-proxy detection. Detected capabilities can warn/block; missing selectors never count as proof of safety.
- Existing holder limits, liquidity/volume rules, Cove Paper verification, position scoping, trade caps, and money-out hard denylist are unchanged.

# Runner Hunter v0.5.11 — Pons-Aware Security Normalization

## v0.5.11 patch

- Recognizes `PonsV2LaunchDeployer` as known Pons V2 launchpad infrastructure when Blockscout identifies it as a contract. Shared Pons launches no longer read like suspicious repeated-wallet deployment activity.
- Adds a non-bypassable infrastructure registry: known launchpad context improves labeling only; it cannot turn UNKNOWN/FAIL contract controls into PASS or bypass the hard risk gate.
- Reconciles GoPlus and Cove liquidity-lock evidence into one normalized evidence row. Conflicting lock reports are now shown explicitly as provider disagreement instead of simultaneous “0% locked” and “lock evidence” claims.
- Rewords `owner()` findings so the bot distinguishes “an owner address exists” from “dangerous admin powers were proven.” Unknown retained powers remain a warning.
- Leaves Cove paper verification, execution logic, position scoping, trade limits, and the money-out hard-deny list unchanged.
- Source/honeypot coverage remains fail-closed. Pons recognition alone does **not** authorize a paper trade.

# Runner Hunter v0.5.10 — Cove Position Scoping + Scan Resilience

## v0.5.10 patch

- Fixes Cove `get_positions` calls when its schema exposes both `accountId` and `accountIds`: Runner Hunter now sends exactly one, preferring the singular authoritative Paper `accountId`.
- Prevents broad schema-description matching from accidentally populating both account fields.
- `/scan` and `/analyze` continue market/security analysis if portfolio retrieval is unavailable, but Paper Buy is explicitly blocked until portfolio state is verified.
- Paper Buy re-checks positions immediately before execution and fails closed on any portfolio error.
- Paper-account verification and the money-out hard-deny list are unchanged.


## v0.5.9 paper-verification fix

Cove currently returns `profile.isPaper` inside the nested profile object while `accountIds` can live elsewhere in the same `get_profile` response. v0.5.8 incorrectly required those values to be siblings on one object, so diagnostics could show `isPaper: true` while the authoritative verifier still reported `no`.

v0.5.9 verifies the complete `get_profile` response: it requires an explicit `isPaper=true`, extracts account IDs across the response, cross-checks the same account ID across read and read-write credentials, then still requires `canTrade=true`, money-out disabled, and paper source on the write-side account. The fuzzy paper score remains diagnostic only and cannot authorize writes.


## v0.5.9 — Dual-credential Cove diagnostics

This release keeps all Cove writes fail-closed and compares `list_accounts` + `get_profile` through **both** `COVE_READ_TOKEN` and `COVE_WRITE_TOKEN`. It will only unlock `cove-paper` if Cove explicitly reports a paper/sandbox/simulated account. `isPaper: false` can no longer accidentally contribute to a positive paper score.

Run `/cove` and compare the `READ TOKEN` and `READ-WRITE TOKEN` sections. If both resolve to `isPaper: false`, Runner Hunter continues blocking writes while we wait for Cove's paper-account provisioning guidance.

# Runner Hunter v0.5.9 — Cove Paper Diagnostics + Crash Guard

Runner Hunter is a Telegram-controlled, cross-chain runner scanner with DEX Screener discovery, deterministic Runner Score, multi-source security, OpenAI finalist analysis, hard deterministic risk gates, and Cove MCP integration.

## v0.5.9 highlights

- Fixes the v0.5.5 failure where `/portfolio` or `/positions` could bubble a Cove account-identification error through grammY and stop the bot.
- Adds a global Telegram error handler as a final safety net. A bad update is logged and contained instead of terminating the process.
- `/portfolio` and `/positions` now fail gracefully and tell you to run `/cove` when paper-account detection is ambiguous.
- `/cove` now runs **sanitized paper-account diagnostics** in `BROKER_MODE=cove-paper` using `list_accounts` and `get_profile`.
- Diagnostics expose only useful account/profile metadata (type, mode, profile, account id, environment, etc.) and redact keys that look like tokens, secrets, authorization headers, API keys, passwords, or credentials.
- The paper-only execution gate is unchanged: Runner Hunter still refuses all Cove writes unless it can positively prove the target account/profile is paper/sandbox/demo/test.
- Money-out tools remain hard-denied in code: `request_payout`, `withdraw_usdc`, `withdraw_token`, `transfer_usdc`, `transfer_token`.
- No live-money broker mode and no autonomous execution.

## Why this release exists

Cove MCP connectivity and tool discovery are working, but v0.5.5 could not infer the paper account from Cove's actual `list_accounts` / `get_profile` response shape. v0.5.9 does **not** weaken that safety gate. Instead it shows the relevant sanitized metadata so the parser can be adapted to Cove's real schema without risking a live account.

## Setup

```bash
npm install
npm run typecheck
npm run dev
```

For Cove paper testing:

```env
BROKER_MODE=cove-paper
COVE_READ_TOKEN=your_paper_read_only_token
COVE_WRITE_TOKEN=your_paper_read_write_token
COVE_MCP_URL=https://production.cove.trade/api/mcp
COVE_MCP_DEBUG=false
MAX_TRADE_USD=25
MIN_LIQUIDITY_USD=50000
PAPER_MIN_LIQUIDITY_USD=30000
PAPER_LIQUIDITY_GRACE_FLOOR_USD=25000
PAPER_ELIGIBILITY_WINDOW_MINUTES=5
```

Keep Cove money-out disabled in Cove itself as a second independent guardrail.

## First validation

1. Start Runner Hunter.
2. Run `/cove`.
3. After the normal MCP/tool report, Runner Hunter will send a second message titled `Cove paper-account diagnostics`.
4. Send that **sanitized diagnostics message** back for parser tuning. Do not send `.env` or Bearer tokens.
5. Try `/portfolio` and `/positions`; if paper identification is still ambiguous, they should report the block without stopping the bot.
6. Confirm another command still works afterward (for example `/help`).

Set `COVE_MCP_DEBUG=true` only if more detail is required. Diagnostic logging is sanitized for credential-like keys, but `.env` remains the only place credentials should live.

## Still intentionally not implemented

- Autonomous trading
- Live-money broker mode
- Withdrawals/transfers/payouts
- Bundle/linked-wallet intelligence (planned for v0.6.0)


## v0.5.9 paper verification fix

Paper mode verification no longer relies on the fuzzy account-score heuristic. Cove's `get_profile` response is now treated as authoritative when `isPaper=true`. Runner Hunter requires both the read-only and read-write profiles to report `isPaper=true`, requires both credentials to resolve to the same account ID, requires the read-write account to report `canTrade=true`, and continues to require money-out to be disabled. The heuristic score remains diagnostic only and cannot unlock writes.


## v0.5.17 — Address-attested Pons recognition

- Removes name-only trust for `PonsV2LaunchDeployer`. Explorer labels are no longer sufficient to mark a token as known Pons infrastructure.
- Pons V2 recognition now requires the contract creator address to exactly match a published Pons V2 deployment address.
- Current attested addresses: Launch Deployer `0x3711ceA4feaDE896C913C68F01Eda97Cb06D1A42` and Factory `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`.
- A Pons label remains context only: it does not bypass honeypot/sellability/tax hard gates.
- This closes the false-trust class exposed by LLM: a friendly explorer label can no longer make an unrelated/copy contract look like verified Pons infrastructure.


## v0.5.17 — verified-contract sell-side graduation

Robinhood security can now graduate from `UNKNOWN` to `WARN` when a dedicated honeypot/sellability boolean is unavailable **only if** the contract has verified source, is non-proxy, runtime bytecode is present, buyability passes, explicit sell tax is known and below the hard threshold, holder concentration does not fail, and the verified ABI exposes no public mint, pause, blacklist, or fee/tax mutation controls.

This does not fabricate a honeypot PASS. The missing dedicated flags remain visible as coverage warnings. High or unknown sell tax still fails closed, and all existing hard security gates remain intact. Concrete Cove tax/honeypot/buy/sell fields now also populate the merged security report used by the AI and UI.


## v0.5.17 — Cove paper order schema fix
- resolves Cove's numeric `chainId` from `get_token_info` for non-EVM chains such as Solana instead of sending the DEX Screener string `solana`
- uses a Cove-valid 8–64 character idempotency key (`rh_buy_<uuidhex>` / `rh_sell_<uuidhex>`)
- never auto-populates optional `confirmHighImpact` or `surplusOfferId` fields from generic schema-description matching
- if Cove requires a numeric chain ID and its own metadata cannot provide one, execution fails closed rather than guessing

## v0.5.17 — Cove offer/continuation handling

- Preserves the full MCP tool result when Cove rejects a market order so Runner Hunter can inspect continuation metadata that may sit outside the normal structured content.
- Detects Cove-provided single-wallet continuation arguments and, only when they exactly target the verified Paper account/token/approved amount, resubmits those arguments without adding any provider override.
- Does **not** auto-confirm high-impact prompts. If Cove's continuation requires `confirmHighImpact` or `confirmImpactPromptIds`, the order stays blocked pending an explicit user-confirmation flow.
- If Cove references an offer but does not actually return continuation arguments in the MCP result, debug mode now emits a sanitized raw response so the remaining response shape can be wired exactly instead of guessed.
