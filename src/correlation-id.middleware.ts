import { Injectable, NestMiddleware } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const correlationId =
      (req.headers["x-correlation-id"] as string | undefined) ?? undefined;

    if (correlationId) {
      res.setHeader("x-correlation-id", correlationId);
    }

    next();
  }
}
