import type { Response, Request } from "express";
import { CharacterService } from "@/services/character.service.js";
import { CharacterRepository } from "@/repositories/character/character.repository.js";
import type { AuthenticatedRequest } from "@/middleware/http-auth.middlware.js";

const characterRepository = new CharacterRepository();
const characterService = new CharacterService(characterRepository);

export const updateCharacter = async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).userId;

    if (!userId) {
      return res.status(401).json({ error: "User ID missing from token" });
    }

    const updateData = req.body;

    const updatedCharacter = await characterService.updateCharacter(
      userId,
      updateData,
    );

    return res.status(200).json(updatedCharacter);
  } catch (error) {
    console.error("Error updating character:", error);
    return res.status(500).json({ error: "Failed to update character" });
  }
};

export const getCharacter = async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).userId;

    if (!userId) {
      return res.status(401).json({ error: "User ID missing from token" });
    }

    const character = await characterService.getCharacter(userId);

    if (!character) {
      return res.status(404).json({ error: "Character not found" });
    }

    return res.status(200).json(character);
  } catch (error) {
    console.error("Error fetching character:", error);
    return res.status(500).json({ error: "Failed to fetch character" });
  }
};
