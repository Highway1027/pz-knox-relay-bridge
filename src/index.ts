// src/index.ts
// v2 - 23-09-2026 - Start the Phase 2 HTTPS-enabled Knox Relay Bridge

import { loadConfig } from "./config/KnoxBridgeConfig.js";
import { KnoxLogger } from "./logging/KnoxLogger.js";
import { KnoxSyncEngine } from "./sync/KnoxSyncEngine.js";

const logger = new KnoxLogger();

try {
  const config = await loadConfig();
  const engine = new KnoxSyncEngine(config, logger);
  await engine.initialize();
  logger.info(`Knox Bridge v${config.connectorVersion} starting (Phase 2 HTTPS ping)`);
  engine.start();

  const shutdown = (): void => {
    engine.stop();
    logger.info("Knox Bridge stopped");
    process.exitCode = 0;
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
} catch (error) {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
