// SOPHIA SDK: exactly-once actions, provable memory and succession for onchain agents.
// One class, `Vessel`, wraps a deployed Vessel contract. Uses ethers v6.
import { ethers } from "ethers";
import { VESSEL_ABI, HUB_ABI, ERC20_ABI } from "./abi.js";
import { CHAINS, DEFAULT_CHAIN } from "./chains.js";

export { VESSEL_ABI, HUB_ABI, ERC20_ABI, CHAINS, DEFAULT_CHAIN, ethers };

const ZERO = ethers.ZeroHash;
const VI = new ethers.Interface(VESSEL_ABI);
const HI = new ethers.Interface(HUB_ABI);
const MAX_INLINE = 8192; // bytes of JSON stored inline in the save point's uri

// ---------- small helpers ----------

/** Turn a name ("pay-invoice-42") or a 32-byte hex id into an op id. The same name always gives the same id. */
export function opId(name) {
  if (name == null || name === "") return ZERO;
  if (typeof name === "string" && /^0x[0-9a-fA-F]{64}$/.test(name)) return name.toLowerCase();
  return ethers.keccak256(ethers.toUtf8Bytes(String(name)));
}

/** JSON with sorted keys, so the same state always hashes the same. BigInts become strings. */
export function canonicalJson(v) {
  const norm = (x) => {
    if (typeof x === "bigint") return x.toString();
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === "object") { const o = {}; for (const k of Object.keys(x).sort()) if (x[k] !== undefined) o[k] = norm(x[k]); return o; }
    return x;
  };
  return JSON.stringify(norm(v));
}

/** Hash of a state, as stored onchain in a save point. */
export function stateRoot(state) { return ethers.keccak256(ethers.toUtf8Bytes(canonicalJson(state))); }

/** Wei from a bigint (already wei) or a decimal string/number in whole coins ("0.01"). */
function toWei(v, decimals = 18) {
  if (v == null || v === "") return 0n;
  if (typeof v === "bigint") return v;
  return ethers.parseUnits(String(v), decimals);
}

/** Build one call for `act`: encode(to, ["function transfer(address,uint256)"], "transfer", [a, b]). */
export function encode(to, abi, fn, args = [], value = 0n) {
  return { to: ethers.getAddress(to), value: toWei(value), data: new ethers.Interface(abi).encodeFunctionData(fn, args) };
}

function normCalls(calls = []) {
  return calls.map((c, i) => {
    if (!c || !c.to) throw new Error(`call ${i} needs a "to" address`);
    return { to: ethers.getAddress(c.to), value: toWei(c.value), data: c.data || "0x" };
  });
}

/** Explain a revert from a SOPHIA contract in plain words. Returns { name, args, message }. */
export function explain(err) {
  const data = err?.data ?? err?.info?.error?.data ?? err?.error?.data ?? err?.revert?.data;
  let parsed = null;
  if (err?.revert?.name) parsed = { name: err.revert.name, args: err.revert.args };
  else if (typeof data === "string" && data.length >= 10) { try { const p = VI.parseError(data) || HI.parseError(data); if (p) parsed = { name: p.name, args: p.args }; } catch {} }
  if (!parsed) {
    const raw = JSON.stringify(err?.info ?? err?.error ?? "") + " " + (err?.message || "");
    if (err?.code === "INSUFFICIENT_FUNDS" || /insufficient funds|enough funds/i.test(raw)) return { name: "NoGas", args: [], message: "The wallet sending this has no gas money. Send it a little of the chain's gas coin (HYPE on Elysium)." };
    return { name: null, args: [], message: err?.shortMessage || err?.message || String(err) };
  }
  const raw = parsed.args || [];
  const a = []; try { for (let i = 0; i < raw.length; i++) a.push(raw[i]); } catch {}
  const M = {
    NotAllowed: () => "This wallet isn't allowed to do that on this vessel.",
    AlreadyDone: () => `That action already ran (op ${a[0]}).`,
    NotYet: () => `The step this depends on hasn't run yet (op ${a[0]}).`,
    EmptyOp: () => "An action needs an id.",
    IsPaused: () => "The owner has paused this vessel's agent.",
    OverDailyCap: () => `Over the daily spending cap: wanted ${ethers.formatEther(a[0] ?? 0n)}, ${ethers.formatEther(a[1] ?? 0n)} left today.`,
    TargetNotAllowed: () => `That contract isn't on this vessel's allow-list (${a[0]}).`,
    CallFailed: () => `Call #${a[0]} in the batch failed.`,
    OutOfFuel: () => `Out of fuel: the toll is ${ethers.formatUnits(a[0] ?? 0n, 18)} tokens and the vessel holds ${ethers.formatUnits(a[1] ?? 0n, 18)}. Top it up.`,
    TooEarly: () => "Too early: the waiting period hasn't passed.",
    NoClaim: () => "There's no open succession claim.",
    BadValue: () => "One of the values isn't valid.",
    BadAddress: () => "One of the addresses isn't valid.",
  };
  return { name: parsed.name, args: a, message: M[parsed.name] ? M[parsed.name]() : parsed.name };
}

