import { create } from "zustand";

import {
  createUpdater,
  defaultUpdateGateway,
  type UpdateState,
} from "@/lib/updater";
import { startUpdateProbe } from "@/lib/updateProbe";

/**
 * The update state outlives the panel that starts a check — the settings panel
 * unmounts every time the sidebar switches tabs, and a download in flight must
 * not be forgotten because of that. One controller per app, mirrored into a
 * store the UI can subscribe to.
 */
interface UpdaterStore {
  state: UpdateState;
  check: () => Promise<void>;
  install: () => Promise<void>;
}

const controller = createUpdater(defaultUpdateGateway());

export const useUpdaterStore = create<UpdaterStore>(() => ({
  state: controller.getState(),
  check: () => controller.check(),
  install: () => controller.install(),
}));

controller.subscribe(() => {
  useUpdaterStore.setState({ state: controller.getState() });
});

// Inert unless the build asked for it; see src/lib/updateProbe.ts.
startUpdateProbe(controller);
