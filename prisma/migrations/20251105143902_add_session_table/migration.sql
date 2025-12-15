-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('ACTIVE', 'ENDED');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "roomSid" TEXT,
    "roomName" TEXT NOT NULL,
    "status" "SessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Session_meetingId_key" ON "Session"("meetingId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_roomSid_key" ON "Session"("roomSid");

-- CreateIndex
CREATE INDEX "Session_roomName_idx" ON "Session"("roomName");
