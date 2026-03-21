import type {
  Insight,
  InsightMetadataEntry,
  MetadataFilter,
  PaginationSlice,
  RankedInsight,
} from "../types";

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "to",
  "was",
  "were",
  "with",
]);

export interface KeywordScore {
  score: number;
  matchedTokens: string[];
  exactPhrase: boolean;
}

export interface MetadataScore {
  score: number;
  matches: string[];
}

export interface ContextLink {
  distance: number;
  relation: "ancestor" | "descendant";
  primaryId: string;
}

export const normalizeText = (value: string): string =>
  value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const tokenize = (value: string): string[] => {
  const normalized = normalizeText(value);
  if (!normalized) return [];

  return normalized
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
};

export const scoreKeywordMatch = (
  text: string,
  normalizedQuery: string,
  queryTokens: string[],
): KeywordScore => {
  const normalizedText = normalizeText(text);
  if (!normalizedText || queryTokens.length === 0) {
    return { score: 0, matchedTokens: [], exactPhrase: false };
  }

  let score = 0;
  const matchedTokens: string[] = [];

  for (const token of queryTokens) {
    const tokenRegex = new RegExp(`\\b${escapeRegex(token)}\\b`, "g");
    const matches = normalizedText.match(tokenRegex);
    const occurrences = matches?.length ?? 0;
    if (occurrences === 0) continue;

    matchedTokens.push(token);
    score += 2.5;
    if (occurrences > 1) {
      score += Math.min(occurrences - 1, 3) * 0.4;
    }
  }

  const exactPhrase = normalizedQuery.length > 2 && normalizedText.includes(normalizedQuery);
  if (exactPhrase) {
    score += 4;
  }

  return { score, matchedTokens, exactPhrase };
};

export const scoreMetadataMatch = (
  metadata: InsightMetadataEntry[] | undefined,
  metadataFilters: MetadataFilter[] | undefined,
  queryTokens: string[],
): MetadataScore => {
  if (!metadata || metadata.length === 0) {
    return { score: 0, matches: [] };
  }

  let score = 0;
  const matches: string[] = [];

  for (const entry of metadata) {
    const tag = normalizeText(entry.tag);
    const value = normalizeText(entry.value);
    const confidence = clamp(entry.confidence ?? 1, 0, 1);

    if (metadataFilters && metadataFilters.length > 0) {
      for (const filter of metadataFilters) {
        const filterTag = normalizeText(filter.tag);
        const filterValue = normalizeText(filter.value ?? "");

        if (!filterTag || tag !== filterTag) continue;

        if (!filterValue) {
          score += 3.5 * confidence;
          matches.push(`${entry.tag}=*`);
          continue;
        }

        if (value === filterValue) {
          score += 6 * confidence;
          matches.push(`${entry.tag}=${entry.value}`);
          continue;
        }

        if (value.includes(filterValue) || filterValue.includes(value)) {
          score += 2.5 * confidence;
          matches.push(`${entry.tag}~${entry.value}`);
        }
      }
    }

    for (const token of queryTokens) {
      const inTag = tag.includes(token);
      const inValue = value.includes(token);
      if (!inTag && !inValue) continue;

      score += inValue ? 1.8 * confidence : 1.1 * confidence;
      matches.push(`${entry.tag}:${entry.value}`);
    }
  }

  return {
    score,
    matches: dedupeStrings(matches),
  };
};

export const metadataSatisfiesFilters = (
  metadata: InsightMetadataEntry[] | undefined,
  filters: MetadataFilter[] | undefined,
): boolean => {
  if (!filters || filters.length === 0) return true;
  if (!metadata || metadata.length === 0) return false;

  const normalizedEntries = metadata.map((entry) => ({
    tag: normalizeText(entry.tag),
    value: normalizeText(entry.value),
  }));

  return filters.every((filter) => {
    const targetTag = normalizeText(filter.tag);
    const targetValue = normalizeText(filter.value ?? "");

    return normalizedEntries.some((entry) => {
      if (entry.tag !== targetTag) return false;
      if (!targetValue) return true;
      return entry.value === targetValue || entry.value.includes(targetValue);
    });
  });
};

export const supportingEvidenceBoost = (insight: Insight): number => {
  const supportCount = insight.supporting_chunks?.length ?? 0;
  return Math.min(supportCount, 5) * 0.25;
};

export const applyHierarchyBoost = (
  links: ContextLink[] | undefined,
): { score: number; distance?: number; primaryIds: Set<string> } => {
  if (!links || links.length === 0) {
    return { score: 0, primaryIds: new Set() };
  }

  let score = 0;
  let minDistance: number | undefined;
  const primaryIds = new Set<string>();

  for (const link of links) {
    primaryIds.add(link.primaryId);
    minDistance = minDistance === undefined ? link.distance : Math.min(minDistance, link.distance);

    const base = link.relation === "ancestor" ? 1.6 : 1.3;
    score += base / Math.max(link.distance, 1);
  }

  if (primaryIds.size > 1) {
    score += Math.min(primaryIds.size - 1, 4) * 0.35;
  }

  return { score, distance: minDistance, primaryIds };
};

export const dedupeInsights = (insights: Insight[]): Insight[] => {
  const byId = new Map<string, Insight>();
  for (const insight of insights) {
    const existing = byId.get(insight.insight_id);
    if (!existing) {
      byId.set(insight.insight_id, insight);
      continue;
    }

    byId.set(insight.insight_id, {
      ...existing,
      ...insight,
      metadata: insight.metadata ?? existing.metadata,
      supporting_chunks: insight.supporting_chunks ?? existing.supporting_chunks,
    });
  }

  return Array.from(byId.values());
};

export const rankInsights = (ranked: RankedInsight[]): RankedInsight[] =>
  ranked
    .filter((item) => item.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (right.directScore !== left.directScore) return right.directScore - left.directScore;
      return left.insight.insight_id.localeCompare(right.insight.insight_id);
    });

export const decodeCursor = (cursor: string | undefined): number => {
  if (!cursor) return 0;

  try {
    const decoded = Buffer.from(cursor, "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as { offset?: unknown };
    if (typeof parsed.offset !== "number") return 0;
    return Math.max(0, Math.floor(parsed.offset));
  } catch {
    return 0;
  }
};

export const encodeCursor = (offset: number): string =>
  Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64");

export const paginate = <T>(
  items: T[],
  limit: number,
  cursor: string | undefined,
): PaginationSlice<T> => {
  const normalizedLimit = clamp(Math.floor(limit), 1, 100);
  const offset = decodeCursor(cursor);
  const sliced = items.slice(offset, offset + normalizedLimit);
  const nextOffset = offset + normalizedLimit;

  return {
    items: sliced,
    nextCursor: nextOffset < items.length ? encodeCursor(nextOffset) : undefined,
  };
};

export const matchesScalarFilters = (
  insight: Insight,
  filters: {
    user_id?: string;
    document_id?: string;
    status?: string;
    parent_insight_id?: string;
  },
): boolean => {
  if (filters.user_id && insight.user_id !== filters.user_id) return false;
  if (filters.document_id && insight.document_id !== filters.document_id) return false;
  if (filters.status && insight.status !== filters.status) return false;
  if (filters.parent_insight_id && insight.parent_insight_id !== filters.parent_insight_id) return false;
  return true;
};

const dedupeStrings = (values: string[]): string[] => Array.from(new Set(values));

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
