// TruthFeed end-to-end driver.
//   node scripts/interact.mjs deposit [amountRIT]
//   node scripts/interact.mjs submit "<claim text>"
//   node scripts/interact.mjs fetch  <id> ["<search query>"]
//   node scripts/interact.mjs judge  <id>
//   node scripts/interact.mjs all    "<claim text>" ["<search query>"]
//   node scripts/interact.mjs read   [id]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEther, formatEther } from 'viem';
import {
  getClients, ADDR, CAPABILITY, pickExecutor,
  RITUAL_WALLET_ABI,
} from './lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const artifact = JSON.parse(fs.readFileSync(path.join(root, 'build', 'TruthFeed.json'), 'utf8'));

function contractAddress() {
  const fromEnv = process.env.TRUTHFEED_ADDRESS;
  if (fromEnv) return fromEnv;
  const p = path.join(root, 'build', 'address.json');
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')).address;
  throw new Error('No contract address. Set TRUTHFEED_ADDRESS in .env or run deploy first.');
}

const FEES = { maxFeePerGas: 20_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n };
const { account, publicClient, walletClient } = getClients();
const ADDRESS = contractAddress();
const abi = artifact.abi;

const wc = (fn, args, extra = {}) =>
  walletClient.writeContract({ address: ADDRESS, abi, functionName: fn, args, ...FEES, ...extra });

const LOCK_BLOCKS = 200_000n; // ~19h at 0.35s blocks — must cover commitBlock + ttl

async function ensureDeposit(minRIT = 0.5) {
  const [bal, lockUntil, current] = await Promise.all([
    publicClient.readContract({ address: ADDR.RITUAL_WALLET, abi: RITUAL_WALLET_ABI, functionName: 'balanceOf', args: [account.address] }),
    publicClient.readContract({ address: ADDR.RITUAL_WALLET, abi: RITUAL_WALLET_ABI, functionName: 'lockUntil', args: [account.address] }),
    publicClient.getBlockNumber(),
  ]);
  const enoughBalance = bal >= parseEther(String(minRIT));
  const enoughLock = lockUntil >= current + 5_000n; // lock must comfortably cover ttl
  console.log('RitualWallet balance:', formatEther(bal), 'RITUAL | lockUntil:', lockUntil.toString(), '| current:', current.toString());
  if (enoughBalance && enoughLock) return;

  // Top up value only if balance is short; always (re)extend the lock.
  const value = enoughBalance ? parseEther('0.01') : parseEther(String(minRIT));
  console.log('Depositing', formatEther(value), 'RITUAL, extending lock by', LOCK_BLOCKS.toString(), 'blocks...');
  const hash = await walletClient.writeContract({
    address: ADDR.RITUAL_WALLET, abi: RITUAL_WALLET_ABI,
    functionName: 'deposit', args: [LOCK_BLOCKS], value, ...FEES,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  console.log('Deposit confirmed:', hash);
}

async function submit(text) {
  console.log('Submitting claim:', JSON.stringify(text));
  const hash = await wc('submitClaim', [text], { gas: 500_000n });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000, pollingInterval: 2_000 });
  const id = await publicClient.readContract({ address: ADDRESS, abi, functionName: 'claimCount', args: [] });
  console.log('Submitted. tx:', hash, '| claim id:', id.toString());
  return id;
}

async function fetchEvidence(id, query) {
  const executor = await pickExecutor(publicClient, CAPABILITY.HTTP_CALL);
  console.log('HTTP executor:', executor);
  const q = encodeURIComponent(query);
  // Keyless public source: Wikipedia REST search (small JSON, < 5KB).
  const url = `https://en.wikipedia.org/w/rest.php/v1/search/page?q=${q}&limit=1`;
  const headerKeys = ['User-Agent', 'Accept'];
  const headerValues = ['TruthFeed/0.1 (https://ritualfoundation.org; contact@example.com)', 'application/json'];
  console.log('Fetching evidence from:', url);
  const hash = await wc('fetchEvidence', [BigInt(id), executor, url, headerKeys, headerValues, 200n], { gas: 3_000_000n });
  console.log('fetch tx:', hash, '\nwaiting for async settlement (HTTP runs in TEE)...');
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 240_000, pollingInterval: 3_000 });
  console.log('fetch settled:', receipt.status);
}

