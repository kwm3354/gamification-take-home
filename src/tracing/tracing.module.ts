import { Module, type OnApplicationShutdown } from "@nestjs/common";
import { flushOnAppClose } from "./tracing.ts";

/** Flushes pending spans when the app shuts down (see `stopOnAppClose`). */
@Module({})
export class TracingModule implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    await flushOnAppClose();
  }
}