class SophiaError extends Error {
  constructor(err) { const e = explain(err); super(e.message); this.name = "SophiaError"; this.reason = e.name; this.args = e.args; this.cause = err; }
}
export { SophiaError };

function signerFrom({ signer, privateKey, rpc, chainId }) {
  if (signer) return signer;
  const chain = CHAINS[chainId ?? DEFAULT_CHAIN];
  const provider = new ethers.JsonRpcProvider(rpc || process.env.SOPHIA_RPC || chain?.rpc, chainId ? Number(chainId) : undefined, { staticNetwork: !!chainId, cacheTimeout: -1 });
  const key = privateKey || process.env.SOPHIA_AGENT_KEY;
  return key ? new ethers.Wallet(key, provider) : provider; // a provider alone is read-only
}

// ---------- Vessel ----------

export class Vessel {
  /**
   * @param {object} o
   * @param {string} o.vessel  vessel address (or env SOPHIA_VESSEL)
   * @param {string} [o.privateKey] agent key (or env SOPHIA_AGENT_KEY). Leave out for read-only.
   * @param {ethers.Signer} [o.signer] use your own signer instead of a key
   * @param {string} [o.rpc] RPC url (or env SOPHIA_RPC). Defaults to the chain's public RPC.
   * @param {number} [o.chainId] 99901 (Elysium) by default
   * @param {string} [o.explorer] explorer url, used as a fallback for reading memory
   */
  constructor(o = {}) {
    const address = o.vessel || process.env.SOPHIA_VESSEL;
    if (!address) throw new Error("Pass { vessel } or set SOPHIA_VESSEL to your vessel address.");
    this.address = ethers.getAddress(address);
    this.chainId = Number(o.chainId || process.env.SOPHIA_CHAIN_ID || DEFAULT_CHAIN);
    this.chain = CHAINS[this.chainId] || {};
    this.explorer = o.explorer ?? this.chain.explorer;
    this.runner = signerFrom({ ...o, chainId: this.chainId });
    this.provider = this.runner.provider || this.runner;
    this.contract = new ethers.Contract(this.address, VESSEL_ABI, this.runner);
    this.lastOp = ZERO;      // last action finished in this session (used as the default for remember)
    this._mem = null;        // last save point seen in this session
  }

  static connect(o) { return new Vessel(o); }

  /** The wallet sending transactions, or null when read-only. */
  get wallet() { return this.runner.getAddress ? this.runner : null; }
  _need() { if (!this.wallet) throw new Error("Read-only: pass { privateKey } or set SOPHIA_AGENT_KEY to send transactions."); }

  opId(name) { return opId(name); }

  /** Has this action already run? */
  async isDone(name) {
    const id = opId(name); const at = await this.contract.doneAt(id);
    return { opId: id, done: at !== 0n, at: Number(at) };
  }

  /**
   * Run a batch of calls exactly once under `name`. Safe to retry: if it already ran, nothing is sent
   * and you get { already: true }. Pass `after` to require an earlier action first.
   * calls: [{ to, value?, data? }]  (value in whole coins as a string, or wei as a bigint)
   * An empty batch is fine: it records the action and pays the toll (useful as a journal entry).
   */
  async act(name, calls = [], { after, value } = {}) {
    this._need();
    const id = opId(name), afterId = opId(after);
    if (id === ZERO) throw new Error("act() needs a name or id.");
    const was = await this.contract.doneAt(id);
    if (was !== 0n) { this.lastOp = id; return { opId: id, already: true, at: Number(was) }; }
    const cs = normCalls(calls);
    const v = toWei(value);
    let results;
    try { results = await this.contract.execute.staticCall(id, afterId, cs, { value: v }); }
    catch (e) { const x = new SophiaError(e); if (x.reason === "AlreadyDone") { this.lastOp = id; return { opId: id, already: true }; } throw x; }
    let rc;
    try { const tx = await this.contract.execute(id, afterId, cs, { value: v }); rc = await tx.wait(); }
    catch (e) { const x = new SophiaError(e); if (x.reason === "AlreadyDone") { this.lastOp = id; return { opId: id, already: true }; } throw x; }
    this.lastOp = id;
    return { opId: id, already: false, hash: rc.hash, block: rc.blockNumber, results: [...results] };
  }

