import express from "express";
import { requireAuth } from "../auth.js";
import {
  doubleRound,
  getCurrentRound,
  hitRound,
  standRound,
  startRound
} from "../game-service.js";
import { ok } from "../responses.js";

export const gameRouter = express.Router();
gameRouter.use(requireAuth);

gameRouter.post("/start", (req, res) => {
  const data = startRound(req.auth.user_id, Number(req.body?.bet), req.body?.actionId);
  return ok(res, data, data.round.status === "completed" ? data.round.result.message : "Runde gestartet.", 201);
});

gameRouter.post("/hit", (req, res) => {
  const data = hitRound(req.auth.user_id, req.body?.actionId);
  return ok(res, data, data.round.result?.message ?? "Karte gegeben.");
});

gameRouter.post("/stand", (req, res) => {
  const data = standRound(req.auth.user_id, req.body?.actionId);
  return ok(res, data, data.round.result.message);
});

gameRouter.post("/double", (req, res) => {
  const data = doubleRound(req.auth.user_id, req.body?.actionId);
  return ok(res, data, data.round.result.message);
});

gameRouter.get("/current", (req, res) => ok(res, getCurrentRound(req.auth.user_id)));
