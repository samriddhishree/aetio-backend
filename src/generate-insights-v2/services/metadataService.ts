import { hashId } from "../../common/services/utils";
import type {
  DimensionMetadata,
  DimensionValueMetadata,
  Finding,
  V2Table,
} from "../types";

type DimensionType = DimensionMetadata["dimension_type"];
type ValueType = DimensionMetadata["value_type"];

export type NormalizedDimensionValue = {
  canonical_value: string;
  display_value: string;
  parent_canonical_value?: string;
  is_unknown?: boolean;
  is_other?: boolean;
  synonyms?: string[];
};

export type DimensionMetadataRegistry = {
  byId: Map<string, DimensionMetadata>;
  byCanonicalName: Map<string, DimensionMetadata>;
};

type DimensionDefinition = {
  canonical_name: string;
  display_name: string;
  dimension_type: DimensionType;
  value_type: ValueType;
  parent_canonical_name?: string;
  level?: number;
  aliases: string[];
};

const UNKNOWN_VALUE_TOKENS = new Set([
  "unknown",
  "n/a",
  "na",
  "not available",
  "not_applicable",
  "not provided",
  "not specified",
  "unspecified",
  "missing",
  "null",
]);

const OTHER_VALUE_TOKENS = new Set(["other", "others", "misc", "miscellaneous", "all_other"]);

const DIMENSION_DEFINITIONS: Array<
  Omit<DimensionDefinition, "canonical_name" | "display_name" | "aliases"> & {
    canonical_name: string;
    display_name: string;
    aliases: string[];
  }
> = [
  {
    canonical_name: "age_group",
    display_name: "Age Group",
    aliases: ["age", "age_group", "age bucket", "age_bucket", "age band", "age_band", "age range"],
    dimension_type: "ordinal",
    value_type: "string",
  },
  {
    canonical_name: "channel",
    display_name: "Channel",
    aliases: ["channel", "platform", "source", "media channel", "network", "publisher"],
    dimension_type: "categorical",
    value_type: "string",
  },
  {
    canonical_name: "measure",
    display_name: "Measure",
    aliases: ["measure", "metric", "category", "indicator", "stat"],
    dimension_type: "entity",
    value_type: "string",
  },
  {
    canonical_name: "timeframe",
    display_name: "Timeframe",
    aliases: ["time", "timeframe", "time frame", "period", "date", "month", "year", "quarter"],
    dimension_type: "temporal",
    value_type: "string",
  },
  {
    canonical_name: "region",
    display_name: "Region",
    aliases: ["region", "geography", "geo", "location", "market", "country", "state", "city"],
    dimension_type: "geographic",
    value_type: "string",
  },
];

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeKey(value: string): string {
  return compact(value)
    .toLowerCase()
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[_\-/]+/g, " ")
    .replace(/[^a-z0-9+ ]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function toCanonicalToken(value: string): string {
  return normalizeKey(value).replace(/\s+/g, "_");
}

function titleCase(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => (typeof value === "string" ? compact(value) : ""))
        .filter(Boolean),
    ),
  );
}

function normalizeAliasToken(value: string): string {
  return toCanonicalToken(value);
}

function findKnownDimensionDefinition(value: string): DimensionDefinition | undefined {
  const token = normalizeAliasToken(value);
  for (const definition of DIMENSION_DEFINITIONS) {
    const aliasTokens = definition.aliases.map((alias) => normalizeAliasToken(alias));
    if (aliasTokens.includes(token)) {
      return {
        canonical_name: definition.canonical_name,
        display_name: definition.display_name,
        dimension_type: definition.dimension_type,
        value_type: definition.value_type,
        parent_canonical_name: definition.parent_canonical_name,
        level: definition.level,
        aliases: uniqueStrings(definition.aliases),
      };
    }
  }
  return undefined;
}

