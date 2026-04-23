import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import {
  Prisma,
  type Conversation,
  type ConversationMessage,
} from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service.js";
import type {
  ConversationHistoryMode,
  ConversationMessageMetadata,
  ConversationResponse,
  LatestConversationResponse,
} from "./types.js";

type ConversationWithMessages = Prisma.ConversationGetPayload<{
  include: {
    messages: {
      orderBy: {
        position: "asc";
      };
    };
  };
}>;

interface ConversationPromptMessage {
  role: "user" | "assistant";
  content: string;
}

type ConversationMessageRoleValue = ConversationMessage["role"];

@Injectable()
export class NwsConversationService {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
  ) {}

  async getLatestConversationResponse(): Promise<LatestConversationResponse> {
    const conversation = await this.getLatestConversationRecord();
    return {
      conversation: conversation ? this.toConversationResponse(conversation) : null,
    };
  }

  async loadPromptContext(options: {
    conversationId?: string;
    historyMode: ConversationHistoryMode;
  }): Promise<{
    conversationId: string | null;
    messages: ConversationPromptMessage[];
  }> {
    const conversation = options.conversationId
      ? await this.requireConversation(options.conversationId)
      : await this.getLatestConversation();

    if (!conversation) {
      return {
        conversationId: null,
        messages: [],
      };
    }

    if (options.historyMode === "none") {
      return {
        conversationId: conversation.id,
        messages: [],
      };
    }

    const take = options.historyMode === "last-turn" ? 2 : 10;
    const messages = await this.prisma.conversationMessage.findMany({
      where: {
        conversationId: conversation.id,
      },
      orderBy: {
        position: "desc",
      },
      take,
    });

    return {
      conversationId: conversation.id,
      messages: [...messages].reverse().map((message) => ({
        role: this.toRoleValue(message.role),
        content: message.content,
      })),
    };
  }

  async appendCompletedTurn(input: {
    conversationId?: string | null;
    question: string;
    answer: string;
    userMetadata?: ConversationMessageMetadata;
    assistantMetadata?: ConversationMessageMetadata;
  }): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      const existingConversation = input.conversationId
        ? await tx.conversation.findUnique({
            where: {
              id: input.conversationId,
            },
          })
        : await tx.conversation.findFirst({
            orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
          });

      if (input.conversationId && !existingConversation) {
        throw new BadRequestException("conversationId does not reference an existing conversation");
      }

      const conversation =
        existingConversation ??
        (await tx.conversation.create({
          data: {},
        }));

      const latestMessage = await tx.conversationMessage.findFirst({
        where: {
          conversationId: conversation.id,
        },
        orderBy: {
          position: "desc",
        },
        select: {
          position: true,
        },
      });

      const nextPosition = (latestMessage?.position ?? 0) + 1;

      await tx.conversationMessage.create({
        data: {
          conversationId: conversation.id,
          role: "user",
          position: nextPosition,
          content: input.question,
          ...(input.userMetadata != null
            ? {
                metadata: this.toJsonValue(input.userMetadata),
              }
            : {}),
        },
      });

      await tx.conversationMessage.create({
        data: {
          conversationId: conversation.id,
          role: "assistant",
          position: nextPosition + 1,
          content: input.answer,
          ...(input.assistantMetadata != null
            ? {
                metadata: this.toJsonValue(input.assistantMetadata),
              }
            : {}),
        },
      });

      await tx.conversation.update({
        where: {
          id: conversation.id,
        },
        data: {
          updatedAt: new Date(),
        },
      });

      return conversation.id;
    });
  }

  private async getLatestConversationRecord(): Promise<ConversationWithMessages | null> {
    return this.prisma.conversation.findFirst({
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      include: {
        messages: {
          orderBy: {
            position: "asc",
          },
        },
      },
    });
  }

  private async getLatestConversation(): Promise<Conversation | null> {
    return this.prisma.conversation.findFirst({
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    });
  }

  private async requireConversation(id: string): Promise<Conversation> {
    const conversation = await this.prisma.conversation.findUnique({
      where: {
        id,
      },
    });

    if (!conversation) {
      throw new BadRequestException("conversationId does not reference an existing conversation");
    }

    return conversation;
  }

  private toConversationResponse(
    conversation: ConversationWithMessages,
  ): ConversationResponse {
    return {
      id: conversation.id,
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString(),
      messages: conversation.messages.map((message) =>
        this.toConversationMessageResponse(message),
      ),
    };
  }

  private toConversationMessageResponse(message: ConversationMessage) {
    return {
      id: message.id,
      role: this.toRoleValue(message.role),
      content: message.content,
      metadata:
        message.metadata == null
          ? undefined
          : (message.metadata as ConversationMessageMetadata),
      createdAt: message.createdAt.toISOString(),
      updatedAt: message.updatedAt.toISOString(),
    };
  }

  private toRoleValue(role: ConversationMessageRoleValue): "user" | "assistant" {
    return role === "assistant" ? "assistant" : "user";
  }

  private toJsonValue(value: ConversationMessageMetadata): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}