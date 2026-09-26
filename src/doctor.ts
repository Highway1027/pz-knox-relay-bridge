// src/doctor.ts
// v1 - 26-09-2026 - Add non-secret portability diagnostics command

import { loadConfig } from "./config/KnoxBridgeConfig.js";
import { doctorLines } from "./diagnostics/KnoxDiagnostics.js";

try {
  const lines = await doctorLines(await loadConfig());
  console.log(lines.join("\n"));
  if (lines.some((line) => line.startsWith("FAIL"))) process.exitCode = 1;
} catch (error) {
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
