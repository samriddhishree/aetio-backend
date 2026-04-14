import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { UnstructuredClient } from "unstructured-client";
import { Strategy } from "unstructured-client/sdk/models/shared";
import { setMaxListeners } from "node:events";
import { getCachedAwsAssumeRoleProvider } from "./aws";
import { config } from "./config";
import { compactWhitespace } from "./utils";

export type LoadedDocument = {
  text: string;
  contentType: string;
};

export type UnstructuredElement = {
  element_id?: string | null;
  type?: string | null;
  text?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type LoadedDocumentElements = {
  elements: UnstructuredElement[];
  contentType: string;
};

let unstructuredClient: UnstructuredClient | null = null;

function getUnstructuredClient(): UnstructuredClient {
  if (!unstructuredClient) {
    unstructuredClient = new UnstructuredClient({
      serverURL: config.unstructuredApiUrl || "https://api.unstructuredapp.io",
      security: {
        apiKeyAuth: config.unstructuredApiKey,
      },
    });
  }
  return unstructuredClient;
}

function getFileNameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split("/").filter(Boolean).pop();
    return last || "document.pdf";
  } catch {
    return "document.pdf";
  }
}

function isPdfLike(url: string, contentType?: string): boolean {
  if (contentType?.toLowerCase().includes("pdf")) return true;
  return url.toLowerCase().endsWith(".pdf");
}

async function partitionWithUnstructured(
  url: string,
  buffer: ArrayBuffer,
  contentType?: string,
): Promise<UnstructuredElement[]> {
  const startedAt = Date.now();
  console.debug("document-loader:partitionWithUnstructured:start", {
    url,
    bufferBytes: buffer.byteLength,
    contentType,
    hasApiKey: Boolean(config.unstructuredApiKey),
    apiUrl: config.unstructuredApiUrl ?? null,
  });

  if (!config.unstructuredApiKey) {
    console.debug("document-loader:partitionWithUnstructured:error", {
      url,
      message: "UNSTRUCTURED_API_KEY is required for document extraction.",
    });
    throw new Error(
      "UNSTRUCTURED_API_KEY is required for document extraction.",
    );
  }

  try {
    const client = getUnstructuredClient();
    console.debug("document-loader:partitionWithUnstructured:client:ready", { url });
    const fileName = getFileNameFromUrl(url);
    const fileBuffer = Buffer.from(buffer);
    const pdfLike = isPdfLike(url, contentType);
    console.debug("document-loader:partitionWithUnstructured:file:prepared", {
      url,
      fileName,
      fileBytes: fileBuffer.length,
      pdfLike,
    });
    console.debug("document-loader:partitionWithUnstructured:partition:start", {
      url,
      fileName,
      strategy: Strategy.HiRes,
      splitPdfPage: pdfLike,
      splitPdfConcurrencyLevel: pdfLike ? 8 : undefined,
    });
    let response: Awaited<ReturnType<typeof client.general.partition>>;

    response = await client.general.partition({
      partitionParameters: {
        files: {
          content: fileBuffer,
          fileName,
        },
        inferTableStructure: true,
        pdfInferTableStructure: true,
        strategy: Strategy.HiRes,
        ...(pdfLike
          ? {
              splitPdfPage: true,
              splitPdfAllowFailed: true,
              splitPdfConcurrencyLevel: 8,
            }
          : {}),
      },
    });

    console.debug("document-loader:partitionWithUnstructured:partition:done", {
      url,
      statusCode: response.statusCode ?? null,
      elementCount: response.elements?.length ?? 0,
      elapsedMs: Date.now() - startedAt,
    });

    if (response.statusCode && response.statusCode >= 300) {
      throw new Error(
        `Unstructured partition failed: ${response.statusCode}`,
      );
    }

    const elements = (response.elements as UnstructuredElement[] | undefined) ?? [];
    const nonEmptyElementCount = elements.filter(
      (element) => (element.text ?? "").trim().length > 0,
    ).length;
    console.debug("document-loader:partitionWithUnstructured:elements:stats", {
      url,
      elementCount: elements.length,
      nonEmptyElementCount,
      emptyElementCount: elements.length - nonEmptyElementCount,
    });
    return elements;
  } catch (error) {
    console.debug("document-loader:partitionWithUnstructured:error", {
      url,
      message: error instanceof Error ? error.message : "Unknown error",
      stack: error instanceof Error ? error.stack : undefined,
      elapsedMs: Date.now() - startedAt,
    });
    throw error;
  }
}

