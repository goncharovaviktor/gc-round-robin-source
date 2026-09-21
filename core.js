export const VERSION = "2.2.0";

export const LIMITS = Object.freeze({
  MAX_BODY_BYTES: 12_000,
  MAX_POOL_LENGTH: 48,
  MAX_MANAGER_CODE_LENGTH: 64,
  MAX_USER_ID_LENGTH: 30,
  MAX_EMAIL_LENGTH: 254,
  MAX_ERROR_LENGTH: 500,
  MAX_DELIVERY_ATTEMPTS: 8,
  MAX_POOLS: 32,
  MAX_MANAGERS_PER_POOL: 50,
  MAX_TOTAL_MANAGERS: 100,
  MAX_MANAGER_NAME_LENGTH: 120,
});

export function normalizeText(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

export function normalizePool(value) {
  const pool = normalizeText(value);
  return new RegExp(`^[A-Za-z0-9_-]{1,${LIMITS.MAX_POOL_LENGTH}}$`).test(pool)
    ? pool
    : "";
}

export function normalizeManagerCode(value) {
  const code = normalizeText(value);
  return new RegExp(`^[A-Za-z0-9_-]{1,${LIMITS.MAX_MANAGER_CODE_LENGTH}}$`).test(code)
    ? code
    : "";
}

export function normalizeUserId(value) {
  const userId = normalizeText(value);
  return new RegExp(`^[0-9]{1,${LIMITS.MAX_USER_ID_LENGTH}}$`).test(userId)
    ? userId
    : "";
}

export function normalizeEmail(value) {
  const email = normalizeText(value).toLowerCase();
  if (
    !email ||
    email.length > LIMITS.MAX_EMAIL_LENGTH ||
    /\s/.test(email) ||
    email.indexOf("@") <= 0 ||
    email.lastIndexOf(".") <= email.indexOf("@") + 1
  ) {
    return "";
  }
  return email;
}

export function normalizeHttpsBaseUrl(value) {
  const url = normalizeText(value).replace(/\/+$/, "");
  return /^https:\/\/[^\s/]+$/i.test(url) ? url : "";
}

export function validateManagerCodes(values) {
  if (!Array.isArray(values) || values.length === 0) return [];
  const codes = values.map(normalizeManagerCode);
  if (codes.some((code) => !code) || new Set(codes).size !== codes.length) return [];
  return codes;
}

export function validateManagerConfiguration(value) {
  const source = value && typeof value === "object" ? value : {};
  const version = Number(source.version);
  const sourcePools = Array.isArray(source.pools) ? source.pools : [];

  if (!Number.isSafeInteger(version) || version < 1) {
    return invalidManagerConfiguration("CONFIG_VERSION_MUST_BE_POSITIVE_INTEGER");
  }
  if (!sourcePools.length || sourcePools.length > LIMITS.MAX_POOLS) {
    return invalidManagerConfiguration("CONFIG_POOLS_COUNT_INVALID");
  }

  const seenPools = new Set();
  let totalManagers = 0;
  const pools = [];

  for (const sourcePool of sourcePools) {
    const pool = normalizePool(sourcePool?.pool);
    if (!pool) return invalidManagerConfiguration("CONFIG_POOL_INVALID");
    if (seenPools.has(pool)) return invalidManagerConfiguration("CONFIG_POOL_DUPLICATE");
    seenPools.add(pool);

    const sourceManagers = Array.isArray(sourcePool?.managers) ? sourcePool.managers : [];
    if (!sourceManagers.length || sourceManagers.length > LIMITS.MAX_MANAGERS_PER_POOL) {
      return invalidManagerConfiguration("CONFIG_MANAGERS_COUNT_INVALID");
    }

    const seenCodes = new Set();
    const managers = [];
    let activeCount = 0;

    for (let index = 0; index < sourceManagers.length; index += 1) {
      const sourceManager = sourceManagers[index];
      const code = normalizeManagerCode(sourceManager?.code);
      const rawName = normalizeText(sourceManager?.name);
      const name = rawName.slice(0, LIMITS.MAX_MANAGER_NAME_LENGTH);
      if (typeof sourceManager?.active !== "boolean") {
        return invalidManagerConfiguration("CONFIG_MANAGER_ACTIVE_INVALID");
      }
      if (rawName.length > LIMITS.MAX_MANAGER_NAME_LENGTH) {
        return invalidManagerConfiguration("CONFIG_MANAGER_NAME_TOO_LONG");
      }
      const active = sourceManager?.active === true;

      if (!code) return invalidManagerConfiguration("CONFIG_MANAGER_CODE_INVALID");
      if (seenCodes.has(code)) return invalidManagerConfiguration("CONFIG_MANAGER_CODE_DUPLICATE");
      seenCodes.add(code);
      if (active) activeCount += 1;

      managers.push({ code, name, active, sortOrder: index + 1 });
    }

    if (!activeCount) return invalidManagerConfiguration("CONFIG_NO_ACTIVE_MANAGERS");

    totalManagers += managers.length;
    if (totalManagers > LIMITS.MAX_TOTAL_MANAGERS) {
      return invalidManagerConfiguration("CONFIG_TOO_MANY_MANAGERS");
    }

    const initialLastManagerCode = normalizeManagerCode(sourcePool?.initialLastManagerCode);
    if (normalizeText(sourcePool?.initialLastManagerCode) && !initialLastManagerCode) {
      return invalidManagerConfiguration("CONFIG_INITIAL_MANAGER_INVALID");
    }
    if (initialLastManagerCode && !seenCodes.has(initialLastManagerCode)) {
      return invalidManagerConfiguration("CONFIG_INITIAL_MANAGER_UNKNOWN");
    }

    pools.push({ pool, initialLastManagerCode, managers });
  }

  const normalized = { version, pools };
  return {
    ok: true,
    error: "",
    version,
    poolCount: pools.length,
    managerCount: totalManagers,
    normalized,
    serialized: JSON.stringify(normalized),
  };
}

function invalidManagerConfiguration(error) {
  return {
    ok: false,
    error,
    version: 0,
    poolCount: 0,
    managerCount: 0,
    normalized: null,
    serialized: "",
  };
}

export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function chooseNextManager(activeManagerCodes, lastManagerCode, orderedManagerCodes = activeManagerCodes) {
  const activeCodes = validateManagerCodes(activeManagerCodes);
  if (!activeCodes.length) return "";

  let orderedCodes = validateManagerCodes(orderedManagerCodes);
  if (!orderedCodes.length || activeCodes.some((code) => !orderedCodes.includes(code))) {
    orderedCodes = activeCodes;
  }

  const currentIndex = orderedCodes.indexOf(normalizeManagerCode(lastManagerCode));
  if (currentIndex === -1) return activeCodes[0];

  const activeSet = new Set(activeCodes);
  for (let offset = 1; offset <= orderedCodes.length; offset += 1) {
    const candidate = orderedCodes[(currentIndex + offset) % orderedCodes.length];
    if (activeSet.has(candidate)) return candidate;
  }
  return activeCodes[0];
}

export function isTruthySignal(value) {
  return value === true || value === 1 || normalizeText(value).toLowerCase() === "true";
}

export function classifyGetCourseResponse(httpStatus, responseBody) {
  const status = Number(httpStatus) || 0;
  const body = normalizeText(responseBody).slice(0, 20_000);

  if (status < 200 || status >= 300) {
    const retryable = status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
    return {
      ok: false,
      retryable,
      errorCode: `GC_HTTP_${status || "NETWORK"}`,
      message: `GetCourse API returned HTTP ${status || "network error"}.`,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {
      ok: false,
      retryable: true,
      errorCode: "GC_INVALID_JSON",
      message: "GetCourse API returned invalid JSON.",
    };
  }

  const accepted =
    isTruthySignal(parsed?.success) &&
    parsed?.result &&
    isTruthySignal(parsed.result.success) &&
    !isTruthySignal(parsed.result.error);

  if (accepted) {
    return { ok: true, retryable: false, errorCode: "", message: "" };
  }

  const apiMessage = normalizeText(
    parsed?.result?.error_message || parsed?.error_message || parsed?.error || "unknown API error",
  ).slice(0, 240);
  const retryable = /timeout|temporar|try\s+again|rate|too\s+many|unavailable|overload|busy/i.test(apiMessage);
  return {
    ok: false,
    retryable,
    errorCode: retryable ? "GC_TEMPORARY_REJECTION" : "GC_PERMANENT_REJECTION",
    message: `GetCourse API rejected update: ${apiMessage}`,
  };
}

export function retryDelaySeconds(attemptNumber) {
  const attempt = Math.max(1, Number(attemptNumber) || 1);
  return Math.min(3_600, 30 * 2 ** Math.min(attempt - 1, 7));
}

export function utf8ToBase64(value) {
  const bytes = new TextEncoder().encode(String(value));
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export async function constantTimeEquals(left, right) {
  const encode = (value) => new TextEncoder().encode(normalizeText(value));
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encode(left)),
    crypto.subtle.digest("SHA-256", encode(right)),
  ]);
  const a = new Uint8Array(leftHash);
  const b = new Uint8Array(rightHash);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    difference |= (a[index] || 0) ^ (b[index] || 0);
  }
  return difference === 0 && normalizeText(left) !== "" && normalizeText(right) !== "";
}

export function safeErrorMessage(error) {
  return normalizeText(error?.message || error || "Unknown error").slice(0, LIMITS.MAX_ERROR_LENGTH);
}

export function maskEmail(value) {
  const email = normalizeEmail(value);
  if (!email) return "";
  const [local, domain] = email.split("@");
  return `${local.slice(0, 2)}***@${domain}`;
}

export function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

export function textResponse(text, status = 200, extraHeaders = {}) {
  return new Response(String(text), {
    status,
    headers: {
      "Content-Type": "text/plain; charset=UTF-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}