  /**
   * Save a point in the agent's memory. The state is hashed onchain and, if small (under 8 KB of JSON),
   * stored inline so `recall()` can bring it back with no other storage. For bigger state, store it
   * yourself (IPFS, a URL) and pass { uri }; the hash still proves it wasn't changed.
   * lastOp defaults to the last action this session finished.
   */
  async remember(state, { lastOp, uri } = {}) {
    this._need();
    const json = canonicalJson(state);
    const root = ethers.keccak256(ethers.toUtf8Bytes(json));
    if (!uri) {
      if (Buffer.byteLength(json) > MAX_INLINE) throw new Error(`State is ${Buffer.byteLength(json)} bytes; store it elsewhere and pass { uri }. Inline limit is ${MAX_INLINE}.`);
      uri = "data:application/json;base64," + Buffer.from(json).toString("base64");
    }
    const last = lastOp === undefined ? this.lastOp : opId(lastOp);
    let rc;
    try { const tx = await this.contract.mark(root, last, uri); rc = await tx.wait(); }
    catch (e) { throw new SophiaError(e); }
    const ev = rc.logs.map((l) => { try { return VI.parseLog(l); } catch { return null; } }).find((p) => p?.name === "Marked");
    this._mem = { seq: Number(ev.args.seq), root, head: ev.args.head, lastOp: last, uri, state: JSON.parse(json), verified: true, block: rc.blockNumber, hash: rc.hash };
    return this._mem;
  }

  /**
   * Bring back the latest save point (or save point number `seq`), with its state and a check that the
   * state matches the hash onchain. Returns null if the vessel has never saved.
   */
  async recall({ seq, fromBlock } = {}) {
    const count = Number(await this.contract.markCount());
    if (!count) return null;
    const want = seq ?? count;
    if (this._mem && this._mem.seq === want) return this._mem;
    const log = await this._findMark(want, fromBlock);
    if (!log) throw new Error(`Couldn't find save point #${want} in the logs. Pass { fromBlock } near when it was saved.`);
    const p = VI.parseLog(log);
    const out = { seq: Number(p.args.seq), root: p.args.root, head: p.args.head, lastOp: p.args.lastOp, uri: p.args.uri, block: log.blockNumber, hash: log.transactionHash, state: null, verified: false };
    const body = await readUri(out.uri);
    if (body != null) {
      out.verified = ethers.keccak256(ethers.toUtf8Bytes(body)) === out.root;
      try { out.state = JSON.parse(body); } catch { out.state = body; }
    }
    if (want === count) this._mem = out;
    return out;
  }

  /** All save points, newest first (up to `limit`). */
  async history({ fromBlock = 0, limit = 50 } = {}) {
    const logs = await this._logs(this.contract.filters.Marked(), fromBlock);
    return logs.reverse().slice(0, limit).map((l) => { const p = VI.parseLog(l); return { seq: Number(p.args.seq), root: p.args.root, head: p.args.head, lastOp: p.args.lastOp, uri: p.args.uri, block: l.blockNumber, hash: l.transactionHash }; });
  }