async function extractPdfWithUnstructured(
  url: string,
  buffer: ArrayBuffer,
): Promise<string> {
  const elements = await partitionWithUnstructured(url, buffer, "application/pdf");
  const textParts = elements.map((element) => element.text ?? "");
  const joinedText = textParts.filter(Boolean).join("\n\n");
  const text = compactWhitespace(joinedText);

  if (!text) {
    console.debug("document-loader:extractPdfWithUnstructured:empty-text", {
      url,
      elementCount: elements.length,
    });
    throw new Error("Unstructured returned no text elements.");
  }

  console.debug("document-loader:extractPdfWithUnstructured:success", {
    url,
    extractedLength: text.length,
    elementCount: elements.length,
  });
  return text;
}

function stripHtml(html: string): string {
  const withoutScripts = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
  const withoutStyles = withoutScripts.replace(/<style[\s\S]*?<\/style>/gi, " ");
  const withoutTags = withoutStyles.replace(/<[^>]+>/g, " ");
  return compactWhitespace(withoutTags);
}

export function parseS3Url(url: string): { bucket: string; key: string } {
  console.debug("document-loader:parseS3Url:start", { url });
  const trimmed = url.replace("s3://", "");
  const [bucket, ...rest] = trimmed.split("/");
  if (!bucket || rest.length === 0) {
    console.debug("document-loader:parseS3Url:error", { url });
    throw new Error(`Invalid s3 url: ${url}`);
  }
  const key = rest.join("/");
  console.debug("document-loader:parseS3Url:success", { bucket, key });
  return { bucket, key };
}

export async function bodyToBuffer(body: unknown): Promise<Buffer> {
  console.debug("document-loader:bodyToBuffer:start", {
    hasBody: Boolean(body),
    bodyType: body ? typeof body : "nullish",
  });
  if (!body) throw new Error("S3 object has no body.");
  if (Buffer.isBuffer(body)) {
    console.debug("document-loader:bodyToBuffer:buffer", { length: body.length });
    return body;
  }
  if (typeof body === "string") {
    const converted = Buffer.from(body);
    console.debug("document-loader:bodyToBuffer:string", { length: converted.length });
    return converted;
  }
  if (body instanceof Uint8Array) {
    const converted = Buffer.from(body);
    console.debug("document-loader:bodyToBuffer:uint8array", { length: converted.length });
    return converted;
  }

  if (typeof (body as Blob).arrayBuffer === "function") {
    console.debug("document-loader:bodyToBuffer:blob:start");
    const arrayBuffer = await (body as Blob).arrayBuffer();
    const converted = Buffer.from(arrayBuffer);
    console.debug("document-loader:bodyToBuffer:blob:done", { length: converted.length });
    return converted;
  }

  if (typeof (body as NodeJS.ReadableStream).on === "function") {
    console.debug("document-loader:bodyToBuffer:stream:start");
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      (body as NodeJS.ReadableStream)
        .on("data", (chunk) => chunks.push(Buffer.from(chunk)))
        .on("error", (error) => {
          console.debug("document-loader:bodyToBuffer:stream:error", {
            message: error instanceof Error ? error.message : "Unknown error",
          });
          reject(error);
        })
        .on("end", () => {
          const converted = Buffer.concat(chunks);
          console.debug("document-loader:bodyToBuffer:stream:done", {
            chunks: chunks.length,
            length: converted.length,
          });
          resolve(converted);
        });
    });
  }

  console.debug("document-loader:bodyToBuffer:error", {
    reason: "unsupported_body_type",
  });
  throw new Error("Unsupported S3 body type.");
}

async function fetchS3Document(url: string): Promise<{ buffer: Buffer; contentType: string }> {
  const { bucket, key } = parseS3Url(url);
  const s3 = new S3Client({
    credentials: getCachedAwsAssumeRoleProvider(),
  });

  console.debug("document-loader:fetchS3Document:getObject:start", { bucket, key });
  const response = await s3.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
  );
  const contentType = response.ContentType ?? "application/octet-stream";
  const buffer = await bodyToBuffer(response.Body);
  console.debug("document-loader:fetchS3Document:getObject:done", {
    bucket,
    key,
    contentType,
    bytes: buffer.byteLength,
  });
  return { buffer, contentType };
}

