-- CreateEnum
CREATE TYPE "ConversationMessageRole" AS ENUM ('user', 'assistant');

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_messages" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "role" "ConversationMessageRole" NOT NULL,
    "position" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_conversations_updated_at" ON "Conversation"("updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "uq_conversation_messages_conversation_position" ON "conversation_messages"("conversation_id", "position");

-- CreateIndex
CREATE INDEX "idx_conversation_messages_conversation_created_at" ON "conversation_messages"("conversation_id", "created_at");

-- AddForeignKey
ALTER TABLE "conversation_messages"
ADD CONSTRAINT "conversation_messages_conversation_id_fkey"
FOREIGN KEY ("conversation_id") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;