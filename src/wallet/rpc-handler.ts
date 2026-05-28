import { EventEmitter } from 'events';
import { createPublicClient, createWalletClient, custom, http, PublicClient, WalletClient } from 'viem';
import { sepolia } from 'viem/chains';
import { createSmartAccountClient } from 'permissionless';
import { toSafeSmartAccount } from 'permissionless/accounts';
import { createPimlicoClient } from 'permissionless/clients/pimlico';

const PIMLICO_API_KEY = process.env.NEXT_PUBLIC_PIMLICO_API_KEY || '';
const BUNDLER_URL = `https://api.pimlico.io/v2/sepolia/rpc?apikey=${PIMLICO_API_KEY}`;
const ENTRYPOINT_07_ADDRESS = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const SEPOLIA_RPC = 'https://ethereum-sepolia-rpc.publicnode.com';

export class RpcHandler extends EventEmitter {
  private publicClient: PublicClient;
  private smartAccountClientPromise: Promise<any>;

  
  constructor(private ownerWalletClient: WalletClient, private ownerAddress: string) {
    super();

    this.publicClient = createPublicClient({
      chain: sepolia,
      transport: http(SEPOLIA_RPC),
    });

    this.smartAccountClientPromise = this.initSmartAccount().catch(err => {
      console.error("🚨 INIT ERROR:", err);
      this.emit('log', `❌ Init Error: ${err.message}`);
      throw err;
    });
  }

  async getAddress(): Promise<string> {
    const smartAccountClient = await this.smartAccountClientPromise;
    return smartAccountClient.account.address;
  }

  private async initSmartAccount() {
    this.emit('log', 'Initializing Pimlico client...');

    const pimlicoClient = createPimlicoClient({
      transport: http(BUNDLER_URL),
      entryPoint: {
        address: ENTRYPOINT_07_ADDRESS,
        version: "0.7",
      },
    });

    this.emit('log', 'Deriving counterfactual Safe address from Signer...');

 
    const safeAccount = await toSafeSmartAccount({
      client: this.publicClient,
      owners: [this.ownerWalletClient],
      version: '1.4.1',
      entryPoint: {
        address: ENTRYPOINT_07_ADDRESS,
        version: "0.7",
      },
    });

    this.emit('log', `✅ Safe Address: ${safeAccount.address}`);

    return createSmartAccountClient({
      account: safeAccount,
      chain: sepolia,
      paymaster: pimlicoClient,
      bundlerTransport: http(BUNDLER_URL),
      userOperation: {
        estimateFeesPerGas: async () => {
          return (await pimlicoClient.getUserOperationGasPrice()).fast;
        },
      },
    });
  }

  async handle(method: string, params: any[] = []): Promise<any> {
    this.emit('log', `→ ${method}`);
    const smartAccountClient = await this.smartAccountClientPromise;

    switch (method) {
      case 'eth_requestAccounts':
      case 'eth_accounts':
        const safeAddress = smartAccountClient.account.address;
        this.emit('log', `Safe address requested: ${safeAddress}`);
        return [safeAddress];

      case 'eth_chainId':
        return `0x${sepolia.id.toString(16)}`;

      case 'eth_estimateGas':
        this.emit('log', 'eth_estimateGas intercepted — returning AA ceiling estimate');
        return '0x927C0';

      case 'eth_sendTransaction':
        return new Promise((resolve, reject) => {
          const txPayload = params[0];
          this.emit('log', `Intercepted tx → ${txPayload.to}`);

          this.emit('tx_request', {
            payload: txPayload,
            onApprove: async () => {
              try {
                this.emit('log', 'Requesting Pimlico sponsorship...');
                this.emit('log', 'Building UserOperation...');

                const txHash = await smartAccountClient.sendTransaction({
                  to: txPayload.to,
                  data: txPayload.data || '0x',
                  value: txPayload.value ? BigInt(txPayload.value) : 0n,
                });

                this.emit('log', `✅ Bundled! Hash: ${txHash}`);
                resolve(txHash);
              } catch (err: any) {
                console.error("🚨 BUNDLER ERROR:", err);
                this.emit('log', `❌ ${err.shortMessage || err.message}`);
                reject(err);
              }
            },
            onReject: () => {
              this.emit('log', 'User rejected');
              reject({ code: 4001, message: 'User rejected the request.' });
            }
          });
        });

      case 'eth_call':
      case 'eth_blockNumber':
      case 'eth_getBalance':
      case 'eth_getTransactionCount':
        return this.publicClient.request({ method: method as any, params: params as any });

      default:
        throw { code: 4200, message: `Method '${method}' not supported.` };
    }
  }
}