function inferDimensionDefinition(value: string): DimensionDefinition {
  const known = findKnownDimensionDefinition(value);
  if (known) return known;

  const token = toCanonicalToken(value);
  const rawNormalized = compact(value);

  let dimensionType: DimensionType = "categorical";
  let valueType: ValueType = "string";

  if (/(^is_|^has_|^can_|\bflag\b|\bboolean\b)/.test(token)) {
    dimensionType = "boolean";
    valueType = "boolean";
  } else if (/(date|month|quarter|year|time)/.test(token)) {
    dimensionType = "temporal";
    valueType = "string";
  } else if (/(country|state|city|region|geo|location|market)/.test(token)) {
    dimensionType = "geographic";
  } else if (/(bucket|band|range|tier|rank)/.test(token)) {
    dimensionType = "ordinal";
  } else if (/(entity|person|organization|company|segment)/.test(token)) {
    dimensionType = "entity";
  }

  const hierarchyParts = rawNormalized
    .split(">")
    .map((part) => toCanonicalToken(part))
    .filter(Boolean);
  const canonicalName = hierarchyParts[hierarchyParts.length - 1] || token || "dimension";
  const parentCanonicalName =
    hierarchyParts.length > 1 ? hierarchyParts[hierarchyParts.length - 2] : undefined;

  return {
    canonical_name: canonicalName,
    display_name: titleCase(canonicalName),
    dimension_type: dimensionType,
    value_type: valueType,
    parent_canonical_name: parentCanonicalName,
    level: hierarchyParts.length > 1 ? hierarchyParts.length - 1 : undefined,
    aliases: [compact(value)],
  };
}

function createValueId(dimensionId: string, canonicalValue: string): string {
  return `val_${hashId(`${dimensionId}:${canonicalValue}`)}`;
}

function mergeDimensionValueMetadata(
  left: DimensionValueMetadata,
  right: DimensionValueMetadata,
): DimensionValueMetadata {
  return {
    ...left,
    ...right,
    description: right.description ?? left.description,
    parent_value_id: right.parent_value_id ?? left.parent_value_id ?? null,
    sort_order: right.sort_order ?? left.sort_order,
    is_other: right.is_other ?? left.is_other,
    is_unknown: right.is_unknown ?? left.is_unknown,
    synonyms: uniqueStrings([...(left.synonyms ?? []), ...(right.synonyms ?? [])]),
    raw_source_values: uniqueStrings([
      ...(left.raw_source_values ?? []),
      ...(right.raw_source_values ?? []),
    ]),
  };
}

function mergeAllowedValues(
  left: DimensionValueMetadata[] | undefined,
  right: DimensionValueMetadata[] | undefined,
): DimensionValueMetadata[] {
  const byValueId = new Map<string, DimensionValueMetadata>();

  for (const value of left ?? []) {
    byValueId.set(value.value_id, value);
  }

  for (const value of right ?? []) {
    const existing = byValueId.get(value.value_id);
    byValueId.set(value.value_id, existing ? mergeDimensionValueMetadata(existing, value) : value);
  }

  return Array.from(byValueId.values());
}

function ensureDimensionInRegistry(
  registry: DimensionMetadataRegistry,
  dimension: DimensionMetadata,
): DimensionMetadata {
  registry.byId.set(dimension.dimension_id, dimension);
  registry.byCanonicalName.set(dimension.canonical_name, dimension);
  return dimension;
}

export function normalizeDimensionName(value: string): string {
  const normalized = compact(value);
  if (!normalized) return "";
  return inferDimensionDefinition(normalized).canonical_name;
}

export function isMetadataEligibleDimensionName(value: string): boolean {
  const canonical = normalizeDimensionName(value);
  if (!canonical) return false;
  if (/^unnamed(?:_\d+)?$/.test(canonical)) return false;
  if (/^column_\d+$/.test(canonical)) return false;
  return true;
}

