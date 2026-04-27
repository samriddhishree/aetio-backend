import { describe, expect, it } from "vitest";
import {
  createDimensionMetadataRegistry,
  getOrCreateDimensionMetadata,
} from "../../generate-insights-v2/services/metadataService";
import { generateInsightsV3DefaultToolset } from "../tools";

describe("dimension_id stability", () => {
  it("uses canonical, project-agnostic dimension ids in metadata service", () => {
    const registryA = createDimensionMetadataRegistry();
    const registryB = createDimensionMetadataRegistry();

    const regionA = getOrCreateDimensionMetadata(registryA, { dimensionName: "Region" });
    const regionB = getOrCreateDimensionMetadata(registryB, { dimensionName: "region" });
    const regionAlias = getOrCreateDimensionMetadata(registryB, { dimensionName: "geo" });

    expect(regionA.dimension_id).toBe(regionB.dimension_id);
    expect(regionA.dimension_id).toBe(regionAlias.dimension_id);
  });

  it("keeps dimension_id stable across v3 normalize runs with different family/project context", async () => {
    const draftA = {
      table_id: "table-a",
      family_id: "family-a",
      dimensions: ["Region", "Store Id", "Measure"],
      metric_columns: ["Percentage"],
      row_count: 1,
      rows: [
        {
          row_id: "row-a",
          filter_values: [
            { dimension_name: "Region", value: "West" },
            { dimension_name: "Store Id", value: "1423" },
            { dimension_name: "Measure", value: "conversion" },
          ],
          metric_name: "Percentage",
          metric_value: 39.1,
          metric_unit: "%",
          value_text: "Region: West | Store Id: 1423 | Measure: conversion | Percentage: 39.1%",
          supporting_refs: [{ table_id: "table-a", row_index: 0 }],
        },
      ],
      source_modalities: ["table"] as const,
    };

    const draftB = {
      ...draftA,
      table_id: "table-b",
      family_id: "family-b",
      rows: [
        {
          ...draftA.rows[0],
          row_id: "row-b",
          filter_values: [
            { dimension_name: "region", value: "East" },
            { dimension_name: "store_id", value: "9011" },
            { dimension_name: "measure", value: "conversion" },
          ],
          supporting_refs: [{ table_id: "table-b", row_index: 0 }],
        },
      ],
    };

    const normalizedA = await generateInsightsV3DefaultToolset.normalizeDimensionMetadata(draftA);
    const normalizedB = await generateInsightsV3DefaultToolset.normalizeDimensionMetadata(draftB);

    const regionA = normalizedA.dimensionMetadata.find((entry) => entry.canonical_name === "region");
    const regionB = normalizedB.dimensionMetadata.find((entry) => entry.canonical_name === "region");
    const storeA = normalizedA.dimensionMetadata.find((entry) => entry.canonical_name === "store_id");
    const storeB = normalizedB.dimensionMetadata.find((entry) => entry.canonical_name === "store_id");

    expect(regionA?.dimension_id).toBeDefined();
    expect(storeA?.dimension_id).toBeDefined();
    expect(regionA?.dimension_id).toBe(regionB?.dimension_id);
    expect(storeA?.dimension_id).toBe(storeB?.dimension_id);
  });
});
