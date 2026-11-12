#!/usr/bin/env node
// SOPHIA MCP server: gives an AI agent (Claude, Cursor, any MCP client) its own vessel as tools.
// Env: SOPHIA_VESSEL (vessel address), SOPHIA_AGENT_KEY (the agent wallet's key, set only on your machine),
// optional SOPHIA_RPC, SOPHIA_CHAIN_ID (99901 Elysium by default), SOPHIA_AUTOBEAT_MIN.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Vessel, encode, explain } from "../src/index.js";

const json = (v) => ({ content: [{ type: "text", text: JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: e?.name === "SophiaError" ? e.message : explain(e).message }] });
const wrap = (fn) => async (a) => { try { return json(await fn(a ?? {})); } catch (e) { return fail(e); } };

let v;
try { v = new Vessel(); }
catch (e) { console.error("[sophia-mcp] " + e.message); process.exit(1); }

const server = new McpServer({ name: "sophia", version: "0.1.0" });
const callShape = z.object({ to: z.string().describe("contract or wallet address"), value: z.string().optional().describe("native coin to send, in whole coins, e.g. \"0.01\""), data: z.string().optional().describe("0x calldata; use sophia_encode_call to build it") });

server.registerTool("sophia_status", {
  description: "Read your vessel: owner, agent, heir, pause state, daily spending left, how many actions and save points, fuel left, and how long since the last sign of life.",
  inputSchema: {},
}, wrap(() => v.status()));

server.registerTool("sophia_recall", {
  description: "Bring back your latest saved memory (or save point number `seq`). Call this first when you start, to pick up where you left off. `verified` is true when the state matches the hash stored onchain.",
  inputSchema: { seq: z.number().int().positive().optional() },
}, wrap(({ seq }) => v.recall({ seq })));

server.registerTool("sophia_remember", {
  description: "Save your current state as a new onchain save point (JSON, up to 8 KB inline). It's tied to the last action you finished, hash-chained to every earlier save, and costs a small toll.",
  inputSchema: { state: z.any().describe("any JSON: notes, progress, open tasks"), lastOp: z.string().optional().describe("name or id of the last finished action; defaults to the last one this session") },
}, wrap(({ state, lastOp }) => v.remember(state, { lastOp })));

server.registerTool("sophia_act", {
  description: "Run one or more calls exactly once under a name you choose (e.g. \"pay-invoice-42\"). If that name already ran, nothing is sent and you get already:true, so retrying is always safe. Use `after` to require an earlier action first. An empty calls list records the action as a journal entry.",
  inputSchema: { name: z.string().describe("unique, stable name for this action"), calls: z.array(callShape).default([]), after: z.string().optional() },
}, wrap(({ name, calls, after }) => v.act(name, calls, { after })));

server.registerTool("sophia_is_done", {
  description: "Check whether an action name already ran, before deciding to do it.",
  inputSchema: { name: z.string() },
}, wrap(({ name }) => v.isDone(name)));

server.registerTool("sophia_encode_call", {
  description: "Build a call for sophia_act from a function signature, e.g. signature \"function transfer(address to, uint256 amount)\", args [\"0x…\", \"1000000000000000000\"].",
  inputSchema: { to: z.string(), signature: z.string(), args: z.array(z.any()).default([]), value: z.string().optional() },
}, wrap(({ to, signature, args, value }) => { const fn = signature.replace(/^function\s+/, "").split("(")[0]; const c = encode(to, [signature.startsWith("function") ? signature : "function " + signature], fn, args, value || 0n); return { to: c.to, value: value || "0", data: c.data }; }));

server.registerTool("sophia_beat", {
  description: "Free proof that you're alive. Cancels any succession claim by your heir.",
  inputSchema: {},
}, wrap(() => v.beat()));

server.registerTool("sophia_fuel", {
  description: "How much fuel (project tokens) the vessel holds, the toll per action and per save point, and how many of each are left.",
  inputSchema: {},
}, wrap(() => v.fuel()));

server.registerTool("sophia_history", {
  description: "List your recent save points, newest first.",
  inputSchema: { limit: z.number().int().positive().max(200).default(20) },
}, wrap(({ limit }) => v.history({ limit })));

const mins = Number(process.env.SOPHIA_AUTOBEAT_MIN || 0);
if (mins > 0) v.autoBeat(mins * 60_000, { onError: (e) => console.error("[sophia-mcp] beat failed: " + explain(e).message) });

await server.connect(new StdioServerTransport());
console.error(`[sophia-mcp] vessel ${v.address} on chain ${v.chainId}${v.wallet ? "" : " (read-only: no SOPHIA_AGENT_KEY)"}`);
