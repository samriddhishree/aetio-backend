import express, { Request, Response } from "express";
import crypto from "crypto";
import { handler, type GenerateInsightsArguments } from "./generate-insights/handler";

type GenerateInsightsResponse = {
  status: "accepted";
  requestId: string;
};

const app = express();
const port = Number(process.env.PORT ?? 8000);

app.use(express.json());

app.post("/generateInsights", async (req: Request, res: Response) => {
  const payload = req.body as GenerateInsightsArguments;
  console.log("payload", payload)
  if (!payload?.userId) {
    return res.status(400).json({ error: "userId is required" });
  }
  if (!payload?.outputUrls || payload.outputUrls.length === 0) {
    return res.status(400).json({ error: "outputUrls is required" });
  }

  const requestId = req.header("x-request-id") ?? crypto.randomUUID();

  try {
    const result = await handler({ arguments: payload });
    const parsed = JSON.parse(result) as Record<string, unknown>;
    return res.status(202).json({
      status: "accepted",
      requestId,
      ...parsed,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({ error: message, requestId });
  }
});

app.listen(port, () => {
  console.log(`Aetio backend listening on port ${port}`);
});
