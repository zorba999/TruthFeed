// Deploy TruthFeed to Ritual Chain and print the address.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatEther } from 'viem';
import { getClients } from './lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const artifact = JSON.parse(fs.readFileSync(path.join(root, 'build', 'TruthFeed.json'), 'utf8'));

const { account, publicClient, walletClient } = getClients();

const bal = await publicClient.getBalance({ address: account.address });
console.log('Deployer:', account.address);
console.log('Balance :', formatEther(bal), 'RITUAL');
if (bal === 0n) {
  console.error('Deployer has 0 RITUAL. Fund it at https://faucet.ritualfoundation.org');
  process.exit(1);
}

console.log('Deploying TruthFeed...');
const hash = await walletClient.deployContract({
  abi: artifact.abi,
  bytecode: artifact.bytecode,
  args: [],
});
console.log('Deploy tx:', hash);

const receipt = await publicClient.waitForTransactionReceipt({ hash });
const address = receipt.contractAddress;
console.log('Status   :', receipt.status);
console.log('TruthFeed:', address);

// Confirm code is present on-chain
const code = await publicClient.getCode({ address });
console.log('On-chain code size:', code ? (code.length / 2 - 1) : 0, 'bytes');

// Persist to build/ and remind to update .env
fs.writeFileSync(path.join(root, 'build', 'address.json'), JSON.stringify({ address }, null, 2));
console.log('\nSaved build/address.json');
console.log('Add this to your .env:  TRUTHFEED_ADDRESS=' + address);
console.log('Explorer: https://explorer.ritualfoundation.org/address/' + address);
