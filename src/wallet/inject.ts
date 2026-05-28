import { EIP1193Provider } from './provider';

export function injectProvider(provider: EIP1193Provider) {
  const info = {
    uuid: crypto.randomUUID(),
    name: 'NeoBank Core',
    icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iYmxhY2siPjxjaXJjbGUgY3g9IjEyIiBjeT0iMTIiIHI9IjEwIi8+PC9zdmc+',
    rdns: 'com.neobank.core',
  };

  const announce = () => {
    window.dispatchEvent(
      new CustomEvent('eip6963:announceProvider', {
        detail: Object.freeze({ info, provider }),
      })
    );
  };

  // Announce via EIP-6963 (modern multi-wallet standard)
  announce();
  window.addEventListener('eip6963:requestProvider', announce);

 
  if (!(window as any).ethereum) {
    (window as any).ethereum = provider;
  }
}