  /** Check that a list of save points (oldest first, starting at #1) chains up to the head stored onchain. */
  async verifyChain(fromBlock = 0) {
    const all = (await this.history({ fromBlock, limit: 1e9 })).reverse();
    let h = ZERO;
    for (const m of all) h = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "bytes32", "bytes32", "uint64"], [h, m.root, m.lastOp, m.seq]));
    const onchain = await this.contract.head();
    return { ok: h === onchain, count: all.length, head: onchain };
  }

  /** Free proof of life. Cancels any open succession claim. */
  async beat() { this._need(); try { const tx = await this.contract.beat(); const rc = await tx.wait(); return { hash: rc.hash }; } catch (e) { throw new SophiaError(e); } }

  /** Beat on a timer. Returns a function that stops it. Only beats if the vessel has been quiet for `quietSec`. */
  autoBeat(everyMs = 3_600_000, { quietSec, onError } = {}) {
    const q = quietSec ?? Math.floor(everyMs / 1000);
    const t = setInterval(async () => {
      try { if (Number(await this.contract.silentFor()) >= q) await this.beat(); } catch (e) { onError?.(e); }
    }, everyMs);
    t.unref?.();
    return () => clearInterval(t);
  }

  /** Everything about the vessel in one call. */
  async status() {
    const c = this.contract;
    const [owner, agent, successor, paused, lapse, notice, lastBeat, claimReadyAt, dailyCap, dailyLeft, restrictTargets, opCount, markCount, head, silentFor, hub] =
      await Promise.all([c.owner(), c.agent(), c.successor(), c.paused(), c.lapse(), c.notice(), c.lastBeat(), c.claimReadyAt(), c.dailyCap(), c.dailyLeft(), c.restrictTargets(), c.opCount(), c.markCount(), c.head(), c.silentFor(), c.hub()]);
    const f = await this.fuel(hub).catch(() => null);
    const native = await this.provider.getBalance(this.address);
    return {
      vessel: this.address, chainId: this.chainId, chain: this.chain.name, owner, agent, successor: successor === ethers.ZeroAddress ? null : successor,
      paused, lapseSec: Number(lapse), noticeSec: Number(notice), lastBeat: Number(lastBeat), silentForSec: Number(silentFor),
      claimOpen: claimReadyAt !== 0n, claimReadyAt: Number(claimReadyAt),
      dailyCap: ethers.formatEther(dailyCap), dailyLeft: ethers.formatEther(dailyLeft), restrictTargets,
      actions: Number(opCount), savePoints: Number(markCount), head, balance: ethers.formatEther(native), fuel: f,
    };
  }

  /** Token balance (fuel) and tolls. */
  async fuel(hubAddr) {
    const hub = new ethers.Contract(hubAddr || (await this.contract.hub()), HUB_ABI, this.provider);
    const [token, , markFee, opFee] = await hub.toll();
    const t = new ethers.Contract(token, ERC20_ABI, this.provider);
    const [bal, dec, sym] = await Promise.all([t.balanceOf(this.address), t.decimals().catch(() => 18), t.symbol().catch(() => "TOKEN")]);
    const d = Number(dec);
    return { token, symbol: sym, balance: ethers.formatUnits(bal, d), markFee: ethers.formatUnits(markFee, d), opFee: ethers.formatUnits(opFee, d),
      actionsLeft: opFee ? Number(bal / opFee) : null, savePointsLeft: markFee ? Number(bal / markFee) : null };
  }

  /** Send fuel (project tokens) from this wallet into the vessel. amount in whole tokens. */
  async topUp(amount) {
    this._need();
    const hub = new ethers.Contract(await this.contract.hub(), HUB_ABI, this.provider);
    const t = new ethers.Contract(await hub.token(), ERC20_ABI, this.runner);
    const tx = await t.transfer(this.address, toWei(amount, Number(await t.decimals().catch(() => 18))));
    return { hash: (await tx.wait()).hash };
  }

  // ----- owner -----
  async _send(fn, ...args) { this._need(); try { const tx = await this.contract[fn](...args); const rc = await tx.wait(); return { hash: rc.hash }; } catch (e) { throw new SophiaError(e); } }
  setAgent(a) { return this._send("setAgent", a); }
  setSuccessor(s, lapseSec, noticeSec) { return this._send("setSuccessor", s || ethers.ZeroAddress, BigInt(lapseSec || 0), BigInt(noticeSec || 0)); }
  setLeash(dailyCap, restrictTargets = false) { return this._send("setLeash", toWei(dailyCap), !!restrictTargets); }
  allow(target, allowed = true) { return this._send("setTarget", target, allowed); }
  pause() { return this._send("setPaused", true); }
  unpause() { return this._send("setPaused", false); }
  veto() { return this._send("veto"); }
  withdraw(token, to, amount, decimals = 18) { return this._send("withdraw", token || ethers.ZeroAddress, to, toWei(amount, decimals)); }

  // ----- successor -----
  claim() { return this._send("claim"); }
  takeOver() { return this._send("takeOver"); }

  // ----- log reading with fallbacks -----
  async _findMark(seq, fromBlock) {
    const logs = await this._logs(this.contract.filters.Marked(seq), fromBlock);
    return logs[logs.length - 1] || null;
  }

  async _logs(filter, fromBlock = 0) {
    const topics = await filter.getTopicFilter();
    // 1) one wide RPC query
    try { return await this.provider.getLogs({ address: this.address, topics, fromBlock: fromBlock ?? 0, toBlock: "latest" }); } catch {}
    // 2) a Blockscout explorer, which has no range limit
    if (this.explorer) {
      try {
        const q = new URLSearchParams({ module: "logs", action: "getLogs", fromBlock: String(fromBlock ?? 0), toBlock: "latest", address: this.address });
        topics.forEach((t, i) => { if (t) { q.set(`topic${i}`, Array.isArray(t) ? t[0] : t); if (i) q.set(`topic0_${i}_opr`, "and"); } });
        const r = await fetch(`${this.explorer.replace(/\/$/, "")}/api?${q}`);
        const j = await r.json();
        if (Array.isArray(j.result)) return j.result.map((l) => ({ ...l, blockNumber: Number(l.blockNumber), index: Number(l.logIndex || 0), topics: l.topics.filter(Boolean) }));
      } catch {}
    }
    // 3) walk back from the latest block in chunks
    const latest = await this.provider.getBlockNumber(); const out = []; const step = 10_000; const stop = Math.max(fromBlock ?? 0, latest - 2_000_000);
    for (let to = latest; to >= stop; to -= step) {
      const from = Math.max(stop, to - step + 1);
      const part = await this.provider.getLogs({ address: this.address, topics, fromBlock: from, toBlock: to });
      out.unshift(...part);
      if (filter.fragment?.name === "Marked" && topics[1] && part.length) break;
    }
    return out;
  }
}