export function normalizeDimensionValue(input: {
  dimensionName: string;
  value: string;
}): NormalizedDimensionValue {
  const dimensionName = normalizeDimensionName(input.dimensionName);
  const rawValue = compact(input.value);
  const normalizedValue = normalizeKey(rawValue);

  if (!rawValue || UNKNOWN_VALUE_TOKENS.has(normalizedValue)) {
    return {
      canonical_value: "unknown",
      display_value: "Unknown",
      is_unknown: true,
      synonyms: uniqueStrings([rawValue]),
    };
  }

  if (OTHER_VALUE_TOKENS.has(normalizedValue)) {
    return {
      canonical_value: "other",
      display_value: "Other",
      is_other: true,
      synonyms: uniqueStrings([rawValue]),
    };
  }

  if (dimensionName === "age_group") {
    const rangeMatch = normalizedValue.match(/(\d{1,3})\s*(?:-|to)\s*(\d{1,3})/);
    if (rangeMatch) {
      const left = Number(rangeMatch[1]);
      const right = Number(rangeMatch[2]);
      if (Number.isFinite(left) && Number.isFinite(right) && left <= right) {
        return {
          canonical_value: `${left}_${right}`,
          display_value: `${left}-${right}`,
          synonyms: uniqueStrings([rawValue]),
        };
      }
    }

    const plusMatch = normalizedValue.match(/(\d{1,3})\s*\+/);
    if (plusMatch) {
      const base = Number(plusMatch[1]);
      if (Number.isFinite(base)) {
        return {
          canonical_value: `${base}_plus`,
          display_value: `${base}+`,
          synonyms: uniqueStrings([rawValue]),
        };
      }
    }
  }

  if (dimensionName === "timeframe") {
    const yearMatch = normalizedValue.match(/\b(19|20)\d{2}\b/);
    if (yearMatch) {
      return {
        canonical_value: yearMatch[0],
        display_value: yearMatch[0],
        synonyms: uniqueStrings([rawValue]),
      };
    }
  }

  const hierarchyParts = rawValue
    .split(">")
    .map((part) => toCanonicalToken(part))
    .filter(Boolean);
  const canonicalValue =
    hierarchyParts[hierarchyParts.length - 1] || toCanonicalToken(rawValue) || "unknown";
  const parentCanonicalValue =
    hierarchyParts.length > 1 ? hierarchyParts[hierarchyParts.length - 2] : undefined;

  return {
    canonical_value: canonicalValue,
    display_value: rawValue,
    parent_canonical_value: parentCanonicalValue,
    synonyms: uniqueStrings([rawValue]),
  };
}

export function mergeDimensionMetadata(
  left: DimensionMetadata,
  right: DimensionMetadata,
): DimensionMetadata {
  const createdAt = left.created_at || right.created_at;
  return {
    ...left,
    ...right,
    created_at: createdAt,
    updated_at: right.updated_at ?? left.updated_at,
    description: right.description ?? left.description,
    parent_dimension_id: right.parent_dimension_id ?? left.parent_dimension_id ?? null,
    level: right.level ?? left.level,
    synonyms: uniqueStrings([...(left.synonyms ?? []), ...(right.synonyms ?? [])]),
    aliases: uniqueStrings([...(left.aliases ?? []), ...(right.aliases ?? [])]),
    tags: uniqueStrings([...(left.tags ?? []), ...(right.tags ?? [])]),
    allowed_values: mergeAllowedValues(left.allowed_values, right.allowed_values),
    status: right.status ?? left.status ?? "active",
  };
}

export function createDimensionMetadataRegistry(
  seedMetadata: DimensionMetadata[] = [],
): DimensionMetadataRegistry {
  const registry: DimensionMetadataRegistry = {
    byId: new Map<string, DimensionMetadata>(),
    byCanonicalName: new Map<string, DimensionMetadata>(),
  };

  for (const metadata of seedMetadata) {
    ensureDimensionInRegistry(registry, metadata);
  }

  return registry;
}

export function listDimensionMetadata(registry: DimensionMetadataRegistry): DimensionMetadata[] {
  return Array.from(registry.byId.values()).sort((left, right) =>
    left.canonical_name.localeCompare(right.canonical_name),
  );
}

