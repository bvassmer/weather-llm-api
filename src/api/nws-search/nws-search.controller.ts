import { Body, Controller, Inject, Post } from "@nestjs/common";
import { NwsSearchService } from "./nws-search.service.js";
import type { SearchRequest } from "./types.js";

@Controller("nws-alerts")
export class NwsSearchController {
  constructor(
    @Inject(NwsSearchService)
    private readonly nwsSearchService: NwsSearchService,
  ) {}

  @Post("search")
  async search(@Body() body: SearchRequest) {
    return this.nwsSearchService.search(body);
  }
}
