import { Router } from "express";
import {
  updateCharacter,
  getCharacter,
} from "../controllers/character.controller.js";

const router = Router();

router.get("/me", getCharacter);
router.post("/update", updateCharacter);

export default router;
