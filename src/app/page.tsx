'use client';

import { useEffect, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider, createConfig, http, useReadContract } from 'wagmi';
import { sepolia } from 'viem/chains';
import { injected } from '@wagmi/connectors';
import { PrivyProvider, usePrivy, useWallets } from '@privy-io/react-auth';
import { RpcHandler } from '../wallet/rpc-handler';
import { EIP1193Provider } from '../wallet/provider';
import { injectProvider } from '../wallet/inject';
import { createWalletClient, custom } from 'viem';

const queryClient = new QueryClient();

const wagmiConfig = createConfig({
  chains: [sepolia],
  connectors: [injected()],
  transports: { [sepolia.id]: http('https://ethereum-sepolia-rpc.publicnode.com') },
});

const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID || "";

const ERC20_BALANCE_ABI = [
  {
    name: 'balanceOf',
    type: 'function' as const,
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view' as const,
  },
] as const;

const USDC_ADDRESS = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
// USDC has 6 decimals. 1 USDC = 1_000_000 (1e6), NOT 1e18.
const USDC_DECIMALS = 6;

function formatUsdc(raw: bigint | undefined): string {
  if (raw === undefined || raw === null) return '0.00';
  return (Number(raw) / 10 ** USDC_DECIMALS).toFixed(2);
}

export default function AppWrapper() {
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        supportedChains: [sepolia],
        loginMethods: ['wallet', 'email'],
        appearance: { theme: 'light', accentColor: '#000000' }
      }}
    >
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <SandboxPage />
        </QueryClientProvider>
      </WagmiProvider>
    </PrivyProvider>
  );
}

