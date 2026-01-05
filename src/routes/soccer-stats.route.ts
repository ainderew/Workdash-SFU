import { Router } from "express";
import {
  getSoccerStats,
  createSoccerStats,
  getMatchHistory,
} from "../controllers/soccer-stats.controller.js";

const router = Router();

router.get("/", getSoccerStats);
router.post("/", createSoccerStats);
router.get("/history", getMatchHistory);

export default router;
