# TruthFeed — on-chain, TEE-attested claim / news verifier on Ritual Chain

TruthFeed fact-checks a claim **on-chain**. A claim is submitted, real-world
evidence is pulled from a public source with the **HTTP precompile (`0x0801`)**,
and a verdict is produced by the **LLM precompile (`0x0802`)** — both run inside a
TEE and their outputs are stored on-chain, so a verdict cannot be silently forged
or re-biased.

This is different from the two closest apps in the hackathon sheet: *Truth or Cap*
is a static trivia game and *On-Chain AI Judge* only weighs two arguments against
each other. TruthFeed fetches **external sources** and fact-checks a real claim.

## How it uses Ritual

| Step | Ritual primitive | Address |
|---|---|---|
| Pull evidence from a public source | HTTP precompile | `0x…0801` |
| Judge claim vs. evidence | LLM precompile (GLM-4.7-FP8) | `0x…0802` |
| Pay async executor fees | RitualWallet | `0x532F…3948` |
| Pick a live TEE executor | TEEServiceRegistry | `0x9644…Bf47F` |

Both HTTP and LLM are **short-running async** precompiles: the tx is deferred,
the executor runs the work in a TEE, and the result is injected back into the same
tx (fulfilled replay). Only **one** async precompile call is allowed per tx, so
`fetchEvidence` (HTTP) and `judgeClaim` (LLM) are separate transactions.

## Live deployment (Ritual testnet, chain 1979)

- Contract: `0x7357875a6aeb2d96551946e8a695224a9cca880f`
- Explorer: https://explorer.ritualfoundation.org/address/0x7357875a6aeb2d96551946e8a695224a9cca880f
- Verified end-to-end: claim #1 (Eiffel Tower in Berlin) → **FALSE 100%**, claim #2 (water boils at 100°C) → **TRUE 100%**.

## Layout

```
contracts/TruthFeed.sol   the on-chain verifier (calls HTTP + LLM precompiles)
scripts/lib.mjs           chain config, ABIs, executor selection (viem)
scripts/compile.mjs       solc compile (viaIR, shanghai EVM) -> build/TruthFeed.json
scripts/deploy.mjs        deploy to Ritual + confirm on-chain code
scripts/interact.mjs      submit / fetch / judge / read pipeline
scripts/serve.mjs         static server for the frontend + /config.json
web/index.html            read-only feed + submit-via-wallet UI
```

## Run it

```bash
npm install
# .env already holds RITUAL_RPC_URL, PRIVATE_KEY (testnet), TRUTHFEED_ADDRESS

npm run compile           # build/TruthFeed.json
npm run deploy            # deploys, prints address -> put it in .env

# one-shot fact-check: submit -> fetch evidence -> judge -> print
node scripts/interact.mjs all "The Eiffel Tower is located in Berlin." "Eiffel Tower"

# or step by step
node scripts/interact.mjs deposit 0.4     # fund + lock RitualWallet
node scripts/interact.mjs submit "<claim>"
node scripts/interact.mjs fetch  <id> "<wikipedia query>"
node scripts/interact.mjs judge  <id>
node scripts/interact.mjs read            # print the whole feed

npm run web               # http://localhost:8787
```

## Gotchas learned the hard way (all real Ritual constraints)

- **RitualWallet needs an active *lock*, not just a balance.** Async calls are
  rejected with `insufficient lock duration` if `lockUntil` has passed — even with
  funds present. `ensureDeposit` re-extends the lock every run.
- **One async precompile per tx** → evidence and judging are two txs.
- **Sender lock**: one pending async job per EOA; the pipeline runs sequentially.
- **HTTP responses are capped at ~5KB** → the Wikipedia search uses `limit=1`.
- **Wikipedia requires a `User-Agent` header** → passed through `fetchEvidence`.
- **`viaIR` compilation** is needed (stack-too-deep), targeting the **shanghai** EVM
  (avoid cancun opcodes).
- LLM `convoHistory` is the mandatory 30th ABI field; an empty `("","","")`
  StorageRef means "no persisted history".

## Security note

The `.env` private key is a **throwaway testnet key** (faucet RITUAL, no real
value). Never commit or reuse a key that holds real funds.

## Possible next steps

- Multi-source evidence (news APIs via ECIES-encrypted secrets instead of keyless Wikipedia).
- `Scheduler` (`0x56e7…D58B`) to re-check time-sensitive claims and update the verdict.
- On-chain verdict struct (parse the JSON with the JQ precompile `0x0803`) for fully queryable results.
