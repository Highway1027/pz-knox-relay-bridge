// src/logging/KnoxLogger.ts
// v2 - 23-09-2026 - Add concise HTTP and ASCII-safe boundary logging

export type LogBoundary = "INFO" | "ERROR" | "HTTP" | "PZ->BRIDGE" | "BRIDGE->PZ" | "BRIDGE->KNOX";

export class KnoxLogger {
  log(boundary: LogBoundary, message: string): void {
    const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
    console.log(`[${time}] [${boundary}] ${message}`);
  }

  info(message: string): void {
    this.log("INFO", message);
  }

  error(message: string): void {
    this.log("ERROR", message);
  }
}