export function getOrCreateDimensionMetadata(
  registry: DimensionMetadataRegistry,
  input: {
    dimensionName: string;
    description?: string;
    tags?: string[];
  },
): DimensionMetadata {
  const now = new Date().toISOString();
  const rawDimensionName = compact(input.dimensionName);
  const definition = inferDimensionDefinition(rawDimensionName || "dimension");
  const canonicalName = definition.canonical_name;
  const existing = registry.byCanonicalName.get(canonicalName);

  let parentDimensionId: string | null | undefined;
  if (definition.parent_canonical_name) {
    const parent = getOrCreateDimensionMetadata(registry, {
      dimensionName: definition.parent_canonical_name,
    });
    parentDimensionId = parent.dimension_id;
  }

  const incoming: DimensionMetadata = {
    dimension_id: existing?.dimension_id ?? `dim_${hashId(canonicalName)}`,
    canonical_name: canonicalName,
    display_name: existing?.display_name ?? definition.display_name,
    description: input.description ?? existing?.description,
    parent_dimension_id: parentDimensionId ?? existing?.parent_dimension_id ?? null,
    level: definition.level ?? existing?.level,
    dimension_type: existing?.dimension_type ?? definition.dimension_type,
    value_type: existing?.value_type ?? definition.value_type,
    synonyms: uniqueStrings([
      ...(existing?.synonyms ?? []),
      ...definition.aliases,
      rawDimensionName,
    ]),
    aliases: uniqueStrings([...(existing?.aliases ?? []), ...definition.aliases]),
    allowed_values: existing?.allowed_values ?? [],
    tags: uniqueStrings([...(existing?.tags ?? []), ...(input.tags ?? [])]),
    status: existing?.status ?? "active",
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };

  const merged = existing ? mergeDimensionMetadata(existing, incoming) : incoming;
  return ensureDimensionInRegistry(registry, merged);
}

export function getOrCreateDimensionValueMetadata(
  registry: DimensionMetadataRegistry,
  input: {
    dimensionName: string;
    rawValue: string;
    dimensionId?: string;
    parentRawValue?: string | null;
    sortOrder?: number;
  },
): { dimension: DimensionMetadata; value: DimensionValueMetadata } {
  const dimension = input.dimensionId
    ? registry.byId.get(input.dimensionId) ??
      getOrCreateDimensionMetadata(registry, { dimensionName: input.dimensionName })
    : getOrCreateDimensionMetadata(registry, { dimensionName: input.dimensionName });

  const normalized = normalizeDimensionValue({
    dimensionName: dimension.canonical_name,
    value: input.rawValue,
  });

  const existingValues = dimension.allowed_values ?? [];
  const existing = existingValues.find(
    (value) =>
      value.value_id === createValueId(dimension.dimension_id, normalized.canonical_value) ||
      value.canonical_value === normalized.canonical_value,
  );

  let parentValueId: string | null | undefined = existing?.parent_value_id ?? null;
  const parentRaw = input.parentRawValue ? compact(input.parentRawValue) : "";
  const parentCanonicalValue = parentRaw
    ? normalizeDimensionValue({ dimensionName: dimension.canonical_name, value: parentRaw }).canonical_value
    : normalized.parent_canonical_value;

  if (parentCanonicalValue && parentCanonicalValue !== normalized.canonical_value) {
    const parentValue = getOrCreateDimensionValueMetadata(registry, {
      dimensionName: dimension.canonical_name,
      dimensionId: dimension.dimension_id,
      rawValue: parentRaw || parentCanonicalValue.replace(/_/g, " "),
    });
    parentValueId = parentValue.value.value_id;
  }

  const now = new Date().toISOString();
  const incoming: DimensionValueMetadata = {
    value_id: existing?.value_id ?? createValueId(dimension.dimension_id, normalized.canonical_value),
    canonical_value: normalized.canonical_value,
    display_value: normalized.display_value,
    synonyms: uniqueStrings([...(existing?.synonyms ?? []), ...(normalized.synonyms ?? [])]),
    parent_value_id: parentValueId ?? null,
    sort_order: input.sortOrder ?? existing?.sort_order,
    is_other: normalized.is_other ?? existing?.is_other,
    is_unknown: normalized.is_unknown ?? existing?.is_unknown,
    raw_source_values: uniqueStrings([
      ...(existing?.raw_source_values ?? []),
      compact(input.rawValue),
    ]),
  };

  const mergedValue = existing ? mergeDimensionValueMetadata(existing, incoming) : incoming;
  const mergedDimension = mergeDimensionMetadata(dimension, {
    ...dimension,
    allowed_values: mergeAllowedValues(existingValues, [mergedValue]),
    updated_at: now,
  });
  ensureDimensionInRegistry(registry, mergedDimension);

  return {
    dimension: mergedDimension,
    value: mergedValue,
  };
}

