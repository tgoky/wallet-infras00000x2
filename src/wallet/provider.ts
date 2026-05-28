import { EventEmitter } from 'events';
import { RpcHandler } from './rpc-handler';

export class EIP1193Provider extends EventEmitter {
  public isMetaMask = true; // Fools legacy dApps
  public isCustomWallet = true; 
  
  constructor(private rpcHandler: RpcHandler) {
    super();
  }

  async request(args: { method: string; params?: any[] }) {
    if (!args || typeof args.method !== 'string') {
      throw { code: -32600, message: 'Invalid request object' }; // Standard JSON-RPC error
    }

    try {
      return await this.rpcHandler.handle(args.method, args.params);
    } catch (error: any) {
      // 4001 = User Rejected, -32603 = Internal Error
      throw {
        code: error.code || -32603, 
        message: error.message || 'Internal JSON-RPC error.'
      };
    }
  }
}