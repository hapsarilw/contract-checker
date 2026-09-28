-- AlterTable
ALTER TABLE "JobRun" ADD COLUMN     "lastFailureAt" TIMESTAMP(3),
ADD COLUMN     "lastFailureReason" TEXT,
ALTER COLUMN "lastSuccessAt" DROP NOT NULL;
