import type { CharacterUpdateInput } from "@/generated/prisma/models";
import { prisma } from "@/prisma";
import type { Character, CharacterType } from "@prisma/client";

export class CharacterRepository {
  async create(
    userId: number,
    name: string,
    type: CharacterType,
  ): Promise<Character> {
    return await prisma.character.create({
      data: {
        userId,
        name,
        type,
        bodyId: 1,
        eyesId: 1,
        hairstyleId: 1,
        outfitId: 1,
        itemId: null,
        itemType: null,
      },
    });
  }

  async findByUserId(userId: number): Promise<Character | null> {
    return await prisma.character.findUnique({
      where: { userId },
    });
  }

  async update(userId: number, data: CharacterUpdateInput): Promise<Character> {
    return await prisma.character.update({
      where: { userId },
      data,
    });
  }
}
