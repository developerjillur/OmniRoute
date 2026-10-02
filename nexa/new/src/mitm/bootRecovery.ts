import path from "node:path";
import { resolveMitmDataDir } from "./dataDir.ts";
import { readBridgeIntent, shouldRecoverBridge } from "./runtimeState.ts";
import { checkDNSEntryForAgent } from "./dns/dnsConfig.ts";
import { checkCertInstalled } from "./cert/install.ts";
import { resolveActiveCertPath } from "./cert/activeCert.ts";
import { pickApiKeyForInternalUse } from "@/lib/db/apiKeys.ts";
import { createLogger } from "@/shared/utils/logger.ts";

const log = createLogger("bridge-recovery");
let timer: ReturnType<typeof setInterval> | undefined;
let recovering = false;

/** Recover an explicitly enabled listener without adding DNS entries or trusting a new CA. */
export function scheduleBridgeRecovery(): void {
  if (process.env.MITM_AUTO_RECOVER !== "true" || timer) return;
  const recover = async () => {
    if (recovering) return;
    recovering = true;
    try {
      const dir = path.join(resolveMitmDataDir(), "mitm");
      const manager = await import("./manager.runtime.ts");
      const status = await manager.getMitmStatus(process.env.MITM_TARGET_AGENT);
      if (!shouldRecoverBridge(process.env, readBridgeIntent(dir), status.running)) return;
      const agent = process.env.MITM_TARGET_AGENT;
      if (!agent || !checkDNSEntryForAgent(agent)) {
        log.warn(
          "Bridge recovery requires the selected agent's existing hosts entries; use dashboard DNS setup."
        );
        return;
      }
      const cert = resolveActiveCertPath(dir, process.env.MITM_ROOT_CA_ENABLED === "true");
      if (!(await checkCertInstalled(cert.certPath))) {
        log.warn(
          "Bridge recovery requires the existing CA to remain trusted; use dashboard trust action."
        );
        return;
      }
      const key = await pickApiKeyForInternalUse("internal-probe");
      if (!key) {
        log.warn("Bridge recovery requires an existing internal API key.");
        return;
      }
      await manager.startMitm(key, "");
      log.info("Recovered the enabled Agent Bridge listener.");
    } catch (err) {
      log.error({ err }, "Bridge recovery failed; the next recovery check will retry.");
    } finally {
      recovering = false;
    }
  };
  timer = setInterval(() => {
    void recover();
  }, 10_000);
  timer.unref();
  void recover();
}
