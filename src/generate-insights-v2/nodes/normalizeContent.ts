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

function isSeparatorLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  return /^[,\t|;]+$/.test(trimmed);
}

function splitDelimitedBlocks(rawText: string): string[][] {
  const lines = rawText.split(/\n/).map((line) => line.trimEnd());
  const blocks: string[][] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (isSeparatorLine(line)) {
      if (current.length > 0) {
        blocks.push(current);
        current = [];
      }
      continue;
    }
    current.push(line);
  }

  if (current.length > 0) {
    blocks.push(current);
  }
  return blocks;
}

function detectDelimiter(lines: string[]): string {
  const candidates = ["\t", "|", ","];
  let selected = "";
  let selectedCount = 0;

  for (const candidate of candidates) {
    const count = lines.reduce(
      (sum, line) => sum + Math.max(0, line.split(candidate).length - 1),
      0,
    );
    if (count > selectedCount) {
      selected = candidate;
      selectedCount = count;
    }
  }
  return selectedCount > 0 ? selected : "";
}

function toCells(line: string, delimiter: string): string[] {
  return line.split(delimiter).map((cell) => cell.trim());
}

function isPlaceholderHeaderCell(value: string): boolean {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^\w: ]+/g, "");
  if (!normalized) return true;
  if (/^unnamed[: _-]*\d*$/.test(normalized)) return true;
  if (/^(column|col)[_ -]?\d+$/.test(normalized)) return true;
  return false;
}

function looksNarrativeRow(nonEmptyCells: string[]): boolean {
  if (nonEmptyCells.length === 0) return true;
  if (nonEmptyCells.length === 1 && nonEmptyCells[0].length > 60) return true;
  if (nonEmptyCells.length <= 2 && nonEmptyCells.join(" ").length > 80) return true;
  return false;
}

function chooseHeaderRowIndex(rows: string[][]): number {
  let fallback = -1;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] ?? [];
    const nonEmptyCells = row.filter((cell) => cell.trim().length > 0);
    if (nonEmptyCells.length < 2) continue;
    if (fallback === -1) fallback = index;

    if (looksNarrativeRow(nonEmptyCells)) continue;

    const placeholderCount = nonEmptyCells.filter((cell) => isPlaceholderHeaderCell(cell)).length;
    if (placeholderCount > Math.floor(nonEmptyCells.length / 2)) continue;

    const next = rows[index + 1] ?? [];
    const nextNonEmpty = next.filter((cell) => cell.trim().length > 0).length;
    if (nextNonEmpty < 1) continue;

    return index;
  }

  return fallback;
}

function parseDelimitedTables(rawText: string): Array<{ headers: string[]; rows: V2TableRow[]; raw_text: string }> {
  const blocks = splitDelimitedBlocks(rawText);
  const parsedTables: Array<{ headers: string[]; rows: V2TableRow[]; raw_text: string }> = [];

  for (const blockLines of blocks) {
    const delimiter = detectDelimiter(blockLines);
    if (!delimiter) continue;

    const parsedRows = blockLines.map((line) => toCells(line, delimiter));
    if (parsedRows.length < 2) continue;

    const headerRowIndex = chooseHeaderRowIndex(parsedRows);
    if (headerRowIndex < 0) continue;

    const headerRow = parsedRows[headerRowIndex] ?? [];
    const dataRows = parsedRows
      .slice(headerRowIndex + 1)
      .filter((row) => row.some((cell) => cell.trim().length > 0));
    if (dataRows.length === 0) continue;

    const maxColumns = Math.max(
      headerRow.length,
      ...dataRows.map((row) => row.length),
    );
    const headers = Array.from({ length: maxColumns }, (_value, index) => {
      const cell = headerRow[index] ?? "";
      return cell || `column_${index + 1}`;
    });

    const rows: V2TableRow[] = dataRows.map((row, rowIndex) => {
      const padded = Array.from({ length: maxColumns }, (_value, index) => row[index] ?? "");
      return {
        row_index: rowIndex,
        cells: padded,
      };
    });

    parsedTables.push({
      headers,
      rows,
      raw_text: blockLines.join("\n").trim(),
    });
  }

  return parsedTables;
}

type ParsedHtmlRow = {
  hasHeaderCells: boolean;
  cells: string[];
};

function isEmptyRow(cells: string[]): boolean {
  return cells.every((cell) => cell.trim().length === 0);
}

function splitHtmlBlocks(rows: ParsedHtmlRow[]): ParsedHtmlRow[][] {
  const blocks: ParsedHtmlRow[][] = [];
  let current: ParsedHtmlRow[] = [];

  for (const row of rows) {
    if (isEmptyRow(row.cells)) {
      if (current.length > 0) {
        blocks.push(current);
        current = [];
      }
      continue;
    }
    current.push(row);
  }

  if (current.length > 0) {
    blocks.push(current);
  }

  return blocks;
}

