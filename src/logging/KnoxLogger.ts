// src/logging/KnoxLogger.ts
// v4 - 26-09-2026 - Allow secrets to be registered after startup logging begins

export type LogBoundary = "INFO" | "ERROR" | "HTTP" | "PZ->BRIDGE" | "BRIDGE->PZ" | "BRIDGE->KNOX" | "KNOX->BRIDGE";
export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";
export interface KnoxLogEvent { timestamp: string; level: LogLevel; message: string; context?: unknown }
export type KnoxLogListener = (event: KnoxLogEvent) => void;

const SECRET_KEYS = /token|secret|authorization|password|credential/i;

export function sanitizeLogValue(value: unknown, secrets: string[] = [], seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") {
    return secrets.filter(Boolean).reduce((text, secret) => text.split(secret).join("[REDACTED]"), value);
  }
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeLogValue(item, secrets, seen));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEYS.test(key) ? "[REDACTED]" : sanitizeLogValue(item, secrets, seen)]));
}

export class KnoxLogger {
  private readonly listeners = new Set<KnoxLogListener>();
  constructor(private readonly secrets: string[] = [], private readonly writeToConsole = true) {}

  addSecret(secret: string): void { if (secret && !this.secrets.includes(secret)) this.secrets.push(secret); }

  subscribe(listener: KnoxLogListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(level: LogLevel, message: string, context?: unknown): void {
    const event: KnoxLogEvent = {
      timestamp: new Date().toISOString(),
      level,
      message: String(sanitizeLogValue(message, this.secrets)),
      ...(context === undefined ? {} : { context: sanitizeLogValue(context, this.secrets) }),
    };
    if (this.writeToConsole) console.log(`[${event.timestamp.slice(11, 19)}] [${level}] ${event.message}`);
    for (const listener of this.listeners) listener(event);
  }

  log(boundary: LogBoundary, message: string): void { this.emit(boundary === "ERROR" ? "ERROR" : "INFO", `${boundary}: ${message}`); }
  debug(message: string, context?: unknown): void { this.emit("DEBUG", message, context); }
  info(message: string, context?: unknown): void { this.emit("INFO", message, context); }
  warn(message: string, context?: unknown): void { this.emit("WARN", message, context); }
  error(message: string, context?: unknown): void { this.emit("ERROR", message, context); }
}
