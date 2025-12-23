import { Router } from "express";
import { getName, updateUserName } from "../controllers/user.controller.js";

const router = Router();

router.get("/me", getName);
router.patch("/update-name", updateUserName);

export default router;
