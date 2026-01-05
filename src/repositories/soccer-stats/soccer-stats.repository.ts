import { prisma } from "@/prisma.js";
import type { SoccerStats } from "@prisma/client";

export class SoccerStatsRepository {
  async findByUserId(userId: number): Promise<SoccerStats | null> {
    return await prisma.soccerStats.findUnique({
      where: { userId },
    });
  }

  async getMatchHistory(userId: number, limit = 20) {
    return await prisma.matchHistory.findMany({
      where: { userId },
      orderBy: { matchDate: "desc" },
      take: limit,
    });
  }

  async updateMmr(
    userId: number,
    data: { mmr: number; winStreak: number },
  ): Promise<SoccerStats> {
    return await prisma.soccerStats.update({
      where: { userId },
      data: {
        mmr: data.mmr,
        winStreak: data.winStreak,
      },
    });
  }

  async addMatchHistory(data: {
    userId: number;
    result: string;
    isMVP: boolean;
    mmrDelta: number;
    newMmr: number;
    goals: number;
    assists: number;
    interceptions: number;
    rankAtTime: string;
    ourScore: number;
    opponentScore: number;
  }) {
    return await prisma.matchHistory.create({
      data,
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
