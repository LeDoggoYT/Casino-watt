import "dotenv/config";
import path from "node:path";

function integerFromEnv(name, fallback, minimum, maximum) {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} muss zwischen ${minimum} und ${maximum} liegen.`);
  }
  return value;
}

const frontendOrigin = process.env.FRONTEND_ORIGIN?.trim();
if (!frontendOrigin) {
  throw new Error("FRONTEND_ORIGIN muss gesetzt sein.");
}

export const config = Object.freeze({
  port: integerFromEnv("PORT", 3000, 1, 65535),
  nodeEnv: process.env.NODE_ENV ?? "development",
  frontendOrigin,
  databasePath: path.resolve(process.cwd(), process.env.DATABASE_PATH ?? "./data/watt-casino.sqlite"),
  sessionDays: integerFromEnv("SESSION_DAYS", 30, 1, 365),
  bcryptRounds: integerFromEnv("BCRYPT_ROUNDS", 12, 10, 15),
  trustProxy: integerFromEnv("TRUST_PROXY", 0, 0, 10)
});
