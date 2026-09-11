#!/usr/bin/env node
/**
 * Pays an EIP-681 token transfer on the local chain, as the customer's wallet would.
 *
 *   npm run demo:pay -- "ethereum:0x…@31337/transfer?address=0x…&uint256=1500000"
 *
 * The only role this plays is the customer's: it sends exactly the transfer the
 * checkout displays, from one of the chain's unlocked development accounts. It
 * talks to the chain and to nothing in the gateway, and nothing in the gateway
 * learns of it except by the provider scanning the chain.
 */

const rpcUrl = process.env.ANVIL_RPC_URL ?? 'http://127.0.0.1:8545';
const payer = (
  process.env.PAYER_ADDRESS ?? '0x70997970c51812dc3a010c7d01b50e0d17dc79c8'
).toLowerCase();

const uri = process.argv[2];
const match =
  uri === undefined
    ? null
    : /^ethereum:(0x[0-9a-f]{40})@(\d+)\/transfer\?address=(0x[0-9a-f]{40})&uint256=(\d+)$/i.exec(
        uri,
      );
if (match === null) {
  process.stderr.write(
    'Usage: npm run demo:pay -- "ethereum:<token>@<chain>/transfer?address=<to>&uint256=<amount>"\n',
  );
  process.exit(64);
}
const [, token, chainId, recipient, amount] = match;

async function rpc(method, params) {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await response.json();
  if (body.error !== undefined) {
    throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  }
  return body.result;
}

const padWord = (hex) => hex.replace(/^0x/, '').padStart(64, '0');

const actualChain = Number(await rpc('eth_chainId', []));
if (actualChain !== Number(chainId)) {
  process.stderr.write(
    `The URI names chain ${chainId} but ${rpcUrl} is chain ${String(actualChain)}.\n`,
  );
  process.exit(65);
}

const data = `0xa9059cbb${padWord(recipient)}${padWord(BigInt(amount).toString(16))}`;
const hash = await rpc('eth_sendTransaction', [{ from: payer, to: token, data }]);
process.stdout.write(`sent ${amount} base units to ${recipient}: ${hash}\n`);

for (let attempt = 0; attempt < 30; attempt += 1) {
  const receipt = await rpc('eth_getTransactionReceipt', [hash]);
  if (receipt !== null) {
    process.stdout.write(
      `mined in block ${String(Number(receipt.blockNumber))}, status ${receipt.status}\n`,
    );
    process.exit(receipt.status === '0x1' ? 0 : 1);
  }
  await new Promise((settle) => setTimeout(settle, 1000));
}
process.stderr.write('the transfer was not mined within 30 seconds\n');
process.exit(1);
