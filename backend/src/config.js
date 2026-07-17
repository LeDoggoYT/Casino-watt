import "dotenv/config";
import path from "node:path";

function integerFromEnv(name, fallback, minimum, maximum) {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} muss zwischen ${minimum} und ${maximum} liegen.`);
  }
  return value;
}

const frontendOriginInput = process.env.FRONTEND_ORIGIN?.trim();
if (!frontendOriginInput) {
  throw new Error("FRONTEND_ORIGIN muss gesetzt sein.");
}

const adminPassword = process.env.ADMIN_PASSWORD ?? (process.env.NODE_ENV === "production" ? "" : "2011");
if (!adminPassword) {
  throw new Error("ADMIN_PASSWORD muss in der Produktionsumgebung gesetzt sein.");
}

let frontendOrigin;
try {
  // URL.origin entfernt einen versehentlichen abschließenden Slash zuverlässig.
  frontendOrigin = new URL(frontendOriginInput).origin;
} catch {
  throw new Error("FRONTEND_ORIGIN muss eine vollständige http(s)-URL sein.");
}

export const config = Object.freeze({
  port: integerFromEnv("PORT", 3000, 1, 65535),
  nodeEnv: process.env.NODE_ENV ?? "development",
  frontendOrigin,
  databasePath: path.resolve(process.cwd(), process.env.DATABASE_PATH ?? "./data/watt-casino.sqlite"),
  sessionDays: integerFromEnv("SESSION_DAYS", 30, 1, 365),
  bcryptRounds: integerFromEnv("BCRYPT_ROUNDS", 12, 10, 15),
  trustProxy: integerFromEnv("TRUST_PROXY", 0, 0, 10),
  adminPassword
});
