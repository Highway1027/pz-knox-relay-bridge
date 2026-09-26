// src/index.ts
// v4 - 26-09-2026 - Add portable first-run setup and safe startup diagnostics

import { loadConfig } from "./config/KnoxBridgeConfig.js";
import { startupDiagnostics, validateExchangeParent } from "./diagnostics/KnoxDiagnostics.js";
import { KnoxLogger } from "./logging/KnoxLogger.js";
import { ensureCredentials } from "./setup/KnoxSetup.js";
import { KnoxSyncEngine } from "./sync/KnoxSyncEngine.js";

const logger = new KnoxLogger();

try {
  await ensureCredentials();
  const config = await loadConfig();
  for (const line of startupDiagnostics(config)) logger.info(line);
  await validateExchangeParent(config);
  const engine = new KnoxSyncEngine(config, logger);
  await engine.initialize();
  logger.info("Exchange directory available");
  logger.info(`Knox Bridge v${config.connectorVersion} ready (telemetry + mission transport)`);
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
