export type InfobipSmsResult =
  | {
    ok: true;
    providerMessageId: string | null;
    providerStatus: string | null;
  }
  | { ok: false; errorCode: string; errorMessage: string };

const GSM_7 =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ ÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_7_EXT = "^{}\\[~]|€";

function readInfobipConfig() {
  return {
    apiKey: Deno.env.get("INFOBIP_API_KEY")?.trim() ?? "",
    baseUrl: (Deno.env.get("INFOBIP_BASE_URL")?.trim() ?? "").replace(
      /\/+$/,
      "",
    ),
    sender: Deno.env.get("INFOBIP_SMS_SENDER")?.trim() || "NewLevel",
    testMode:
      (Deno.env.get("SMS_TEST_MODE") ?? "false").toLowerCase() === "true",
    allowedNumbers: new Set(
      (Deno.env.get("SMS_TEST_ALLOWED_NUMBERS") ?? "")
        .split(",")
        .map((phone) => normalizeE164(phone.trim()))
        .filter((phone): phone is string => Boolean(phone)),
    ),
  };
}

function providerMessage(data: unknown, fallback: string) {
  if (!data || typeof data !== "object") return fallback;
  const value = data as Record<string, unknown>;
  const requestError = value.requestError as
    | Record<string, unknown>
    | undefined;
  const serviceException = requestError?.serviceException as
    | Record<string, unknown>
    | undefined;
  const candidates = [
    value.message,
    value.error,
    requestError?.message,
    serviceException?.text,
    serviceException?.messageId,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.slice(0, 180);
    }
  }

  return fallback;
}

export function normalizeE164(value: string | null | undefined) {
  if (!value) return null;
  const countryCode = Deno.env.get("DEFAULT_PHONE_COUNTRY_CODE")?.trim();
  let phone = value.replace(/[^\d+]/g, "");

  if (phone.includes("+") && !phone.startsWith("+")) {
    return null;
  }

  phone = phone.replace(/(?!^)\+/g, "");

  if (phone.startsWith("00")) {
    phone = `+${phone.slice(2)}`;
  }

  if (countryCode && /^0\d+$/.test(phone)) {
    phone = `${countryCode}${phone.replace(/^0+/, "")}`;
  }

  return /^\+[1-9]\d{7,14}$/.test(phone) ? phone : null;
}

export function smsSegmentInfo(text: string) {
  let gsmUnits = 0;
  let isGsm = true;

  for (const char of text) {
    if (GSM_7.includes(char)) {
      gsmUnits += 1;
      continue;
    }
    if (GSM_7_EXT.includes(char)) {
      gsmUnits += 2;
      continue;
    }
    isGsm = false;
    break;
  }

  if (isGsm) {
    return {
      encoding: "GSM-7",
      length: gsmUnits,
      segments: gsmUnits <= 160 ? 1 : Math.ceil(gsmUnits / 153),
    };
  }

  const length = [...text].length;
  return {
    encoding: "UCS-2",
    length,
    segments: length <= 70 ? 1 : Math.ceil(length / 67),
  };
}

export function smsTestModeConfig() {
  const config = readInfobipConfig();
  return {
    testMode: config.testMode,
    allowedCount: config.allowedNumbers.size,
  };
}

export function smsRecipientEligibility(value: string | null | undefined) {
  const config = readInfobipConfig();
  const phone = normalizeE164(value);
  return {
    testMode: config.testMode,
    allowed: !config.testMode || Boolean(phone && config.allowedNumbers.has(phone)),
  };
}

export async function sendInfobipSms(
  recipient: string,
  message: string,
  timeoutMs = 15000,
): Promise<InfobipSmsResult> {
  const config = readInfobipConfig();
  const to = normalizeE164(recipient);

  if (!config.apiKey || !config.baseUrl) {
    return {
      ok: false,
      errorCode: "INFOBIP_NOT_CONFIGURED",
      errorMessage: "Infobip is not configured",
    };
  }

  if (!to) {
    return {
      ok: false,
      errorCode: "INVALID_RECIPIENT",
      errorMessage: "Recipient must be in E.164 format",
    };
  }

  if (config.testMode && !config.allowedNumbers.has(to)) {
    return {
      ok: false,
      errorCode: "SMS_TEST_MODE_BLOCKED",
      errorMessage: "Recipient is not allowed in SMS_TEST_MODE",
    };
  }

  const text = message.trim();
  if (!text || text.length > 1000) {
    return {
      ok: false,
      errorCode: "INVALID_MESSAGE",
      errorMessage: "SMS message is empty or too long",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${config.baseUrl}/sms/3/messages`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `App ${config.apiKey}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        messages: [{
          sender: config.sender,
          destinations: [{ to }],
          content: { text },
        }],
      }),
    });

    const data = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        ok: false,
        errorCode: `INFOBIP_HTTP_${response.status}`,
        errorMessage: providerMessage(data, "Infobip request failed"),
      };
    }

    const messageResult = data?.messages?.[0];
    return {
      ok: true,
      providerMessageId: typeof messageResult?.messageId === "string"
        ? messageResult.messageId
        : null,
      providerStatus: typeof messageResult?.status?.name === "string"
        ? messageResult.status.name
        : null,
    };
  } catch (error) {
    const isAbort = error instanceof DOMException &&
      error.name === "AbortError";
    return {
      ok: false,
      errorCode: isAbort ? "INFOBIP_TIMEOUT" : "INFOBIP_NETWORK_ERROR",
      errorMessage: isAbort
        ? "Infobip request timed out"
        : "Infobip request failed",
    };
  } finally {
    clearTimeout(timer);
  }
}