async function judge(id) {
  const c = await readClaim(id, false);
  const executor = await pickExecutor(publicClient, CAPABILITY.LLM);
  console.log('LLM executor:', executor);
  const messages = [
    {
      role: 'system',
      content:
        'You are TruthFeed, a rigorous fact-checker. Judge the CLAIM using ONLY the ' +
        'provided EVIDENCE. Reply with exactly one JSON object and nothing else: ' +
        '{"verdict":"TRUE|MISLEADING|FALSE|UNVERIFIABLE","confidence":0-100,' +
        '"reasoning":"one or two sentences","citations":["short source refs"]}. ' +
        'If the evidence does not settle the claim, use "UNVERIFIABLE".',
    },
    {
      role: 'user',
      content:
        `CLAIM:\n${c.text}\n\nEVIDENCE (raw source JSON from ${c.sourceUrl}):\n${c.evidence}`,
    },
  ];
  const messagesJson = JSON.stringify(messages);
  const hash = await wc('judgeClaim', [BigInt(id), executor, messagesJson, 300n, 4096n], { gas: 6_000_000n });
  console.log('judge tx:', hash, '\nwaiting for async settlement (LLM inference in TEE, ~5-60s)...');
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 300_000, pollingInterval: 3_000 });
  console.log('judge settled:', receipt.status);
}

async function readClaim(id, print = true) {
  const r = await publicClient.readContract({ address: ADDRESS, abi, functionName: 'getClaim', args: [BigInt(id)] });
  const c = {
    author: r[0], stage: Number(r[1]), httpStatus: r[2], llmError: r[3],
    createdAt: r[4], judgedAt: r[5], text: r[6], sourceUrl: r[7], evidence: r[8], verdict: r[9],
  };
  if (print) {
    const stages = ['None', 'Submitted', 'Evidence', 'Judged'];
    console.log('\n===== Claim #' + id + ' =====');
    console.log('stage    :', stages[c.stage]);
    console.log('author   :', c.author);
    console.log('claim    :', c.text);
    console.log('source   :', c.sourceUrl || '(none)');
    console.log('httpStat :', c.httpStatus);
    console.log('evidence :', c.evidence ? c.evidence.slice(0, 240) + (c.evidence.length > 240 ? '…' : '') : '(none)');
    console.log('llmError :', c.llmError);
    console.log('verdict  :', c.verdict || '(none)');
  }
  return c;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  console.log('Account:', account.address, '| TruthFeed:', ADDRESS);
  switch (cmd) {
    case 'deposit':
      await ensureDeposit(rest[0] ? Number(rest[0]) : 0.5);
      break;
    case 'submit':
      await submit(rest.join(' '));
      break;
    case 'fetch': {
      const id = rest[0];
      const c = await readClaim(id, false);
      await fetchEvidence(id, rest.slice(1).join(' ') || c.text);
      await readClaim(id);
      break;
    }
    case 'judge':
      await ensureDeposit(0.5);
      await judge(rest[0]);
      await readClaim(rest[0]);
      break;
    case 'all': {
      await ensureDeposit(0.5);
      const text = rest[0];
      const query = rest[1] || text;
      const id = await submit(text);
      await fetchEvidence(id, query);
      await judge(id);
      await readClaim(id);
      break;
    }
    case 'read': {
      if (rest[0]) { await readClaim(rest[0]); break; }
      const count = await publicClient.readContract({ address: ADDRESS, abi, functionName: 'claimCount', args: [] });
      console.log('Total claims:', count.toString());
      for (let i = 1n; i <= count; i++) await readClaim(i.toString());
      break;
    }
    default:
      console.log('Usage: deposit | submit | fetch | judge | all | read');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
