// Compile contracts/TruthFeed.sol with solc-js, targeting the shanghai EVM
// (Ritual Chain does not guarantee cancun opcodes). Outputs build/TruthFeed.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const srcPath = path.join(root, 'contracts', 'TruthFeed.sol');
const source = fs.readFileSync(srcPath, 'utf8');

const input = {
  language: 'Solidity',
  sources: { 'TruthFeed.sol': { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    viaIR: true,
    evmVersion: 'shanghai',
    outputSelection: {
      '*': { '*': ['abi', 'evm.bytecode.object'] },
    },
  },
};

console.log('Compiling with solc', solc.version());
const out = JSON.parse(solc.compile(JSON.stringify(input)));

if (out.errors) {
  let fatal = false;
  for (const e of out.errors) {
    console.log(e.formattedMessage);
    if (e.severity === 'error') fatal = true;
  }
  if (fatal) {
    console.error('Compilation failed.');
    process.exit(1);
  }
}

const contract = out.contracts['TruthFeed.sol']['TruthFeed'];
const artifact = {
  abi: contract.abi,
  bytecode: '0x' + contract.evm.bytecode.object,
};

const buildDir = path.join(root, 'build');
fs.mkdirSync(buildDir, { recursive: true });
fs.writeFileSync(path.join(buildDir, 'TruthFeed.json'), JSON.stringify(artifact, null, 2));
console.log('Wrote build/TruthFeed.json  (bytecode', artifact.bytecode.length / 2 - 1, 'bytes)');
