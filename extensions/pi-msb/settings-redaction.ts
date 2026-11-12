const REDACTED = "<redacted>";
export interface SettingsSanitizer {
  <T>(value: T, additionalPrivateSources?: unknown[], format?: "toml"): T;
  /** Originating private-literal coverage only; absent metadata cannot prove safety. */
  readonly hasPrivateLiterals?: boolean;
}

const normalizedKey = (key: string): string => key.replace(/_/g, "").toLowerCase();
function sourceField(key: string): boolean {
  const name = normalizedKey(key);
  // Deprecated value is privacy-only: rejected raw input can still contain credentials.
  // Host variable names and command text are public source descriptors, not resolved credentials.
  return name === "textvalue" || name === "value";
}

function createSettingsSanitizerContext(privateSources: unknown[]): Set<string> {
  const secrets = new Set<string>();
  const collect = (item: unknown, key = "", privateField = false): void => {
    privateField ||= sourceField(key);
    if (privateField && item !== undefined && (item === null || ["string", "number", "boolean", "bigint"].includes(typeof item))) {
      const literal = String(item);
      if (literal && literal !== REDACTED) secrets.add(literal);
    }
    if (Array.isArray(item)) item.forEach((entry) => collect(entry, "", privateField));
    else if (item && typeof item === "object") for (const [k, v] of Object.entries(item)) collect(v, k, privateField);
  };
  privateSources.forEach((source) => collect(source));
  return secrets;
}

/** Mask literal credentials, including repetitions in public source descriptors, warnings, keys and paths. */
export function createSettingsSanitizer(privateSources: unknown[]): SettingsSanitizer {
  const secrets = createSettingsSanitizerContext(privateSources);
  const sanitize = <T>(value: T, additionalPrivateSources: unknown[] = [], format?: "toml"): T => {
    const additional = createSettingsSanitizerContext(additionalPrivateSources);
    const literals = [...new Set([...secrets, ...additional])].sort((a, b) => b.length - a.length);
    const text = (input: string, preserveControls = false): string => {
      let result = input;
      for (const secret of literals) result = result.split(secret).join(REDACTED);
      // Commands are editable source code: keep exact text in structured data.
      // Text renderers sanitize terminal controls, and JSON escapes them.
      return preserveControls ? result : result.replace(/[\p{Cc}\p{Cf}]/gu, " ");
    };
    const visit = (item: any, key = ""): any => {
      if (sourceField(key)) return REDACTED;
      if (typeof item === "string") return text(item, normalizedKey(key) === "hostcmd");
      if (item !== undefined && (item === null || ["number", "boolean", "bigint"].includes(typeof item)) && literals.includes(String(item))) return REDACTED;
      if (Array.isArray(item)) return item.map((entry) => visit(entry));
      if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([k, v]) => [text(k), visit(v, k)]));
      return item;
    };
    // Native effective TOML uses JSON-quoted strings. Decode each literal before
    // masking so escaped credentials are caught without changing TOML syntax,
    // structural newlines, or unrelated controls inside machine-readable values.
    if (format === "toml" && typeof value === "string") {
      return value.replace(/"(?:[^"\\]|\\.)*"/g, (quoted) => JSON.stringify(text(JSON.parse(quoted), true))) as T;
    }
    return visit(value);
  };
  return Object.defineProperty(sanitize, "hasPrivateLiterals", { value: secrets.size > 0 });
}
