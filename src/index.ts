// src/index.ts
// v3 - 24-09-2026 - Start the telemetry and mission transport Bridge

import { loadConfig } from "./config/KnoxBridgeConfig.js";
import { KnoxLogger } from "./logging/KnoxLogger.js";
import { KnoxSyncEngine } from "./sync/KnoxSyncEngine.js";

const logger = new KnoxLogger();

try {
  const config = await loadConfig();
  const engine = new KnoxSyncEngine(config, logger);
  await engine.initialize();
  logger.info(`Knox Bridge v${config.connectorVersion} starting (telemetry + mission transport)`);
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
