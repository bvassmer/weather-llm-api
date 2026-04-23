import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Query,
} from "@nestjs/common";
import { NwsAlertsService } from "./nws-alerts.service.js";
import type { ListAlertsQuery, UpdateAlertRequest } from "./types.js";

@Controller("nws-alerts/alerts")
export class NwsAlertsController {
  constructor(
    @Inject(NwsAlertsService)
    private readonly nwsAlertsService: NwsAlertsService,
  ) {}

  @Get()
  async listAlerts(@Query() query: ListAlertsQuery) {
    return this.nwsAlertsService.listAlerts(query);
  }

  @Get(":id")
  async getAlertById(@Param("id") id: string) {
    return this.nwsAlertsService.getAlertById(id);
  }

  @Patch(":id")
  async updateAlertById(
    @Param("id") id: string,
    @Body() body: UpdateAlertRequest,
  ) {
    return this.nwsAlertsService.updateAlertById(id, body);
  }

  @Delete(":id")
  async deleteAlertById(@Param("id") id: string) {
    return this.nwsAlertsService.deleteAlertById(id);
  }
}
