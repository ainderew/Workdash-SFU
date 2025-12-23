import type { Request, Response } from "express";
import { UserService } from "@/services/user.service.js";
import { UserRepository } from "@/repositories/user/user.repository.js";
import type { AuthenticatedRequest } from "@/middleware/http-auth.middlware.js";

const userRepository = new UserRepository();
const userService = new UserService(userRepository);

export const getName = async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).userId;

    if (!userId) {
      return res.status(401).json({ error: "User ID missing from token" });
    }

    const user = await userService.getUser(userId);

    if (!user) {
      return res.status(404).json({ error: "Character not found" });
    }

    return res.status(200).json({ name: user.name });
  } catch (error) {
    console.error("Error fetching character:", error);
    return res.status(500).json({ error: "Failed to fetch character" });
  }
};

export const updateUserName = async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).userId;
    const { name } = req.body;

    if (!userId) {
      return res.status(401).json({ error: "User ID missing from token" });
    }

    // Explicit check before calling service ensures we don't pass undefined
    if (!name || typeof name !== "string") {
      return res
        .status(400)
        .json({ error: "Name is required and must be a string" });
    }

    const updatedUser = await userService.updateName(userId, name);

    return res.status(200).json(updatedUser);
  } catch (error) {
    console.error("Error updating user name:", error);
    if (error instanceof Error && error.message === "Name cannot be empty") {
      return res.status(400).json({ error: error.message });
    }
    return res.status(500).json({ error: "Failed to update user name" });
  }
};
