import type { Request, Response } from "express";
import { SoccerStatsRepository } from "@/repositories/soccer-stats/soccer-stats.repository.js";
import type { AuthenticatedRequest } from "@/middleware/http-auth.middlware.js";

const soccerStatsRepository = new SoccerStatsRepository();

export const getSoccerStats = async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).userId;

    if (!userId) {
      return res.status(401).json({ error: "User ID missing from token" });
    }

    const stats = await soccerStatsRepository.findByUserId(userId);

    // Return null if no stats exist (triggers modal on client)
    return res.status(200).json(stats);
  } catch (error) {
    console.error("Failed to fetch soccer stats:", error);
    return res.status(500).json({ error: "Failed to fetch soccer stats" });
  }
};

export const createSoccerStats = async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).userId;
    const { speed, kickPower, dribbling } = req.body;

    if (!userId) {
      return res.status(401).json({ error: "User ID missing from token" });
    }

    // Check if stats already exist (prevent overwrite - permanent system)
    const existingStats = await soccerStatsRepository.findByUserId(userId);
    if (existingStats) {
      return res.status(400).json({
        error:
          "Soccer stats already assigned. Stats are permanent and cannot be changed.",
      });
    }

    // Validate input types
    if (
      typeof speed !== "number" ||
      typeof kickPower !== "number" ||
      typeof dribbling !== "number"
    ) {
      return res.status(400).json({
        error: "All stats must be numbers",
      });
    }

    // Repository will validate total = 15 and >= 0
    const newStats = await soccerStatsRepository.create(userId, {
      speed,
      kickPower,
      dribbling,
    });

    return res.status(201).json(newStats);
  } catch (error: any) {
    console.error("Failed to create soccer stats:", error);

    // Return validation errors to client
    if (
      error.message?.includes("Total points") ||
      error.message?.includes("must be")
    ) {
      return res.status(400).json({ error: error.message });
    }

    return res.status(500).json({ error: "Failed to create soccer stats" });
  }
};
