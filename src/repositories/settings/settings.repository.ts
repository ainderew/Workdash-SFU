import { prisma } from "@/prisma";
import type { UserSettings } from "@prisma/client";

export class SettingsRepository {
  async findByUserId(userId: number): Promise<UserSettings | null> {
    return await prisma.userSettings.findUnique({
      where: { userId },
    });
  }

  async upsert(
    userId: number,
    data: { playBackgroundMusic?: boolean; volume?: number },
  ): Promise<UserSettings> {
    return await prisma.userSettings.upsert({
      where: { userId },
      update: data,
      create: {
        userId,
        ...data,
      },
    });
  }
}
