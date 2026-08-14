type TextBeeSuccess = {
  ok: true;
  status: "sent";
  providerMessageId: string | null;
};

type TextBeeFailure = {
  ok: false;
  status: "failed";
  errorCode: string;
  errorMessage: string;
};

export type TextBeeResult = TextBeeSuccess | TextBeeFailure;

const TEXTBEE_ENDPOINT = "https://api.textbee.dev/api/v1/gateway/send-sms";

function readTextBeeConfig() {
  return {
    apiKey: Deno.env.get("TEXTBEE_API_KEY") ?? "",
    deviceId: Deno.env.get("TEXTBEE_DEVICE_ID") ?? "",
  };
}

function extractProviderMessageId(data: unknown) {
  if (!data || typeof data !== "object") return null;
  const value = data as Record<string, unknown>;
  const candidates = [
    value.id,
    value.messageId,
    value.smsId,
    (value.data as Record<string, unknown> | undefined)?.id,
    (value.data as Record<string, unknown> | undefined)?.messageId,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }

  return null;
}

function safeErrorMessage(data: unknown, fallback: string) {
  if (!data || typeof data !== "object") return fallback;
  const value = data as Record<string, unknown>;
  const error = value.error;

  if (typeof error === "string" && error.trim()) return error.slice(0, 180);
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim()) {
      return message.slice(0, 180);
    }
  }

  const message = value.message;
  if (typeof message === "string" && message.trim()) {
    return message.slice(0, 180);
  }

  return fallback;
}

export async function sendTextBeeSms(
  recipient: string,
  message: string,
  timeoutMs = 15000,
): Promise<TextBeeResult> {
  const { apiKey, deviceId } = readTextBeeConfig();

  if (!apiKey || !deviceId) {
    return {
      ok: false,
      status: "failed",
      errorCode: "TEXTBEE_NOT_CONFIGURED",
      errorMessage: "TextBee is not configured",
    };
  }

  if (!/^\+[1-9]\d{7,14}$/.test(recipient)) {
    return {
      ok: false,
      status: "failed",
      errorCode: "INVALID_RECIPIENT",
      errorMessage: "Recipient must be in E.164 format",
    };
  }

  const trimmed = message.trim();
  if (!trimmed || trimmed.length > 1000) {
    return {
      ok: false,
      status: "failed",
      errorCode: "INVALID_MESSAGE",
      errorMessage: "SMS message is empty or too long",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(TEXTBEE_ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        recipients: [recipient],
        message: trimmed,
        deviceId,
      }),
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      return {
        ok: false,
        status: "failed",
        errorCode: `TEXTBEE_HTTP_${response.status}`,
        errorMessage: safeErrorMessage(data, "TextBee request failed"),
      };
    }

    return {
      ok: true,
      status: "sent",
      providerMessageId: extractProviderMessageId(data),
    };
  } catch (error) {
    const isAbort = error instanceof DOMException &&
      error.name === "AbortError";
    return {
      ok: false,
      status: "failed",
      errorCode: isAbort ? "TEXTBEE_TIMEOUT" : "TEXTBEE_NETWORK_ERROR",
      errorMessage: isAbort
        ? "TextBee request timed out"
        : "TextBee request failed",
    };
  } finally {
    clearTimeout(timer);
  }
}
