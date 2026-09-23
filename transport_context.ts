import { AsyncLocalStorage } from "node:async_hooks";

export interface TransportBindingContext {
  exporter?: (contextValue: Buffer) => Buffer;
  clientId?: string;
  sessionId?: string;
  remoteAddress?: string;
}

const storage = new AsyncLocalStorage<TransportBindingContext>();

export function withTransportBinding<T>(context: TransportBindingContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(context, fn);
}

export function currentTransportBinding(): TransportBindingContext | undefined {
  return storage.getStore();
}