export async function loadDocumentElements(url: string): Promise<LoadedDocumentElements> {
  console.debug("document-loader:loadDocumentElements:start", { url });
  const controller = new AbortController();
  setMaxListeners(25, controller.signal);
  const timeout = setTimeout(
    () => controller.abort(),
    config.requestTimeoutMs,
  );

  try {
    let contentType = "application/octet-stream";
    let buffer: ArrayBuffer;

    if (url.startsWith("s3://")) {
      const s3Document = await fetchS3Document(url);
      contentType = s3Document.contentType;
      buffer = Uint8Array.from(s3Document.buffer).buffer;
    } else {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "user-agent": "aetio-ingestion/1.0",
        },
      });
      if (!response.ok) {
        throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
      }
      contentType = response.headers.get("content-type") ?? "application/octet-stream";
      buffer = await response.arrayBuffer();
    }

    const elements = await partitionWithUnstructured(url, buffer, contentType);
    console.debug("document-loader:loadDocumentElements:done", {
      url,
      contentType,
      elementCount: elements.length,
    });
    return { elements, contentType };
  } catch (error) {
    console.debug("document-loader:loadDocumentElements:error", {
      url,
      message: error instanceof Error ? error.message : "Unknown error",
      aborted: controller.signal.aborted,
    });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function loadDocumentText(url: string): Promise<LoadedDocument> {
  console.debug("document-loader:load:start", { url });
  const controller = new AbortController();
  // Some downstream HTTP clients attach multiple abort listeners per request.
  // Raise the limit on this per-request signal to avoid false-positive warnings.
  setMaxListeners(25, controller.signal);
  const timeout = setTimeout(
    () => controller.abort(),
    config.requestTimeoutMs,
  );
  try {
    if (url.startsWith("s3://")) {
      console.debug("document-loader:load:s3:start", { url });
      const { buffer, contentType } = await fetchS3Document(url);
      const decoder = new TextDecoder("utf-8");
      let text = decoder.decode(buffer);
      if (contentType.includes("application/pdf")) {
        console.debug("document-loader:load:s3:parse:pdf", { url, contentType });
        const arrayBuffer = Uint8Array.from(buffer).buffer;
        text = await extractPdfWithUnstructured(url, arrayBuffer);
      } else if (
        contentType.includes("text/html") ||
        contentType.includes("application/xhtml+xml")
      ) {
        console.debug("document-loader:load:s3:parse:html", { url, contentType });
        text = stripHtml(text);
      } else {
        console.debug("document-loader:load:s3:parse:text", { url, contentType });
        text = compactWhitespace(text);
      }

      if (!text) {
        throw new Error("Empty document text after parsing.");
      }

      console.debug("document-loader:load:success", {
        url,
        contentType,
        length: text.length,
      });
      return { text, contentType };
    }

    console.debug("document-loader:load:http:start", { url });
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "aetio-ingestion/1.0",
      },
    });
    console.debug("document-loader:load:http:response", {
      url,
      status: response.status,
      ok: response.ok,
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get("content-type") ?? "text/plain";
    const buffer = await response.arrayBuffer();
    const decoder = new TextDecoder("utf-8");
    console.debug("document-loader:load:http:buffer", {
      url,
      contentType,
      bytes: buffer.byteLength,
    });
    let text = decoder.decode(buffer);
    if (contentType.includes("application/pdf")) {
      console.debug("document-loader:load:http:parse:pdf", { url, contentType });
      text = await extractPdfWithUnstructured(url, buffer);
    } else if (
      contentType.includes("text/html") ||
      contentType.includes("application/xhtml+xml")
    ) {
      console.debug("document-loader:load:http:parse:html", { url, contentType });
      text = stripHtml(text);
    } else {
      console.debug("document-loader:load:http:parse:text", { url, contentType });
      text = compactWhitespace(text);
    }

    if (!text) {
      throw new Error("Empty document text after parsing.");
    }

    console.debug("document-loader:load:success", {
      url,
      contentType,
      length: text.length,
    });
    return { text, contentType };
  } catch (error) {
    console.debug("document-loader:load:error", {
      url,
      aborted: controller.signal.aborted,
      message: error instanceof Error ? error.message : "Unknown error",
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  } finally {
    clearTimeout(timeout);
    console.debug("document-loader:load:finish", {
      url,
      aborted: controller.signal.aborted,
    });
  }
}
