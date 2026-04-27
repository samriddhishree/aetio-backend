function isTruthyEnv(name: string): boolean {
  const value = process.env[name];
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

let consolePatched = false;

function patchConsoleWithTimestamps(): void {
  if (consolePatched) return;
  consolePatched = true;

  const methods: Array<"log" | "info" | "warn" | "error" | "debug"> = [
    "log",
    "info",
    "warn",
    "error",
    "debug",
  ];

  for (const method of methods) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      const timestamp = new Date().toISOString();
      if (args.length === 0) {
        original(`[${timestamp}]`);
        return;
      }

      if (typeof args[0] === "string") {
        original(`[${timestamp}] ${args[0]}`, ...args.slice(1));
        return;
      }

      original(`[${timestamp}]`, ...args);
    };
  }
}

export function configureRuntimeLogging(): void {
  // Requirement: v3 debug should always include timestamps.
  if (isTruthyEnv("GENERATE_INSIGHTS_V3_DEBUG")) {
    patchConsoleWithTimestamps();
  }
}

