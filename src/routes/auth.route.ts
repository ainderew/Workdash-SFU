import { Router } from "express";
import { syncGoogleUser } from "../controllers/auth/auth.controller.js";

const router = Router();

// POST /api/auth/google-sync
router.post("/google-sync", syncGoogleUser);

export default router;
