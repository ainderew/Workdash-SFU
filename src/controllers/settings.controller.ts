import type { Request, Response } from "express";
import { SettingsRepository } from "@/repositories/settings/settings.repository.js";
import type { AuthenticatedRequest } from "@/middleware/http-auth.middlware.js";

const settingsRepository = new SettingsRepository();

export const getSettings = async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).userId;

    if (!userId) {
      return res.status(401).json({ error: "User ID missing from token" });
    }

    const settings = await settingsRepository.findByUserId(userId);

    if (!settings) {
      return res.status(200).json(null);
    }

    return res.status(200).json(settings);
  } catch {
    return res.status(500).json({ error: "Failed to fetch settings" });
  }
};

export const updateSettings = async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).userId;
    const { playBackgroundMusic, volume } = req.body;

    if (!userId) {
      return res.status(401).json({ error: "User ID missing from token" });
    }

    const updateData: { playBackgroundMusic?: boolean; volume?: number } = {};

    if (playBackgroundMusic !== undefined) {
      if (typeof playBackgroundMusic !== "boolean") {
        return res.status(400).json({
          error: "playBackgroundMusic must be a boolean",
        });
      }
      updateData.playBackgroundMusic = playBackgroundMusic;
    }

    if (volume !== undefined) {
      if (typeof volume !== "number" || volume < 0 || volume > 1) {
        return res.status(400).json({
          error: "volume must be a number between 0 and 1",
        });
      }
      updateData.volume = volume;
    }

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({
        error: "At least one field is required",
      });
    }

    const updatedSettings = await settingsRepository.upsert(userId, updateData);

    return res.status(200).json(updatedSettings);
  } catch {
    return res.status(500).json({ error: "Failed to update settings" });
  }
};
