// Shared Ritual Chain config + helpers (viem)
import 'dotenv/config';
import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const RPC_URL = process.env.RITUAL_RPC_URL || 'https://rpc.ritualfoundation.org';

export const ritualChain = defineChain({
  id: Number(process.env.CHAIN_ID || 1979),
  name: 'Ritual',
  nativeCurrency: { name: 'RITUAL', symbol: 'RITUAL', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: {
    default: { name: 'Ritual Explorer', url: 'https://explorer.ritualfoundation.org' },
  },
});

// ---- fixed system addresses (same across all Ritual deployments) ----
export const ADDR = {
  RITUAL_WALLET: '0x532F0dF0896F353d8C3DD8cc134e8129DA2a3948',
  TEE_SERVICE_REGISTRY: '0x9644e8562cE0Fe12b4deeC4163c064A8862Bf47F',
  ASYNC_JOB_TRACKER: '0xC069FFCa0389f44eCA2C626e55491b0ab045AEF5',
  HTTP_PRECOMPILE: '0x0000000000000000000000000000000000000801',
  LLM_PRECOMPILE: '0x0000000000000000000000000000000000000802',
};

export const CAPABILITY = { HTTP_CALL: 0, LLM: 1 };

export function getAccount() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error('PRIVATE_KEY missing in .env');
  return privateKeyToAccount(pk.startsWith('0x') ? pk : `0x${pk}`);
}

export function getClients() {
  const account = getAccount();
  const publicClient = createPublicClient({ chain: ritualChain, transport: http() });
  const walletClient = createWalletClient({ account, chain: ritualChain, transport: http() });
  return { account, publicClient, walletClient };
}

// ---- ABIs ----
export const RITUAL_WALLET_ABI = [
  { inputs: [{ name: 'lockDuration', type: 'uint256' }], name: 'deposit', outputs: [], stateMutability: 'payable', type: 'function' },
  { inputs: [{ name: 'account', type: 'address' }], name: 'balanceOf', outputs: [{ type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { inputs: [{ name: 'account', type: 'address' }], name: 'lockUntil', outputs: [{ type: 'uint256' }], stateMutability: 'view', type: 'function' },
];

export const TEE_REGISTRY_ABI = [
  {
    inputs: [
      { name: 'capability', type: 'uint8' },
      { name: 'checkValidity', type: 'bool' },
    ],
    name: 'getServicesByCapability',
    outputs: [
      {
        type: 'tuple[]',
        components: [
          {
            name: 'node',
            type: 'tuple',
            components: [
              { name: 'paymentAddress', type: 'address' },
              { name: 'teeAddress', type: 'address' },
              { name: 'teeType', type: 'uint8' },
              { name: 'publicKey', type: 'bytes' },
              { name: 'endpoint', type: 'string' },
              { name: 'certPubKeyHash', type: 'bytes32' },
              { name: 'capability', type: 'uint8' },
            ],
          },
          { name: 'isValid', type: 'bool' },
          { name: 'workloadId', type: 'bytes32' },
        ],
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
];

// Pick a valid executor teeAddress for a given capability.
export async function pickExecutor(publicClient, capability) {
  const services = await publicClient.readContract({
    address: ADDR.TEE_SERVICE_REGISTRY,
    abi: TEE_REGISTRY_ABI,
    functionName: 'getServicesByCapability',
    args: [capability, true],
  });
  const valid = services.filter((s) => s.isValid);
  if (valid.length === 0) {
    throw new Error(`No valid executors for capability ${capability}`);
  }
  return valid[0].node.teeAddress;
}
