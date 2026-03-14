/**
 * Simple `/chat` endpoint for WhatsApp router (and other HTTP integrations).
 *
 * Contract:
 *   POST /chat  { "message": "...", "sender": "...", ... }
 *   →  200  { "reply": "..." }
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createDefaultDeps } from "../cli/deps.js";
import { agentCommandFromIngress } from "../commands/agent.js";
import { logWarn } from "../logger.js";
import { defaultRuntime } from "../runtime.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import type { ChatAttachment } from "./chat-attachments.js";
import { parseMessageWithAttachments } from "./chat-attachments.js";
import { sendJson } from "./http-common.js";
import { handleGatewayPostJsonEndpoint } from "./http-endpoint-helpers.js";
import { resolveGatewayRequestContext } from "./http-utils.js";

type ChatHttpOptions = {
  auth: ResolvedGatewayAuth;
  maxBodyBytes?: number;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
};

type ChatRequest = {
  message?: unknown;
  sender?: unknown;
  to?: unknown;
  wa_id?: unknown;
  profile_name?: unknown;
  message_sid?: unknown;
  channel?: unknown;
  provider?: unknown;
  attachments?: unknown;
};

const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB (supports base64 image attachments)

function coerceRequest(val: unknown): ChatRequest {
  if (!val || typeof val !== "object") {
    return {};
  }
  return val as ChatRequest;
}

function resolveResponseText(result: unknown): string {
  const payloads = (result as { payloads?: Array<{ text?: string }> } | null)?.payloads;
  if (!Array.isArray(payloads) || payloads.length === 0) {
    return "No response from OpenClaw.";
  }
  const content = payloads
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .filter(Boolean)
    .join("\n\n");
  return content || "No response from OpenClaw.";
}

export async function handleChatHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ChatHttpOptions,
): Promise<boolean> {
  const handled = await handleGatewayPostJsonEndpoint(req, res, {
    pathname: "/chat",
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
    maxBodyBytes: opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
  });
  if (handled === false) {
    return false;
  }
  if (!handled) {
    return true;
  }

  const payload = coerceRequest(handled.body);
  const message = typeof payload.message === "string" ? payload.message.trim() : "";

  if (!message) {
    sendJson(res, 400, {
      error: { message: "Missing `message` field.", type: "invalid_request_error" },
    });
    return true;
  }

  const sender = typeof payload.sender === "string" ? payload.sender : undefined;
  const channel = typeof payload.channel === "string" ? payload.channel : "whatsapp";

  // Parse image attachments if provided.
  const rawAttachments = Array.isArray(payload.attachments)
    ? (payload.attachments as ChatAttachment[])
    : undefined;
  let images: Awaited<ReturnType<typeof parseMessageWithAttachments>>["images"] = [];
  try {
    const parsed = await parseMessageWithAttachments(message, rawAttachments, {
      log: { warn: (msg: string) => logWarn(`chat-http: ${msg}`) },
    });
    images = parsed.images;
  } catch (attErr) {
    sendJson(res, 400, {
      error: { message: `Attachment error: ${String(attErr)}`, type: "invalid_request_error" },
    });
    return true;
  }

  const { sessionKey, messageChannel } = resolveGatewayRequestContext({
    req,
    model: undefined,
    user: sender,
    sessionPrefix: "chat",
    defaultMessageChannel: channel,
    useMessageChannelHeader: false,
  });

  const runId = `chat_${randomUUID()}`;
  const deps = createDefaultDeps();
  const commandInput = {
    message,
    images: images.length > 0 ? images : undefined,
    sessionKey,
    runId,
    deliver: false as const,
    messageChannel,
    bestEffortDeliver: false as const,
    senderIsOwner: true as const,
  };

  try {
    const result = await agentCommandFromIngress(commandInput, defaultRuntime, deps);
    const reply = resolveResponseText(result);
    sendJson(res, 200, { reply });
  } catch (err) {
    logWarn(`chat-http: request failed: ${String(err)}`);
    sendJson(res, 500, {
      error: { message: "internal error", type: "api_error" },
    });
  }

  return true;
}