function SandboxPage() {
  const [mounted, setMounted] = useState(false);
  const [logs, setLogs] = useState<string[]>(['> NeoBank Core OS booted.']);
  const [pendingTx, setPendingTx] = useState<any>(null);
  const [clientSafeAddress, setClientSafeAddress] = useState<`0x${string}` | undefined>(undefined);

  // FIX 2: Server Safe address is now fetched dynamically from /api/webhook/info
  // instead of being hardcoded. The server computes it from the private key and returns it.
  const [serverSafeAddress, setServerSafeAddress] = useState<`0x${string}` | undefined>(undefined);
  const [isSwipePending, setIsSwipePending] = useState(false);

  // Store our custom provider instance directly in a ref.
  // This is the core fix: we call provider.request() ourselves instead of
  // routing through wagmi's useSendTransaction, which would go through
  // Privy's window.ethereum and show a native gas prompt.
  const customProviderRef = useRef<EIP1193Provider | null>(null);
  const [isCheckoutPending, setIsCheckoutPending] = useState(false);

  const { login, authenticated, logout } = usePrivy();
  const { wallets } = useWallets();

  // FIX 1 applied: useReadContract with balanceOf ABI instead of useBalance({ token })
  const {
    data: clientBalanceRaw,
    refetch: refetchClientBalance,
  } = useReadContract({
    address: USDC_ADDRESS,
    abi: ERC20_BALANCE_ABI,
    functionName: 'balanceOf',
    args: clientSafeAddress ? [clientSafeAddress] : undefined,
    query: {
      enabled: !!clientSafeAddress,
      refetchInterval: 4000,
    },
  });

  const {
    data: serverBalanceRaw,
    refetch: refetchServerBalance,
  } = useReadContract({
    address: USDC_ADDRESS,
    abi: ERC20_BALANCE_ABI,
    functionName: 'balanceOf',
    args: serverSafeAddress ? [serverSafeAddress] : undefined,
    query: {
      enabled: !!serverSafeAddress,
      refetchInterval: 5000,
    },
  });

  const clientBalanceFormatted = formatUsdc(clientBalanceRaw as bigint | undefined);
  const serverBalanceFormatted = formatUsdc(serverBalanceRaw as bigint | undefined);
  const hasEnoughBalance = Number(clientBalanceFormatted) >= 1.00;

  useEffect(() => { setMounted(true); }, []);

  // FIX 2: Fetch the server Safe address on mount
  useEffect(() => {
    fetch('/api/webhook/info')
      .then(r => r.json())
      .then(d => { if (d.safeAddress) setServerSafeAddress(d.safeAddress); })
      .catch(err => console.error('Could not fetch server Safe address:', err));
  }, []);

  useEffect(() => {
    if (!authenticated || wallets.length === 0) {
      setClientSafeAddress(undefined);
      return;
    }

    let rpcHandler: RpcHandler;

  const setup = async () => {
  try {
    setLogs(prev => ['> Connecting Privy signer to EIP-1193 channel...', ...prev]);
    const activeWallet = wallets[0];
    const privyProvider = await activeWallet.getEthereumProvider();


    const ownerWalletClient = createWalletClient({
      account: activeWallet.address as `0x${string}`,
      chain: sepolia,
      transport: custom(privyProvider),
    });

    rpcHandler = new RpcHandler(ownerWalletClient, activeWallet.address);
    rpcHandler.on('log', (msg: string) => setLogs(prev => [`> ${msg}`, ...prev]));
    rpcHandler.on('tx_request', (txData: any) => setPendingTx(txData));

    const provider = new EIP1193Provider(rpcHandler);
    customProviderRef.current = provider;

    const addr = await rpcHandler.getAddress();
    setClientSafeAddress(addr as `0x${string}`);
    setLogs(prev => [`> Client Safe: ${addr}`, ...prev]);
  } catch (err: any) {
    console.error('Provider setup error:', err);
    setLogs(prev => [`> ❌ Setup error: ${err.message}`, ...prev]);
  }
};

    setup();
    return () => { if (rpcHandler) rpcHandler.removeAllListeners(); };
  }, [authenticated, wallets]);


  const executeCheckout = async () => {
    const provider = customProviderRef.current;
    if (!provider || !clientSafeAddress) return;
    setIsCheckoutPending(true);
    try {
      await provider.request({
        method: 'eth_sendTransaction',
        params: [{
          from: clientSafeAddress,
          to: USDC_ADDRESS,
          value: '0x0',
          // transfer(0x1111...1111, 1.00 USDC = 1_000_000 units = 0x0F4240)
          data: '0xa9059cbb000000000000000000000000111111111111111111111111111111111111111100000000000000000000000000000000000000000000000000000000000f4240',
        }],
      });
    } catch (err: any) {
      if (err?.code !== 4001) { // 4001 = user rejected, don't log that as an error
        setLogs(prev => [`> ❌ Checkout failed: ${err.message}`, ...prev]);
      }
    } finally {
      setIsCheckoutPending(false);
    }
  };

  const simulatePhysicalCardSwipe = async () => {
    setIsSwipePending(true);
    setLogs(prev => ['> 💳 [VISA RAIL] Card swipe webhook firing...', ...prev]);

    try {
      const response = await fetch('/api/webhook/card', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'usr_9x82Fk4', merchant: 'Starbucks Coffee #482', amountUsd: 1.00 }),
      });

      const data = await response.json();

      if (response.ok) {
        setLogs(prev => [
          `> ✅ [VISA RAIL] Approved!`,
          `> 🔗 Hash: ${data.txHash}`,
          ...prev,
        ]);
        setTimeout(() => refetchServerBalance(), 3000);
      } else {
        setLogs(prev => [`> ❌ [VISA RAIL] Declined: ${data.error}`, ...prev]);
      }
    } catch (err: any) {
      setLogs(prev => [`> ❌ Network error: ${err.message}`, ...prev]);
    } finally {
      setIsSwipePending(false);
    }
  };

  if (!mounted) return null;

  return (
    <div className="min-h-screen bg-[#F0F0F0] text-black font-mono p-4 md:p-8 selection:bg-black selection:text-white">
      <header className="border-b-4 border-black pb-4 mb-8 flex flex-col md:flex-row justify-between items-start md:items-end gap-4">
        <div>
          <h1 className="text-4xl font-black uppercase tracking-tighter bg-black text-white px-2 inline-block">NeoBank // Multi-Channel OS</h1>
          <p className="text-sm font-bold text-gray-600 mt-2">ERC-4337 Advanced Non-Custodial Infrastructure Framework</p>
        </div>
        <div className="text-sm border-2 border-black px-3 py-1 bg-white font-black uppercase shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]">
          Network: Sepolia Testnet
        </div>
      </header>

      <div className="mb-8 border-4 border-black bg-yellow-100 p-4 shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] text-xs md:text-sm">
        <span className="font-black uppercase bg-black text-white px-2 py-0.5 mr-2">Interview Playbook:</span>
        <strong>Left:</strong> Client-side EIP-1193 interceptor via Privy wallet injection.{' '}
        <strong>Right:</strong> Server-side session key relayer — settles physical card swipes on-chain without a wallet popup.
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-8">

        {/* ─── CHANNEL A: Client Side ─── */}
        <div className="bg-white border-4 border-black p-6 shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] flex flex-col">
          <div className="border-b-4 border-black pb-2 mb-6 flex justify-between items-center bg-purple-100 p-2 border-2">
            <h2 className="text-lg font-black uppercase">Channel A // Client Interceptor</h2>
            <span className="text-xs font-bold bg-purple-600 text-white px-2 py-0.5">DAPP CONTEXT</span>
          </div>

          <div className="space-y-6 flex-1 flex flex-col">
            {!authenticated ? (
              <div className="border-2 border-dashed border-gray-400 p-8 text-center bg-gray-50 flex-1 flex flex-col items-center justify-center space-y-4">
                <div className="w-12 h-12 bg-black text-[#00FF41] font-black rounded-full flex items-center justify-center text-xl">1</div>
                <h3 className="font-black uppercase">Initialize Local Smart Account</h3>
                <p className="text-xs text-gray-500 max-w-sm">Connect an external signer (MetaMask, Phantom, email) via Privy.</p>
                <button
                  onClick={login}
                  className="w-full bg-black text-white py-3 border-2 border-black font-black uppercase shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:bg-[#00FF41] hover:text-black transition-all"
                >
                  Connect Signer / Login
                </button>
              </div>
            ) : (
              <div className="space-y-4 flex-1 flex flex-col">
                <div className="bg-purple-50 border-2 border-black p-3 text-xs">
                  <div className="flex justify-between font-bold mb-1">
                    <span className="uppercase text-purple-700">Authenticated Signer (EOA):</span>
                    <button onClick={logout} className="underline hover:text-red-600">Disconnect</button>
                  </div>
                  <span className="font-mono text-gray-700 break-all">{wallets[0]?.address}</span>
                </div>

                <div className="border-4 border-black p-4 bg-[#00FF41]/10 text-center">
                  <span className="text-xs block font-bold text-gray-500 uppercase mb-1">
                    Generated Gnosis Safe (Counterfactual)
                  </span>
                  <span className="font-mono text-xs font-black block break-all bg-white border border-gray-400 p-2 mb-2">
                    {clientSafeAddress || 'Deriving Safe address...'}
                  </span>
                  <div className="inline-block bg-white border border-black px-3 py-1 font-bold text-sm">
                    {/* FIX 1: Now uses useReadContract → actual USDC balanceOf call */}
                    Balance: <span className="font-black text-purple-700">{clientBalanceFormatted} USDC</span>
                  </div>
                  <button
                    onClick={() => refetchClientBalance()}
                    className="block text-[10px] mx-auto uppercase underline font-bold text-gray-500 mt-2 hover:text-black"
                  >
                    Sync Balance
                  </button>
                  {clientSafeAddress && (
                    <p className="text-[10px] text-gray-400 mt-2">
                      Fund this address with Sepolia USDC to test checkout
                    </p>
                  )}
                </div>

                <div className="border-4 border-black p-4 bg-gray-50 flex-1 flex flex-col justify-between">
                  <div className="text-center">
                    <span className="text-xs font-black uppercase bg-black text-white px-2 py-0.5">DApp Merchant Checkout</span>
                    <p className="text-2xl font-black uppercase mt-4">Iced Espresso</p>
                    <p className="text-xl font-black text-gray-600 mt-1">$1.00 USDC</p>
                  </div>

                  <div className="mt-6">
                    {pendingTx ? (
                      <div className="border-2 border-black p-4 bg-white text-left">
                        <p className="text-xs font-black text-purple-600 uppercase mb-2">⚡ Intercepted — Approve in panel below</p>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {!hasEnoughBalance && (
                          <p className="text-[10px] text-red-600 font-bold text-center bg-red-50 border border-red-300 p-2 uppercase">
                            ⚠️ Fund the Safe above with Sepolia USDC first
                          </p>
                        )}
                        <button
                          onClick={executeCheckout}
                          disabled={!hasEnoughBalance || isCheckoutPending || !customProviderRef.current}
                          className="w-full bg-black text-[#00FF41] border-2 border-black py-3 font-black uppercase hover:bg-white hover:text-black transition-colors disabled:opacity-30"
                        >
                          {isCheckoutPending ? 'Routing to Pimlico...' : 'Execute Checkout'}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {pendingTx && (
              <div className="border-4 border-purple-600 p-4 bg-white relative mt-4">
                <span className="absolute -top-3 left-4 bg-purple-600 text-white font-black px-2 text-xs uppercase">Wallet Intercept</span>
                <p className="text-xs font-bold text-gray-500 uppercase">EIP-1193 payload intercepted:</p>
                <p className="text-sm font-black mt-1">Transfer 1.00 USDC via Smart Account</p>
                <div className="flex gap-4 mt-4">
                  <button
                    onClick={async () => {
                      await pendingTx.onApprove();
                      setPendingTx(null);
                      setTimeout(() => refetchClientBalance(), 4000);
                    }}
                    className="flex-1 bg-[#00FF41] border-2 border-black font-black py-2 uppercase text-xs"
                  >
                    Confirm & Sign
                  </button>
                  <button
                    onClick={() => { pendingTx.onReject(); setPendingTx(null); }}
                    className="bg-white border-2 border-black px-4 font-bold text-xs uppercase"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ─── CHANNEL B: Server Side ─── */}
        <div className="bg-white border-4 border-black p-6 shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] flex flex-col">
          <div className="border-b-4 border-black pb-2 mb-6 flex justify-between items-center bg-blue-100 p-2 border-2">
            <h2 className="text-lg font-black uppercase">Channel B // Server-Side Relayer</h2>
            <span className="text-xs font-bold bg-blue-600 text-white px-2 py-0.5">BACKEND CONTEXT</span>
          </div>

          <div className="space-y-6 flex-1 flex flex-col justify-between">
            <div className="space-y-4">
              <div className="border-2 border-black p-4 bg-blue-50/50 text-xs">
                <span className="font-black block uppercase text-blue-800 mb-2">Session Key Architecture:</span>
                <p className="mb-2">
                  The server holds a restricted operator key. When Visa hits the card webhook,
                  the server signs a UserOperation to deduct USDC from its own Safe — no wallet
                  popup required. In production, this key is granted as a session key on the
                  user's Safe via <code>Safe.addOwnerWithThreshold()</code>.
                </p>
                <div className="bg-white p-2 border border-gray-400 font-mono text-[11px] break-all">
                  <span className="font-bold block text-gray-500 mb-1">SERVER OPERATOR (EOA):</span>
                  0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
                </div>
              </div>

              <div className="border-2 border-black bg-gray-50 p-4">
                <div className="flex justify-between items-center mb-1">
                  <span className="text-xs font-bold text-gray-500 uppercase">
                    {/* FIX 2: Address is fetched from /api/webhook/info, not hardcoded */}
                    Server Safe (derived from operator key)
                  </span>
                  <button onClick={() => refetchServerBalance()} className="text-[10px] underline font-bold text-gray-400 hover:text-black">
                    Sync
                  </button>
                </div>
                <span className="font-mono text-xs font-black block break-all bg-white border border-gray-300 p-2 mb-2">
                  {serverSafeAddress || 'Loading...'}
                </span>
                <div className="text-sm font-bold">
                  {/* FIX 1: Also using useReadContract for server balance */}
                  Vault Balance: <span className="font-black text-blue-600">{serverBalanceFormatted} USDC</span>
                </div>
              </div>

              <div className="border-4 border-black border-dashed p-6 bg-gray-50 text-center space-y-4">
                <div className="text-5xl">💳</div>
                <h3 className="font-black uppercase tracking-tight">Visa Terminal Emulator</h3>
                <p className="text-xs text-gray-500 max-w-xs mx-auto">
                  Emulates a physical card tap. Fires a POST to <code>/api/webhook/card</code>.
                  Server signs and settles on-chain using its session key.
                </p>

                {serverSafeAddress && Number(serverBalanceFormatted) < 1.00 && (
                  <p className="text-[10px] text-left text-amber-700 font-bold bg-amber-50 border border-amber-300 p-2 uppercase">
                    💡 Fund <span className="break-all">{serverSafeAddress}</span> with Sepolia USDC to test settlement
                  </p>
                )}

                <button
                  onClick={simulatePhysicalCardSwipe}
                  disabled={isSwipePending}
                  className="w-full bg-blue-600 text-white font-black border-2 border-black py-4 uppercase shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] hover:bg-black transition-all disabled:opacity-50"
                >
                  {isSwipePending ? 'Settling on-chain...' : 'Tap Physical Card ($1.00)'}
                </button>
              </div>
            </div>

            <div className="border-2 border-black bg-black text-[#00FF41] flex flex-col h-44 mt-4">
              <h3 className="font-bold text-[11px] uppercase bg-[#00FF41] text-black px-2 py-1 border-b border-black flex justify-between">
                <span>Relayer Telemetry</span>
                <button onClick={() => setLogs(['> Logs cleared.'])} className="underline font-mono text-[9px] hover:text-red-700">Clear</button>
              </h3>
              <div className="p-3 overflow-y-auto text-[10px] font-mono leading-relaxed flex-1 flex flex-col gap-1">
                {logs.map((log, i) => (
                  <div
                    key={i}
                    className={
                      log.includes('❌') ? 'text-red-400' :
                      log.includes('✅') ? 'text-green-400' :
                      'text-[#00FF41]'
                    }
                  >
                    {log}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}