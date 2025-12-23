/*
  Warnings:

  - You are about to drop the column `accesoryId` on the `Character` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Character" DROP COLUMN "accesoryId",
ADD COLUMN     "accessoryId" INTEGER;
