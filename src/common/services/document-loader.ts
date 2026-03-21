import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { UnstructuredClient } from "unstructured-client";
import { Strategy } from "unstructured-client/sdk/models/shared";
import { setMaxListeners } from "node:events";
import { getAwsAssumeRoleProvider } from "./aws";
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
      serverURL: config.unstructuredApiUrl || undefined,
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
  if (!config.unstructuredApiKey) {
    throw new Error(
      "UNSTRUCTURED_API_KEY is required for PDF extraction.",
    );
  }

  const client = getUnstructuredClient();
  const fileName = getFileNameFromUrl(url);
  const response = await client.general.partition({
    partitionParameters: {
      files: {
        content: Buffer.from(buffer),
        fileName,
      },
      strategy: Strategy.HiRes,
      splitPdfPage: true,
      splitPdfConcurrencyLevel: 8,
    },
  });

  if (response.statusCode && response.statusCode >= 300) {
    throw new Error(
      `Unstructured partition failed: ${response.statusCode}`,
    );
  }

  const elements = (response.elements as UnstructuredElement[] | undefined) ?? [];

  const text = compactWhitespace(
    elements
      .map((element) => element.text ?? "")
      .filter(Boolean)
      .join("\n\n"),
  );

  if (!text) {
    throw new Error("Unstructured returned no text elements.");
  }

  return text;
}

function stripHtml(html: string): string {
  const withoutScripts = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
  const withoutStyles = withoutScripts.replace(/<style[\s\S]*?<\/style>/gi, " ");
  const withoutTags = withoutStyles.replace(/<[^>]+>/g, " ");
  return compactWhitespace(withoutTags);
}

function parseS3Url(url: string): { bucket: string; key: string } {
  const trimmed = url.replace("s3://", "");
  const [bucket, ...rest] = trimmed.split("/");
  if (!bucket || rest.length === 0) {
    throw new Error(`Invalid s3 url: ${url}`);
  }
  return { bucket, key: rest.join("/") };
}

async function bodyToBuffer(body: unknown): Promise<Buffer> {
  if (!body) throw new Error("S3 object has no body.");
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);

  if (typeof (body as Blob).arrayBuffer === "function") {
    const arrayBuffer = await (body as Blob).arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  if (typeof (body as NodeJS.ReadableStream).on === "function") {
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      (body as NodeJS.ReadableStream)
        .on("data", (chunk) => chunks.push(Buffer.from(chunk)))
        .on("error", reject)
        .on("end", () => resolve(Buffer.concat(chunks)));
    });
  }

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
      const { bucket, key } = parseS3Url(url);
      const s3 = new S3Client({
        credentials: getAwsAssumeRoleProvider(),
      });
      const response = await s3.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
        }),
      );

      const contentType = response.ContentType ?? "text/plain";
      const buffer = await bodyToBuffer(response.Body);
      const decoder = new TextDecoder("utf-8");
      let text = decoder.decode(buffer);
      if (contentType.includes("application/pdf")) {
        text = await extractPdfWithUnstructured(url, buffer);
      } else if (
        contentType.includes("text/html") ||
        contentType.includes("application/xhtml+xml")
      ) {
        text = stripHtml(text);
      } else {
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

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "aetio-ingestion/1.0",
      },
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get("content-type") ?? "text/plain";
    const buffer = await response.arrayBuffer();
    const decoder = new TextDecoder("utf-8");
    console.log("contentType",contentType)
    let text = decoder.decode(buffer);
    if (contentType.includes("application/pdf")) {
      text = await extractPdfWithUnstructured(url, buffer);
    } else if (
      contentType.includes("text/html") ||
      contentType.includes("application/xhtml+xml")
    ) {
      text = stripHtml(text);
    } else {
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
  } finally {
    clearTimeout(timeout);
  }
}
