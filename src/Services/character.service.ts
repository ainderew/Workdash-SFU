import type { CharacterType, ItemType } from "@/generated/prisma/enums";
import type { CharacterRepository } from "@/repositories/character/character.repository";

interface UpdateCharacterDTO {
  name?: string;
  type?: CharacterType;
  bodyId?: number;
  eyesId?: number;
  hairstyleId?: number;
  outfitId?: number;
  accessoryId?: number;
  itemId?: number | null;
  itemType?: ItemType | null;
}

export class CharacterService {
  characterRepository: CharacterRepository;
  constructor(characterRepository: CharacterRepository) {
    this.characterRepository = characterRepository;
  }

  async updateCharacter(userId: number, data: UpdateCharacterDTO) {
    const updatedCharacter = await this.characterRepository.update(
      userId,
      data,
    );
    return updatedCharacter;
  }
  async createDefaultCharacter(userId: number, name: string) {
    return await this.characterRepository.create(userId, name, "ADULT");
  }

  async getCharacter(userId: number) {
    return await this.characterRepository.findByUserId(userId);
  }
}
