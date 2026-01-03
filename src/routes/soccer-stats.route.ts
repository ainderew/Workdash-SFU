import { Router } from "express";
import {
  getSoccerStats,
  createSoccerStats,
} from "../controllers/soccer-stats.controller.js";

const router = Router();

router.get("/", getSoccerStats);
router.post("/", createSoccerStats);

export default router;
