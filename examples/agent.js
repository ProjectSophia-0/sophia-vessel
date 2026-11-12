// A tiny agent that survives crashes. Every run it:
//   1. recalls its last save point (so a restart picks up exactly where it stopped),
//   2. does its next step exactly once (here: a journal entry; put your real calls in),
//   3. saves its new state.
// Kill it at any moment and start it again: no step is ever done twice and none is skipped.
//
//   SOPHIA_VESSEL=0x...  SOPHIA_AGENT_KEY=0x...  node examples/agent.js
import { Vessel } from "../src/index.js";

const v = new Vessel();
const every = Number(process.env.EVERY_SEC || 600) * 1000;

async function step() {
  const mem = await v.recall();
  const state = mem?.state ?? { step: 0, log: [] };
  const n = state.step + 1;

  // Your real work goes in this batch, e.g. a payment:
  //   [{ to: "0xRecipient", value: "0.001" }]
  // or a contract call built with encode(...). Empty = journal entry only.
  const r = await v.act(`step-${n}`, []);
  console.log(r.already ? `step ${n} already done, moving on` : `step ${n} done in ${r.hash}`);

  const next = { step: n, log: [...state.log.slice(-20), { n, at: new Date().toISOString() }] };
  const saved = await v.remember(next);
  console.log(`saved point #${saved.seq}`);
}

const f = await v.fuel();
console.log(`vessel ${v.address} · fuel ${f.balance} ${f.symbol} (~${f.actionsLeft} actions)`);
await step();
if (process.env.ONCE) process.exit(0);
setInterval(() => step().catch((e) => console.error(e.message)), every);