async function readUri(uri) {
  if (!uri) return null;
  const m = /^data:application\/json(;base64)?,(.*)$/s.exec(uri);
  if (m) return m[1] ? Buffer.from(m[2], "base64").toString("utf8") : decodeURIComponent(m[2]);
  let url = uri;
  if (uri.startsWith("ipfs://")) url = "https://ipfs.io/ipfs/" + uri.slice(7);
  if (!/^https?:\/\//.test(url)) return null;
  try { const r = await fetch(url); return r.ok ? await r.text() : null; } catch { return null; }
}

// ---------- forging (owner side) ----------

/**
 * Create a vessel. Run by the owner's wallet.
 * @param {object} o
 * @param {string} [o.hub] the VesselHub address (or env SOPHIA_HUB, or the chain default)
 * @param {string} [o.privateKey] owner key (or pass signer). Never the agent's key if you can avoid it.
 * @param {string} o.agent the agent's wallet address
 * @param {string} [o.name] any name; the vessel address is fixed by owner + name
 * @param {string} [o.successor] heir wallet; [o.lapseSec] silence before it may claim; [o.noticeSec] veto window
 * @param {string} [o.dailyCap] native coin the agent may send per day (e.g. "0.05")
 * @param {string[]} [o.allow] restrict the agent to these contracts
 * @param {string} [o.fuel] project tokens to put in for tolls (e.g. "500")
 */
export async function forge(o = {}) {
  const chainId = Number(o.chainId || process.env.SOPHIA_CHAIN_ID || DEFAULT_CHAIN);
  const signer = signerFrom({ signer: o.signer, privateKey: o.privateKey || process.env.SOPHIA_OWNER_KEY, rpc: o.rpc, chainId });
  if (!signer.getAddress) throw new Error("forge() needs the owner's signer or privateKey.");
  const hubAddr = o.hub || process.env.SOPHIA_HUB || CHAINS[chainId]?.hub;
  if (!hubAddr) throw new Error("Pass { hub } or set SOPHIA_HUB to the VesselHub address.");
  const hub = new ethers.Contract(hubAddr, HUB_ABI, signer);
  const owner = await signer.getAddress();
  const salt = opId(o.name || `vessel-${Date.now()}`);
  const address = await hub.predict(owner, salt);
  const code = await signer.provider.getCode(address);
  if (code === "0x") { try { await (await hub.create(owner, ethers.getAddress(o.agent), salt)).wait(); } catch (e) { throw new SophiaError(e); } }
  const v = new Vessel({ vessel: address, signer, chainId, rpc: o.rpc });
  if (o.successor) await v.setSuccessor(o.successor, o.lapseSec ?? 7 * 86400, o.noticeSec ?? 2 * 86400);
  if (o.dailyCap != null || o.allow?.length) await v.setLeash(o.dailyCap ?? 0, !!o.allow?.length);
  for (const t of o.allow || []) await v.allow(t, true);
  if (o.fuel) await v.topUp(o.fuel);
  return { vessel: address, owner, agent: o.agent, existed: code !== "0x" };
}

export default Vessel;
