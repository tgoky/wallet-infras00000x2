import { mnemonicToAccount, HDAccount } from 'viem/accounts';
import { createWalletClient, http, WalletClient } from 'viem';
import { mainnet } from 'viem/chains';

export class Keyring {
  public account: HDAccount;
  private client: WalletClient;

  constructor(mnemonic: string, rpcUrl: string = 'https://cloudflare-eth.com') {
    this.account = mnemonicToAccount(mnemonic);
    this.client = createWalletClient({
      account: this.account,
      chain: mainnet,
      transport: http(rpcUrl)
    });
  }

  getAddress(): string {
    return this.account.address;
  }

  async sendTransaction(tx: any): Promise<string> {
    return this.client.sendTransaction({
      account: this.account,
      chain: mainnet,
      to: tx.to,
      data: tx.data,
      value: tx.value ? BigInt(tx.value) : undefined,
    });
  }
}