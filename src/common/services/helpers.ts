import type { Insight, InsightMetadataEntry, MetadataFilter } from "../../types";

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

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
