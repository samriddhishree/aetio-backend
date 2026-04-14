import type {
  DimensionMetadata,
  MetadataDimension,
} from "../types";
import {
  isMetadataEligibleDimensionName,
  normalizeDimensionName,
} from "./metadataService";

const RESULTANT_DIMENSION_PATTERNS = [
  /(^|_)(measure|metric|value|values|result|results|resultant|ordinate)(_|$)/,
  /(^|_)(rate|ratio|percentage|percent|amount|score|total|count)(_|$)/,
  /(^|_)(evidence|confidence|probability|likelihood)(_|$)/,
  /(^|_)(y|y_axis|yaxis|dependent|outcome|output)(_|$)/,
];

export function isResultantMetadataField(tag: string): boolean {
  const canonical = normalizeDimensionName(tag);
  if (!canonical) return false;
  return RESULTANT_DIMENSION_PATTERNS.some((pattern) => pattern.test(canonical));
}

export function resolveValidMetadataFields(input: {
  metadataFilters: string[];
  dimensionMetadata: DimensionMetadata[];
}): Set<string> {
  const candidates = new Set<string>();

  for (const filter of input.metadataFilters ?? []) {
    const canonical = normalizeDimensionName(filter);
    if (!canonical || !isMetadataEligibleDimensionName(canonical)) continue;
    if (isResultantMetadataField(canonical)) continue;
    candidates.add(canonical);
  }

  for (const dimension of input.dimensionMetadata ?? []) {
    const canonical = normalizeDimensionName(dimension.canonical_name);
    if (!canonical || !isMetadataEligibleDimensionName(canonical)) continue;
    if (isResultantMetadataField(canonical)) continue;
    candidates.add(canonical);
  }

  return candidates;
}

export function isAllowedMetadataDimensionTag(tag: string, validMetadataFields: Set<string>): boolean {
  const canonical = normalizeDimensionName(tag);
  if (!canonical || !isMetadataEligibleDimensionName(canonical)) return false;
  if (isResultantMetadataField(canonical)) return false;
  if (validMetadataFields.size === 0) return true;
  return validMetadataFields.has(canonical);
}

export function filterDimensionsToValidMetadata(
  dimensions: MetadataDimension[],
  validMetadataFields: Set<string>,
): MetadataDimension[] {
  if (validMetadataFields.size === 0) return dimensions;
  return dimensions.filter((dimension) =>
    isAllowedMetadataDimensionTag(dimension.tag, validMetadataFields)
  );
}
