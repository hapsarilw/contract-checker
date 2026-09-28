-- CreateTable
CREATE TABLE "JobRun" (
    "job" TEXT NOT NULL,
    "lastSuccessAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobRun_pkey" PRIMARY KEY ("job")
);
