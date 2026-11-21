import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { type Health, HealthService } from "./health.service.ts";

@Controller("health")
export class HealthController {
  // Injected by class, with no @Inject: this works only when the compiler emits decorator metadata.
  constructor(private readonly health: HealthService) {}

  @Get()
  async get(): Promise<Health> {
    const health = await this.health.check();
    if (!health.ok) throw new ServiceUnavailableException(health);
    return health;
  }
}
