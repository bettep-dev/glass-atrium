// Route barrel — single entry point for main.ts to register all /api/* routes.

import type { FastifyInstance } from "fastify";
import { registerHealthRoute } from "./health.js";
import { registerDashboardRoutes } from "./dashboard.js";
import { registerHealthDetailRoutes } from "./health-detail.js";
import { registerArchitectureRoutes } from "./architecture.js";
import { registerCostRoutes } from "./cost.js";
import { registerAgentsRoutes } from "./agents.js";
import { registerOutcomesRoutes } from "./outcomes.js";
import { registerClaudedDocsRoutes } from "./clauded-docs.js";
// telemetry: skill/agent activation → /api/telemetry/*.
import { registerTelemetryRoutes } from "./telemetry.js";
// improvement: learning + autoagent single dashboard join endpoint.
import { registerImprovementRoutes } from "./improvement.js";
// wiki: dedicated wiki-monitoring page (PG-only, relocation-immune).
import { registerWikiRoutes } from "./wiki.js";
// model-config: "Models & limits" settings screen — per-domain model assignment + USD limits.
import { registerModelConfigRoutes } from "./model-config.js";

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await registerHealthRoute(app);
  await registerDashboardRoutes(app);
  await registerHealthDetailRoutes(app);
  await registerArchitectureRoutes(app);
  await registerCostRoutes(app);
  await registerAgentsRoutes(app);
  await registerOutcomesRoutes(app);
  await registerClaudedDocsRoutes(app);
  await registerTelemetryRoutes(app);
  await registerImprovementRoutes(app);
  await registerWikiRoutes(app);
  await registerModelConfigRoutes(app);
}
