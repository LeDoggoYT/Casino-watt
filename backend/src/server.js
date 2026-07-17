import express from "express";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { config } from "./config.js";
import { cleanupExpiredData } from "./db.js";
import { ApiError, fail, ok } from "./responses.js";
import { authRouter } from "./routes/auth-routes.js";
import { gameRouter } from "./routes/game-routes.js";
import { playerRouter } from "./routes/player-routes.js";
import { activityRouter } from "./routes/activity-routes.js";

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", config.trustProxy);
app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    if (!origin || origin === config.frontendOrigin) return callback(null, true);
    return callback(new ApiError(403, "Diese Frontend-Domain ist nicht freigegeben."));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type"],
  maxAge: 86400
}));
app.use(express.json({ limit: "20kb", strict: true }));

const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 180,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { success: false, data: {}, message: "Zu viele Anfragen. Bitte kurz warten." }
});
const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { success: false, data: {}, message: "Zu viele Anmeldeversuche. Bitte später erneut versuchen." }
});

app.get("/health", (_req, res) => ok(res, { status: "ok" }));
app.use("/api", apiLimiter);
app.use("/api/auth/register", authLimiter);
app.use("/api/auth/login", authLimiter);
app.use("/api/auth", authRouter);
app.use("/api/game", gameRouter);
app.use("/api", playerRouter);
app.use("/api", activityRouter);

app.use((_req, res) => fail(res, 404, "Endpunkt nicht gefunden."));
app.use((error, _req, res, _next) => {
  if (error instanceof ApiError) return fail(res, error.status, error.message);
  if (error?.type === "entity.parse.failed") return fail(res, 400, "Ungültiges JSON.");
  console.error("API-Fehler:", error instanceof Error ? error.message : "Unbekannter Fehler");
  return fail(res, 500, "Die Anfrage konnte nicht verarbeitet werden.");
});

cleanupExpiredData();
setInterval(cleanupExpiredData, 60 * 60_000).unref();

app.listen(config.port, () => {
  console.log(`Watt Casino API läuft auf Port ${config.port}.`);
});
