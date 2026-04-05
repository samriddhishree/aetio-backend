import http from "http";
import type { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.NODE_ENV = "test";

const listInsightsMock = vi.fn();

vi.mock("../common/services/dynamo", () => ({
  deleteAllInsightsWithInsightIds: vi.fn(),
  deleteInsightsByProjectId: vi.fn(),
  getInsightById: vi.fn(),
  listInsights: listInsightsMock,
  persistInsights: vi.fn(),
  updateInsight: vi.fn(),
}));

import { app } from "../index";

const getJson = (
  server: http.Server,
  path: string,
): Promise<{ status: number; body: unknown }> =>
  new Promise((resolve, reject) => {
    const address = server.address() as AddressInfo;

    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: address.port,
        path,
        method: "GET",
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          try {
            resolve({
              status: res.statusCode ?? 0,
              body: raw ? JSON.parse(raw) : {},
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );

    req.on("error", reject);
    req.end();
  });

describe("GET /formatted-insights", () => {
  let server: http.Server;

  beforeAll(async () => {
    server = app.listen(0);
    await new Promise<void>((resolve) => {
      server.on("listening", () => resolve());
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });

  it("returns parent insights with sub_insights from parent_insight_id", async () => {
    listInsightsMock.mockResolvedValueOnce([
      {
        insight_id: "parent-1",
        text: "Parent",
        s3_node: "s3://node/1",
        document_id: "doc-1",
      },
      {
        insight_id: "child-1",
        parent_insight_id: "parent-1",
        text: "Child",
        s3_node: "s3://node/1",
        document_id: "doc-1",
      },
      {
        insight_id: "standalone-1",
        text: "Standalone",
        s3_node: "s3://node/2",
        document_id: "doc-2",
      },
    ]);

    const response = await getJson(server, "/formatted-insights?project_id=proj-1");

    expect(response.status).toBe(200);
    expect(listInsightsMock).toHaveBeenCalledWith({ project_id: "proj-1" });

    const body = response.body as {
      count: number;
      items: Array<Record<string, unknown>>;
    };

    expect(body.count).toBe(3);

    const parent = body.items.find((item) => item.insight_id === "parent-1");
    expect(parent).toBeDefined();
    expect(parent?.sub_insights).toEqual([
      {
        insight_id: "child-1",
        parent_insight_id: "parent-1",
        text: "Child",
        s3_node: "s3://node/1",
        document_id: "doc-1",
      },
    ]);
  });
});
