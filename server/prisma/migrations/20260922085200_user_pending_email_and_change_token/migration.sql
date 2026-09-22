-- AlterEnum
ALTER TYPE "AuthTokenType" ADD VALUE 'EMAIL_CHANGE';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "pendingEmail" TEXT;