function toParsedTable(rows: string[][], headerRowIndex: number): { headers: string[]; rows: V2TableRow[] } | null {
  if (headerRowIndex < 0 || rows.length < 2) return null;

  const headerRow = rows[headerRowIndex] ?? [];
  const dataRows = rows
    .slice(headerRowIndex + 1)
    .filter((row) => row.some((cell) => cell.trim().length > 0));
  if (dataRows.length === 0) return null;

  const maxColumns = Math.max(
    headerRow.length,
    ...dataRows.map((row) => row.length),
  );
  const headers = Array.from({ length: maxColumns }, (_value, index) => {
    const cell = headerRow[index] ?? "";
    return cell || `column_${index + 1}`;
  });
  const parsedRows: V2TableRow[] = dataRows.map((row, rowIndex) => {
    const padded = Array.from({ length: maxColumns }, (_value, index) => row[index] ?? "");
    return {
      row_index: rowIndex,
      cells: padded,
    };
  });

  return {
    headers,
    rows: parsedRows,
  };
}

function parseHtmlTables(html: string): Array<{ headers: string[]; rows: V2TableRow[] }> {
  const rowMatches = html.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
  if (rowMatches.length === 0) return [];

  const parsedRows: ParsedHtmlRow[] = rowMatches.map((rowHtml) => {
    const hasHeaderCells = /<th[\s>]/i.test(rowHtml);
    const cellMatches = rowHtml.match(/<t[hd][\s\S]*?<\/t[hd]>/gi) ?? [];
    const cells = cellMatches
      .map((cellHtml) => decodeHtmlEntities(stripHtmlTags(cellHtml)))
      .map((value) => value.trim());

    return {
      hasHeaderCells,
      cells,
    };
  });

  const blocks = splitHtmlBlocks(parsedRows);
  const parsedTables: Array<{ headers: string[]; rows: V2TableRow[] }> = [];

  for (const block of blocks) {
    if (block.length < 2) continue;

    const rows = block.map((row) => row.cells);
    const explicitHeaderIndex = block.findIndex(
      (row) => row.hasHeaderCells && row.cells.some((cell) => cell.trim().length > 0),
    );
    const headerRowIndex = explicitHeaderIndex >= 0
      ? explicitHeaderIndex
      : chooseHeaderRowIndex(rows);

    const parsedTable = toParsedTable(rows, headerRowIndex);
    if (!parsedTable) continue;

    parsedTables.push(parsedTable);
  }

  return parsedTables;
}

function buildTablesFromElement(
  documentId: string,
  sourceUri: string,
  sectionTitle: string | undefined,
  element: V2ExtractedElement,
  index: number,
): V2Table[] {
  const metadata = element.metadata;
  const rawText = element.text.trim();
  const html =
    typeof metadata.text_as_html === "string" && metadata.text_as_html.trim().length > 0
      ? metadata.text_as_html
      : undefined;

  const tables: V2Table[] = [];

  if (html) {
    const parsedTables = parseHtmlTables(html);
    for (const [subIndex, parsed] of parsedTables.entries()) {
      tables.push({
        table_id: hashId(`${documentId}:table:${element.element_id}:${index}:html:${subIndex}`),
        document_id: documentId,
        source_uri: sourceUri,
        page: getNumber(metadata, "page_number", "page"),
        section_title: sectionTitle,
        element_type: element.type,
        sheet_name: getString(metadata, "sheet_name", "page_name"),
        table_region: getString(metadata, "coordinates", "bbox", "table_id"),
        raw_text: rawText,
        headers: parsed.headers,
        rows: parsed.rows,
      });
    }
  }

  if (tables.length === 0 && rawText.length > 0) {
    const delimitedTables = parseDelimitedTables(rawText);
    for (const [subIndex, parsedTable] of delimitedTables.entries()) {
      tables.push({
        table_id: hashId(`${documentId}:table:${element.element_id}:${index}:delimited:${subIndex}`),
        document_id: documentId,
        source_uri: sourceUri,
        page: getNumber(metadata, "page_number", "page"),
        section_title: sectionTitle,
        element_type: element.type,
        sheet_name: getString(metadata, "sheet_name", "page_name"),
        table_region: getString(metadata, "coordinates", "bbox", "table_id"),
        raw_text: parsedTable.raw_text,
        headers: parsedTable.headers,
        rows: parsedTable.rows,
      });
    }
  }

  if (tables.length === 0 && rawText.length > 0) {
    tables.push({
      table_id: hashId(`${documentId}:table:${element.element_id}:${index}:raw:0`),
      document_id: documentId,
      source_uri: sourceUri,
      page: getNumber(metadata, "page_number", "page"),
      section_title: sectionTitle,
      element_type: element.type,
      sheet_name: getString(metadata, "sheet_name", "page_name"),
      table_region: getString(metadata, "coordinates", "bbox", "table_id"),
      raw_text: rawText,
      headers: [],
      rows: [],
    });
  }

  return tables;
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
        const elementTables = buildTablesFromElement(
          document.document_id,
          document.source_uri,
          currentSectionTitle,
          element,
          index,
        );
        if (elementTables.length > 0) tables.push(...elementTables);
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
