import { Router } from "express";
import {
  getSettings,
  updateSettings,
} from "../controllers/settings.controller.js";

const router = Router();

router.get("/", getSettings);
router.patch("/", updateSettings);

export default router;
