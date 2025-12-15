-- CreateEnum
CREATE TYPE "FeedbackSeverity" AS ENUM ('info', 'warning', 'critical');

-- CreateEnum
CREATE TYPE "FeedbackType" AS ENUM ('volume_baixo', 'volume_alto', 'silencio_prolongado', 'tendencia_emocional_negativa', 'engajamento_baixo', 'overlap_fala', 'monologo_prolongado');

-- CreateTable
CREATE TABLE "FeedbackEvent" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "type" "FeedbackType" NOT NULL,
    "severity" "FeedbackSeverity" NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "FeedbackEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FeedbackEvent_meetingId_ts_idx" ON "FeedbackEvent"("meetingId", "ts");

-- CreateIndex
CREATE INDEX "FeedbackEvent_expiresAt_idx" ON "FeedbackEvent"("expiresAt");
