import { NextResponse } from 'next/server';
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { createSmartAccountClient } from 'permissionless';
import { toSafeSmartAccount } from 'permissionless/accounts';
import { createPimlicoClient } from 'permissionless/clients/pimlico';


const PIMLICO_API_KEY = process.env.PIMLICO_API_KEY || process.env.NEXT_PUBLIC_PIMLICO_API_KEY || '';
const BUNDLER_URL = `https://api.pimlico.io/v2/sepolia/rpc?apikey=${PIMLICO_API_KEY}`;
const SEPOLIA_RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
const ENTRYPOINT_07_ADDRESS = '0x0000000071727De22E5E9d8BAf0edAc6f37da032';


const SERVER_PRIVATE_KEY = (
  process.env.SERVER_PRIVATE_KEY ||
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
) as `0x${string}`;

// Helper: build the shared infrastructure once, reused by both routes
async function buildServerSmartAccountClient() {
  const publicClient = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC) });
  const serverAccount = privateKeyToAccount(SERVER_PRIVATE_KEY);


  const pimlicoClient = createPimlicoClient({
    transport: http(BUNDLER_URL),
    entryPoint: { address: ENTRYPOINT_07_ADDRESS, version: '0.7' },
  });

  const safeAccount = await toSafeSmartAccount({
    client: publicClient,
    owners: [serverAccount],
    version: '1.4.1',
    entryPoint: { address: ENTRYPOINT_07_ADDRESS, version: '0.7' },
  });

  const smartAccountClient = createSmartAccountClient({
    account: safeAccount,
    chain: sepolia,
    paymaster: pimlicoClient,
    bundlerTransport: http(BUNDLER_URL),
    userOperation: {
      estimateFeesPerGas: async () => (await pimlicoClient.getUserOperationGasPrice()).fast,
    },
  });

  return { smartAccountClient, safeAccount, serverAccount };
}


export async function GET() {
  try {
    const { safeAccount, serverAccount } = await buildServerSmartAccountClient();
    return NextResponse.json({
      safeAddress: safeAccount.address,
      operatorAddress: serverAccount.address,
    });
  } catch (error: any) {
    console.error('[INFO] Failed to derive server Safe address:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}


export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { userId, merchant, amountUsd } = body;

    if (!userId || !merchant || typeof amountUsd !== 'number') {
      return NextResponse.json({ error: 'Invalid webhook payload' }, { status: 400 });
    }

    console.log(`\n🛎️  [WEBHOOK] Card swipe: user=${userId} | merchant=${merchant} | amount=$${amountUsd}`);

    const { smartAccountClient, safeAccount } = await buildServerSmartAccountClient();

    console.log(`⚙️  [SESSION KEY] Routing via server Safe: ${safeAccount.address}`);


    const usdcContractAddress = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
    const MOCK_MERCHANT_WALLET = '0x1111111111111111111111111111111111111111';

    const amountInUnits = BigInt(Math.round(amountUsd * 1_000_000)); // USDC = 6 decimals
    const transferSelector = '0xa9059cbb';
    const paddedTo = MOCK_MERCHANT_WALLET.slice(2).padStart(64, '0');
    const paddedAmount = amountInUnits.toString(16).padStart(64, '0');
    const calldata = `${transferSelector}${paddedTo}${paddedAmount}` as `0x${string}`;

    console.log(`🚀 [BUNDLER] Requesting Pimlico sponsorship and submitting UserOp...`);

    const txHash = await smartAccountClient.sendTransaction({
      to: usdcContractAddress,
      data: calldata,
      value: 0n,
    });

    console.log(`✅ [SUCCESS] Settled on-chain. Hash: ${txHash}\n`);

    return NextResponse.json({
      status: 'approved',
      txHash,
      safeAddress: safeAccount.address,
      merchant,
      amount: amountUsd,
    });
  } catch (error: any) {
    console.error(`❌ [DECLINED]`, error.message);
    return NextResponse.json(
      { status: 'declined', error: error.shortMessage || error.message },
      { status: 400 }
    );
  }
}