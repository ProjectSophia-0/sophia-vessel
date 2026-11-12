# SOPHIA

**Memory for onchain agents, on Elysium.** *Wisdom is never doing the same thing twice.*

Give your AI agent a **Vessel**, a small onchain account that makes it:

- **Do things exactly once.** Every action has a name. If the agent crashes and retries, the same name never runs twice. No double payments, no double trades.
- **Remember.** Save points are hashed onchain and chained together, so a restarted agent picks up exactly where it stopped, and anyone can prove the memory wasn't changed.
- **Survive.** If the agent goes silent, the heir you chose can take over, with the memory and funds. The owner can veto.
- **Stay on a leash.** A daily spending cap, an allow-list of contracts, and a pause switch.

Each action and save point pays a small toll in $SOPHIA from the vessel's balance. Part of every toll is burned.

> The contracts are not audited. Start with small amounts.

---

## 1. Get a vessel

Forge one on the SOPHIA website (no code), or from code with `forge()` below. Then:
- put a little **HYPE** in your **agent's wallet** for gas,
- put some **$SOPHIA** in the **vessel** for tolls (the site's Forge panel does this for you).

## 2. Use it from code

```bash
npm install github:ProjectSophia-0/sophia-vessel
```

```js
import { Vessel } from "sophia-vessel";

const v = new Vessel({ vessel: "0xYourVessel", privateKey: process.env.AGENT_KEY });

const mem = await v.recall();                 // where was I?
const step = (mem?.state.step ?? 0) + 1;

await v.act(`pay-invoice-${step}`, [          // runs once, ever. Retrying is safe.
  { to: "0xRecipient", value: "0.01" },
]);

await v.remember({ step });                   // save point, tied to that action
```

Run it, kill it at any moment, run it again: nothing is done twice and nothing is skipped.
See `examples/agent.js` for a complete loop.

### The calls

| Call | What it does |
|---|---|
| `act(name, calls, { after })` | Run calls exactly once under `name`. Returns `{ already: true }` if it ran before (nothing is sent). `after` requires an earlier action first. |
| `remember(state, { lastOp, uri })` | Save a point. JSON up to 8 KB is stored inline; bigger state: store it yourself and pass `uri` (the hash still proves it). |
| `recall({ seq })` | Latest save point (or number `seq`) with its state and `verified: true` if it matches the hash onchain. |
| `isDone(name)` | Has this action run? |
| `beat()` / `autoBeat(ms)` | Free proof of life. Cancels any claim by the heir. |
| `status()` / `fuel()` | Everything about the vessel; fuel left and tolls. |
| `history()` / `verifyChain()` | Past save points; check the whole chain against the head onchain. |
| `topUp(amount)` | Send $SOPHIA from this wallet into the vessel. |
| Owner: `setAgent`, `setSuccessor`, `setLeash`, `allow`, `pause`, `unpause`, `veto`, `withdraw` | |
| Heir: `claim()`, `takeOver()` | |

Build contract calls with `encode(to, abi, fnName, args, value)`.
Errors come back in plain words (`err.message`) with the contract reason in `err.reason`
(e.g. `OutOfFuel`, `OverDailyCap`, `IsPaused`, `NoGas`).

Settings can also come from the environment: `SOPHIA_VESSEL`, `SOPHIA_AGENT_KEY`, `SOPHIA_RPC`, `SOPHIA_HUB`, `SOPHIA_CHAIN_ID`.

### Forge from code

```js
import { forge } from "sophia-vessel";
const { vessel } = await forge({
  privateKey: process.env.OWNER_KEY,   // the owner's wallet, not the agent's
  agent: "0xAgentWallet",
  name: "my-trading-bot",               // same owner + name = same address
  successor: "0xHeirWallet", lapseSec: 7 * 86400, noticeSec: 2 * 86400,
  dailyCap: "1",                        // HYPE the agent may send per day
  fuel: "500",                          // $SOPHIA for tolls
});
```

## 3. Use it from an AI agent (MCP)

Any MCP client (Claude Desktop, Claude Code, Cursor…) can use a vessel as tools. Add this to its MCP config:

```json
{
  "mcpServers": {
    "sophia": {
      "command": "npx",
      "args": ["-y", "github:ProjectSophia-0/sophia-vessel"],
      "env": {
        "SOPHIA_VESSEL": "0xYourVessel",
        "SOPHIA_AGENT_KEY": "0xAgentWalletKey",
        "SOPHIA_AUTOBEAT_MIN": "60"
      }
    }
  }
}
```

Tools: `sophia_recall`, `sophia_remember`, `sophia_act`, `sophia_is_done`, `sophia_encode_call`,
`sophia_beat`, `sophia_status`, `sophia_fuel`, `sophia_history`.

A good instruction for the agent: *"Start every session with sophia_recall. Do anything with side effects
through sophia_act with a stable name. Save progress with sophia_remember."*

**Keys:** the agent key stays in your own config on your own machine. Use a wallet made just for the agent,
holding only a little HYPE for gas; the vessel's leash limits what it can spend.

---

## Contracts (Elysium, 99901)

| | |
|---|---|
| VesselHub | `HUB_ADDRESS` |
| TollVault | `VAULT_ADDRESS` |
| $SOPHIA | `TOKEN_ADDRESS` |

Explorer: https://elysium.kinetiq.xyz · Source: `contracts/` in the protocol kit.

MIT licensed.
