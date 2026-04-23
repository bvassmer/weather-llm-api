import { AppModule } from "../../src/app.module.js";
import { NwsAdminModule } from "../../src/api/nws-admin/nws-admin.module.js";
import { NwsAnswerModule } from "../../src/api/nws-answer/nws-answer.module.js";
import { NwsEmbeddingsModule } from "../../src/api/nws-embeddings/nws-embeddings.module.js";
import { NwsSearchModule } from "../../src/api/nws-search/nws-search.module.js";
import { PrismaModule } from "../../src/prisma/prisma.module.js";

describe("Module exports", () => {
  it("constructs application module classes", () => {
    expect(new AppModule()).toBeInstanceOf(AppModule);
    expect(new PrismaModule()).toBeInstanceOf(PrismaModule);
    expect(new NwsEmbeddingsModule()).toBeInstanceOf(NwsEmbeddingsModule);
    expect(new NwsSearchModule()).toBeInstanceOf(NwsSearchModule);
    expect(new NwsAnswerModule()).toBeInstanceOf(NwsAnswerModule);
    expect(new NwsAdminModule()).toBeInstanceOf(NwsAdminModule);
  });
});
