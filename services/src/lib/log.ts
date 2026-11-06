/** One JSON line per event, with the service name. */
const service = process.env.SERVICE ?? process.argv[2] ?? "parry";

function line(level: string, msg: string, data?: Record<string, unknown>) {
  const out = { t: new Date().toISOString(), level, service, msg, ...data };
  (level === "error" ? console.error : console.log)(JSON.stringify(out));
}

export const log = {
  info: (msg: string, data?: Record<string, unknown>) => line("info", msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => line("warn", msg, data),
  error: (msg: string, data?: Record<string, unknown>) => line("error", msg, data),
};

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 500);
