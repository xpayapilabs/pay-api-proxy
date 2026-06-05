import type { Store } from "mppx/server";

export interface MppxStoreHandle {
  store: Store.AtomicStore;
  close(): void;
}
