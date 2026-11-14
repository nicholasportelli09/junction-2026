import { getConfig } from "@/lib/agent/config";
import { ensureResearch } from "@/lib/agent/research";
import { primeCustomers, warmUp } from "@/lib/agent/warm";
import { DEMO_CUSTOMERS } from "@/lib/finance/data";
import { withVisitor } from "@/lib/agent/visitor";

export const runtime = "nodejs";

// The frontend calls this once when the app opens. It opens connections to the model and voice services,
// starts (or refreshes) electricity offer research for the demo cities so it is ready before anyone asks,
// and reports whether the server is in mock mode so the UI can show a "mock data" label.
export const GET = withVisitor(async function GET() {
  const started = Date.now();
  const cities = [...new Set(DEMO_CUSTOMERS.map((customer) => customer.area))];
  cities.forEach((city) => ensureResearch("electricity", city)); // shared and non-personal: bill type and city only
  await Promise.all([warmUp(), primeCustomers()]);
  const config = getConfig();
  return Response.json({
    ok: true,
    provider: config.provider,
    mock: config.isMock,
    model: config.model.name,
    backup: config.fallbackModel?.provider ?? null,
    tookMs: Date.now() - started,
  });
});
