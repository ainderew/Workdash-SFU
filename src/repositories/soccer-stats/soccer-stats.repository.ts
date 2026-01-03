import { prisma } from "@/prisma.js";
import type { SoccerStats } from "@prisma/client";

export class SoccerStatsRepository {
  async findByUserId(userId: number): Promise<SoccerStats | null> {
    return await prisma.soccerStats.findUnique({
      where: { userId },
    });
  }

  async create(
    userId: number,
    data: { speed: number; kickPower: number; dribbling: number },
  ): Promise<SoccerStats> {
    // Validate total points = 15
    const total = data.speed + data.kickPower + data.dribbling;
    if (total !== 15) {
      throw new Error(`Total points must equal 15, got ${total}`);
    }

    // Validate each stat >= 0
    if (data.speed < 0 || data.kickPower < 0 || data.dribbling < 0) {
      throw new Error("Each stat must be >= 0");
    }

    // Validate each stat is an integer
    if (
      !Number.isInteger(data.speed) ||
      !Number.isInteger(data.kickPower) ||
      !Number.isInteger(data.dribbling)
    ) {
      throw new Error("Each stat must be an integer");
    }

    return await prisma.soccerStats.create({
      data: {
        userId,
        ...data,
      },
    });
  }
}
