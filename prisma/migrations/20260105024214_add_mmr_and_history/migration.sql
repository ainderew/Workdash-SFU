-- AlterTable
ALTER TABLE "SoccerStats" ADD COLUMN     "mmr" INTEGER NOT NULL DEFAULT 500,
ADD COLUMN     "winStreak" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "MatchHistory" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "matchDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "result" TEXT NOT NULL,
    "isMVP" BOOLEAN NOT NULL DEFAULT false,
    "mmrDelta" INTEGER NOT NULL,
    "newMmr" INTEGER NOT NULL,
    "goals" INTEGER NOT NULL DEFAULT 0,
    "assists" INTEGER NOT NULL DEFAULT 0,
    "interceptions" INTEGER NOT NULL DEFAULT 0,
    "rankAtTime" TEXT NOT NULL,

    CONSTRAINT "MatchHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MatchHistory_userId_idx" ON "MatchHistory"("userId");
