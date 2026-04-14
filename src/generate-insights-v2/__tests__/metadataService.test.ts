import { describe, expect, it } from "vitest";
import type { Finding } from "../types";
import {
  createDimensionMetadataRegistry,
  extractNormalizedDimensionMetadataFromFindings,
  getOrCreateDimensionMetadata,
  getOrCreateDimensionValueMetadata,
  isMetadataEligibleDimensionName,
  listDimensionMetadata,
  normalizeDimensionName,
  normalizeDimensionValue,
} from "../services/metadataService";

describe("metadataService", () => {
  it("normalizes dimension aliases into canonical names", () => {
    expect(normalizeDimensionName("age")).toBe("age_group");
    expect(normalizeDimensionName("age bucket")).toBe("age_group");
    expect(normalizeDimensionName("age_band")).toBe("age_group");
  });

  it("normalizes age-group values into canonical value IDs", () => {
    expect(
      normalizeDimensionValue({
        dimensionName: "age_group",
        value: "18-24",
      }).canonical_value,
    ).toBe("18_24");
    expect(
      normalizeDimensionValue({
        dimensionName: "age_group",
        value: "Age 18 to 24",
      }).canonical_value,
    ).toBe("18_24");
  });

  it("marks placeholder dimensions as ineligible metadata filters", () => {
    expect(isMetadataEligibleDimensionName("Unnamed: 1")).toBe(false);
    expect(isMetadataEligibleDimensionName("column_3")).toBe(false);
    expect(isMetadataEligibleDimensionName("Store ID")).toBe(true);
  });

  it("supports hierarchical value metadata", () => {
    const registry = createDimensionMetadataRegistry();
    const dimension = getOrCreateDimensionMetadata(registry, {
      dimensionName: "region",
    });

    const leaf = getOrCreateDimensionValueMetadata(registry, {
      dimensionName: "region",
      dimensionId: dimension.dimension_id,
      rawValue: "North America > United States",
    });

    expect(leaf.value.parent_value_id).toBeDefined();

    const metadata = listDimensionMetadata(registry);
    const region = metadata.find((item) => item.canonical_name === "region");
    expect(region?.allowed_values?.some((value) => value.canonical_value === "north_america")).toBe(
      true,
    );
    expect(region?.allowed_values?.some((value) => value.canonical_value === "united_states")).toBe(
      true,
    );
  });

  it("supports hierarchical dimension metadata", () => {
    const registry = createDimensionMetadataRegistry();
    const dimension = getOrCreateDimensionMetadata(registry, {
      dimensionName: "Geography > Country",
    });

    expect(dimension.canonical_name).toBe("country");
    expect(dimension.parent_dimension_id).toBeDefined();
  });

  it("extracts and normalizes metadata from findings", () => {
    const findings: Finding[] = [
      {
        finding_id: "f1",
        text: "Instagram performs best for 18-24",
        dimensions: [
          { tag: "channel", value: "Instagram" },
          { tag: "age", value: "18-24" },
        ],
        supporting_refs: [{ chunk_id: "c1" }],
        source_modality: "table",
      },
      {
        finding_id: "f2",
        text: "Facebook performs best for 30+",
        dimensions: [
          { tag: "channel", value: "Facebook" },
          { tag: "age bucket", value: "30+" },
        ],
        supporting_refs: [{ chunk_id: "c2" }],
        source_modality: "table",
      },
    ];

    const result = extractNormalizedDimensionMetadataFromFindings({ findings });

    expect(result.candidateDimensionCount).toBe(4);
    expect(result.metadataFilters).toContain("channel");
    expect(result.metadataFilters).toContain("age_group");

    const ageDimension = result.metadata.find((item) => item.canonical_name === "age_group");
    expect(ageDimension).toBeDefined();
    expect(ageDimension?.allowed_values?.some((value) => value.canonical_value === "18_24")).toBe(
      true,
    );
    expect(ageDimension?.allowed_values?.some((value) => value.canonical_value === "30_plus")).toBe(
      true,
    );
  });

  it("excludes placeholder dimensions from extracted metadata filters", () => {
    const findings: Finding[] = [
      {
        finding_id: "f1",
        text: "West | 1423 | conversion | 39.1%",
        dimensions: [
          { tag: "Region", value: "West" },
          { tag: "Unnamed: 1", value: "ignore me" },
        ],
        supporting_refs: [{ chunk_id: "c1" }],
        source_modality: "table",
      },
    ];

    const result = extractNormalizedDimensionMetadataFromFindings({ findings });
    expect(result.metadataFilters).toContain("region");
    expect(result.metadataFilters).not.toContain("unnamed_1");
  });
});
