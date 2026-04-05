import { hashId } from "../../common/services/utils";
import type {
  GenerateInsightsV2State,
  V2Chunk,
  V2ExtractedElement,
  V2NormalizedDocument,
  V2Table,
  V2TableRow,
} from "../types";

function getNumber(metadata: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const raw = metadata[key];
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "string") {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function getString(metadata: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function isTableElement(element: V2ExtractedElement): boolean {
  const hasTableHtml =
    typeof element.metadata.text_as_html === "string" && element.metadata.text_as_html.length > 0;
  return element.type.toLowerCase().includes("table") || hasTableHtml;
}

function stripHtmlTags(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"');
}

function parseDelimitedRows(rawText: string): string[][] {
  const lines = rawText
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length <= 1) return [];
  const firstLine = lines[0] ?? "";
  const delimiter = firstLine.includes("\t")
    ? "\t"
    : firstLine.includes("|")
      ? "|"
      : firstLine.includes(",")
        ? ","
        : "";

  if (!delimiter) return [];
  return lines.map((line) =>
    line
      .split(delimiter)
      .map((cell) => cell.trim())
      .filter((cell) => cell.length > 0),
  );
}

function parseHtmlTable(html: string): { headers: string[]; rows: V2TableRow[] } {
  const rowMatches = html.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
  if (rowMatches.length === 0) {
    return { headers: [], rows: [] };
  }

  let headers: string[] = [];
  const rows: V2TableRow[] = [];

  for (const [rowIndex, rowHtml] of rowMatches.entries()) {
    const hasHeaderCells = /<th[\s>]/i.test(rowHtml);
    const cellMatches = rowHtml.match(/<t[hd][\s\S]*?<\/t[hd]>/gi) ?? [];
    const cells = cellMatches
      .map((cellHtml) => decodeHtmlEntities(stripHtmlTags(cellHtml)))
      .map((value) => value.trim())
      .filter(Boolean);

    if (cells.length === 0) continue;

    if (hasHeaderCells && headers.length === 0) {
      headers = cells;
      continue;
    }

    rows.push({
      row_index: rows.length,
      cells,
    });

    if (rowIndex === 0 && headers.length === 0) {
      headers = cells.map((_cell, index) => `column_${index + 1}`);
    }
  }

  return { headers, rows };
}

function buildTableFromElement(
  documentId: string,
  sourceUri: string,
  sectionTitle: string | undefined,
  element: V2ExtractedElement,
  index: number,
): V2Table | null {
  const metadata = element.metadata;
  const rawText = element.text.trim();
  const html =
    typeof metadata.text_as_html === "string" && metadata.text_as_html.trim().length > 0
      ? metadata.text_as_html
      : undefined;

  let headers: string[] = [];
  let rows: V2TableRow[] = [];

  if (html) {
    const parsed = parseHtmlTable(html);
    headers = parsed.headers;
    rows = parsed.rows;
  }

  if (rows.length === 0 && rawText.length > 0) {
    const delimitedRows = parseDelimitedRows(rawText);
    if (delimitedRows.length > 1) {
      const [first, ...rest] = delimitedRows;
      headers = first.map((cell, cellIndex) => cell || `column_${cellIndex + 1}`);
      rows = rest.map((cells, rowIndex) => ({ row_index: rowIndex, cells }));
    }
  }

  if (rawText.length === 0 && rows.length === 0) {
    return null;
  }

  return {
    table_id: hashId(`${documentId}:table:${element.element_id}:${index}`),
    document_id: documentId,
    source_uri: sourceUri,
    page: getNumber(metadata, "page_number", "page"),
    section_title: sectionTitle,
    element_type: element.type,
    sheet_name: getString(metadata, "sheet_name", "page_name"),
    table_region: getString(metadata, "coordinates", "bbox", "table_id"),
    raw_text: rawText,
    headers,
    rows,
  };
}

function buildTextChunkFromElement(
  documentId: string,
  sourceUri: string,
  sectionTitle: string | undefined,
  element: V2ExtractedElement,
  index: number,
): V2Chunk | null {
  const text = element.text.trim();
  if (!text) return null;

  const metadata = element.metadata;
  return {
    chunk_id: hashId(`${documentId}:chunk:${element.element_id}:${index}`),
    document_id: documentId,
    source_uri: sourceUri,
    text,
    page: getNumber(metadata, "page_number", "page"),
    section_title: sectionTitle,
    element_type: element.type,
    source_modality: "text",
  };
}

export async function normalizeContentNode(
  state: GenerateInsightsV2State,
): Promise<Partial<GenerateInsightsV2State>> {
  console.info("[normalization] starting", {
    extractedDocuments: state.extractedDocuments.length,
  });

  const normalizedDocuments: V2NormalizedDocument[] = [];
  const chunks: V2Chunk[] = [];
  const tables: V2Table[] = [];

  for (const document of state.extractedDocuments) {
    normalizedDocuments.push({
      document_id: document.document_id,
      source_uri: document.source_uri,
      file_type: document.file_type,
      content_type: document.content_type,
    });

    let currentSectionTitle: string | undefined;

    for (const [index, element] of document.elements.entries()) {
      const sectionFromMetadata = getString(
        element.metadata,
        "section_title",
        "section",
        "parent_title",
        "header_footer_type",
      );

      if (sectionFromMetadata) {
        currentSectionTitle = sectionFromMetadata;
      } else if (element.type.toLowerCase() === "title" && element.text.trim().length > 0) {
        currentSectionTitle = element.text.trim();
      }

      if (isTableElement(element)) {
        const table = buildTableFromElement(
          document.document_id,
          document.source_uri,
          currentSectionTitle,
          element,
          index,
        );
        if (table) tables.push(table);
        continue;
      }

      const chunk = buildTextChunkFromElement(
        document.document_id,
        document.source_uri,
        currentSectionTitle,
        element,
        index,
      );
      if (chunk) chunks.push(chunk);
    }

    console.info("[normalization] document normalized", {
      document_id: document.document_id,
      chunks: chunks.filter((chunk) => chunk.document_id === document.document_id).length,
      tables: tables.filter((table) => table.document_id === document.document_id).length,
    });
  }

  console.info("[normalization] completed", {
    documents: normalizedDocuments.length,
    chunks: chunks.length,
    tables: tables.length,
  });

  return {
    normalizedDocuments,
    chunks,
    tables,
  };
}
