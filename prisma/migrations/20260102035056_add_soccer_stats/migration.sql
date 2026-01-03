-- CreateTable
CREATE TABLE "SoccerStats" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "speed" INTEGER NOT NULL DEFAULT 0,
    "kickPower" INTEGER NOT NULL DEFAULT 0,
    "dribbling" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SoccerStats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SoccerStats_userId_key" ON "SoccerStats"("userId");

-- CreateIndex
CREATE INDEX "SoccerStats_userId_idx" ON "SoccerStats"("userId");

-- AddForeignKey
ALTER TABLE "SoccerStats" ADD CONSTRAINT "SoccerStats_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
