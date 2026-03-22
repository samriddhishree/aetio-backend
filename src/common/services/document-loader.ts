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

type UnstructuredElement = {
  text?: string | null;
};

let unstructuredClient: UnstructuredClient | null = null;

function getUnstructuredClient(): UnstructuredClient {
  if (!unstructuredClient) {
    unstructuredClient = new UnstructuredClient({
      serverURL: "https://api.unstructuredapp.io",
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

async function extractPdfWithUnstructured(
  url: string,
  buffer: ArrayBuffer,
): Promise<string> {
  const startedAt = Date.now();
  console.debug("document-loader:extractPdfWithUnstructured:start", {
    url,
    bufferBytes: buffer.byteLength,
    hasApiKey: Boolean(config.unstructuredApiKey),
    apiUrl: config.unstructuredApiUrl ?? null,
  });

  if (!config.unstructuredApiKey) {
    console.debug("document-loader:extractPdfWithUnstructured:error", {
      url,
      message: "UNSTRUCTURED_API_KEY is required for PDF extraction.",
    });
    throw new Error(
      "UNSTRUCTURED_API_KEY is required for PDF extraction.",
    );
  }

  try {
    const client = getUnstructuredClient();
    console.debug("document-loader:extractPdfWithUnstructured:client:ready", { url });
    const fileName = getFileNameFromUrl(url);
    const fileBuffer = Buffer.from(buffer);
    console.debug("document-loader:extractPdfWithUnstructured:file:prepared", {
      url,
      fileName,
      fileBytes: fileBuffer.length,
    });
    console.debug("document-loader:extractPdfWithUnstructured:partition:start", {
      url,
      fileName,
      strategy: Strategy.HiRes,
      splitPdfPage: true,
      splitPdfConcurrencyLevel: 8,
    });
    let response: Awaited<ReturnType<typeof client.general.partition>>;

    response = await client.general.partition({
      partitionParameters: {
        files: {
          content: fileBuffer,
          fileName,
        },
        strategy: "hi_res",
        splitPdfPage: true,
        splitPdfAllowFailed: true,
        splitPdfConcurrencyLevel: 8,
      },
    });

    console.debug("document-loader:extractPdfWithUnstructured:partition:done", {
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
    const textParts = elements.map((element) => element.text ?? "");
    const nonEmptyElementCount = textParts.filter((part) => part.trim().length > 0).length;
    console.debug("document-loader:extractPdfWithUnstructured:elements:stats", {
      url,
      elementCount: elements.length,
      nonEmptyElementCount,
      emptyElementCount: elements.length - nonEmptyElementCount,
    });

    const joinedText = textParts.filter(Boolean).join("\n\n");
    const text = compactWhitespace(joinedText);
    console.debug("document-loader:extractPdfWithUnstructured:text:built", {
      url,
      joinedLength: joinedText.length,
      compactLength: text.length,
    });

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
      elapsedMs: Date.now() - startedAt,
    });
    return text;
  } catch (error) {
    console.debug("document-loader:extractPdfWithUnstructured:error", {
      url,
      message: error instanceof Error ? error.message : "Unknown error",
      stack: error instanceof Error ? error.stack : undefined,
      elapsedMs: Date.now() - startedAt,
    });
    throw error;
  }
}

function stripHtml(html: string): string {
  const withoutScripts = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
  const withoutStyles = withoutScripts.replace(/<style[\s\S]*?<\/style>/gi, " ");
  const withoutTags = withoutStyles.replace(/<[^>]+>/g, " ");
  return compactWhitespace(withoutTags);
}

function parseS3Url(url: string): { bucket: string; key: string } {
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

async function bodyToBuffer(body: unknown): Promise<Buffer> {
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
      const { bucket, key } = parseS3Url(url);
      const s3 = new S3Client({
        credentials: getCachedAwsAssumeRoleProvider(),
      });
      console.debug("document-loader:load:s3:getObject:start", { bucket, key });
      const response = await s3.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
        }),
      );
      console.debug("document-loader:load:s3:getObject:done", {
        bucket,
        key,
        contentType: response.ContentType ?? "text/plain",
      });

      const contentType = response.ContentType ?? "text/plain";
      const buffer = await bodyToBuffer(response.Body);
      console.debug("document-loader:load:s3:buffer", {
        bucket,
        key,
        bytes: buffer.byteLength,
      });
      const decoder = new TextDecoder("utf-8");
      let text = decoder.decode(buffer);
      if (contentType.includes("application/pdf")) {
        console.debug("document-loader:load:s3:parse:pdf", { url, contentType });
        text = await extractPdfWithUnstructured(url, buffer);
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
