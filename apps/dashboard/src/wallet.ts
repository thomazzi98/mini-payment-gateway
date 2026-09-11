/**
 * Handing an EIP-681 request to a browser wallet.
 *
 * The wallet is the customer's, not this page's: it talks to the chain, and the
 * page never does. What the page contributes is the transfer the URI encodes,
 * on the chain the URI names, from whichever account the wallet offers.
 */

interface WalletProvider {
  request(call: {
    readonly method: string;
    readonly params?: readonly unknown[];
  }): Promise<unknown>;
}

export const browserWallet = (): WalletProvider | undefined =>
  (globalThis as { ethereum?: WalletProvider }).ethereum;

const transferPattern =
  /^ethereum:(0x[0-9a-f]{40})@(\d+)\/transfer\?address=(0x[0-9a-f]{40})&uint256=(\d+)$/i;

const padWord = (hex: string): string => hex.replace(/^0x/, '').padStart(64, '0');

export interface ParsedTransfer {
  readonly token: string;
  readonly chainId: number;
  readonly recipient: string;
  readonly amount: bigint;
}

export function parseTransferUri(uri: string): ParsedTransfer | undefined {
  const match = transferPattern.exec(uri);
  if (match === null) {
    return undefined;
  }
  return {
    token: match[1] ?? '',
    chainId: Number(match[2]),
    recipient: match[3] ?? '',
    amount: BigInt(match[4] ?? '0'),
  };
}

export async function payWithWallet(uri: string): Promise<string> {
  const wallet = browserWallet();
  if (wallet === undefined) {
    throw new Error('No browser wallet is available.');
  }
  const transfer = parseTransferUri(uri);
  if (transfer === undefined) {
    throw new Error('The payment URI is not a token transfer this page can hand to a wallet.');
  }
  await wallet.request({
    method: 'wallet_switchEthereumChain',
    params: [{ chainId: `0x${transfer.chainId.toString(16)}` }],
  });
  const accounts = (await wallet.request({ method: 'eth_requestAccounts' })) as string[];
  const from = accounts[0];
  if (from === undefined) {
    throw new Error('The wallet offered no account.');
  }
  const data = `0xa9059cbb${padWord(transfer.recipient)}${padWord(transfer.amount.toString(16))}`;
  const hash = await wallet.request({
    method: 'eth_sendTransaction',
    params: [{ from, to: transfer.token, data }],
  });
  return String(hash);
}