export function extractNormalizedDimensionMetadataFromFindings(input: {
  findings: Finding[];
  existingMetadata?: DimensionMetadata[];
}): {
  metadata: DimensionMetadata[];
  metadataFilters: string[];
  candidateDimensionCount: number;
  canonicalDimensionCount: number;
} {
  const registry = createDimensionMetadataRegistry(input.existingMetadata ?? []);
  let candidateDimensionCount = 0;

  for (const finding of input.findings) {
    for (const dimension of finding.dimensions ?? []) {
      candidateDimensionCount += 1;
      const canonicalDimensionName = normalizeDimensionName(dimension.tag);
      if (!canonicalDimensionName || !isMetadataEligibleDimensionName(canonicalDimensionName)) continue;
      const metadata = getOrCreateDimensionMetadata(registry, {
        dimensionName: canonicalDimensionName,
      });
      getOrCreateDimensionValueMetadata(registry, {
        dimensionName: metadata.canonical_name,
        dimensionId: metadata.dimension_id,
        rawValue: dimension.value,
      });
    }
  }

  const metadata = listDimensionMetadata(registry);
  const metadataFilters = metadata.map((item) => item.canonical_name);

  return {
    metadata,
    metadataFilters,
    candidateDimensionCount,
    canonicalDimensionCount: metadata.length,
  };
}

export function extractNormalizedDimensionMetadataFromTables(input: {
  tables: V2Table[];
  existingMetadata?: DimensionMetadata[];
}): {
  metadata: DimensionMetadata[];
  metadataFilters: string[];
  candidateDimensionCount: number;
  canonicalDimensionCount: number;
} {
  const registry = createDimensionMetadataRegistry(input.existingMetadata ?? []);
  const counts = new Map<string, number>();
  let candidateDimensionCount = 0;

  for (const table of input.tables) {
    if (!Array.isArray(table.headers) || table.headers.length === 0) continue;

    for (const [columnIndex, rawHeader] of table.headers.entries()) {
      const header = compact(rawHeader ?? "");
      const canonical = normalizeDimensionName(header);
      if (!canonical || !isMetadataEligibleDimensionName(canonical)) continue;

      candidateDimensionCount += 1;
      counts.set(canonical, (counts.get(canonical) ?? 0) + 1);

      const metadata = getOrCreateDimensionMetadata(registry, {
        dimensionName: header,
      });

      const sampledValues = (table.rows ?? [])
        .map((row) => compact(row.cells[columnIndex] ?? ""))
        .filter((value) => value.length > 0)
        .slice(0, 40);

      for (const value of sampledValues) {
        getOrCreateDimensionValueMetadata(registry, {
          dimensionName: metadata.canonical_name,
          dimensionId: metadata.dimension_id,
          rawValue: value,
        });
      }
    }
  }

  const metadata = listDimensionMetadata(registry);
  const metadataFilters = Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1])
    .map(([name]) => name);

  return {
    metadata,
    metadataFilters,
    candidateDimensionCount,
    canonicalDimensionCount: metadata.length,
  };
}
