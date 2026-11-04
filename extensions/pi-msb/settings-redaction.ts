const REDACTED = "<redacted>";
export type SettingsSanitizer = <T>(value: T, additionalPrivateSources?: unknown[]) => T;

function createSettingsSanitizerContext(privateSources: unknown[]): Set<string> {
  const secrets = new Set<string>();
  const collect = (item: unknown, key = ""): void => {
    // Resolver normalization accepts uppercase VALUE; capture hidden raw spellings too.
    if (key.toLowerCase() === "value" && typeof item === "string" && item && item !== REDACTED) {
      secrets.add(item);
      if (/^\$(ENV|FILE):/.test(item)) {
        const reference = item.slice(item.startsWith("$ENV:") ? 5 : 6);
        if (reference) secrets.add(reference);
      }
    }
    if (Array.isArray(item)) item.forEach((entry) => collect(entry));
    else if (item && typeof item === "object") for (const [k, v] of Object.entries(item)) collect(v, k);
  };
  privateSources.forEach((source) => collect(source));
  return secrets;
}

/** Mask references too, including repetitions in warnings, keys, paths and other supported fields. */
export function createSettingsSanitizer(privateSources: unknown[]): SettingsSanitizer {
  const secrets = createSettingsSanitizerContext(privateSources);
  return <T>(value: T, additionalPrivateSources: unknown[] = []): T => {
    const additional = createSettingsSanitizerContext(additionalPrivateSources);
    const literals = [...new Set([...secrets, ...additional])].sort((a, b) => b.length - a.length);
    const text = (input: string): string => {
      let result = input;
      for (const secret of literals) result = result.split(secret).join(REDACTED);
      return result.replace(/\$(?:ENV|FILE):[^\s"'\],}]+/g, REDACTED).replace(/[\p{Cc}\p{Cf}]/gu, " ");
    };
    const visit = (item: any, key = ""): any => {
      if (key.toLowerCase() === "value") return REDACTED;
      if (typeof item === "string") return text(item);
      if (Array.isArray(item)) return item.map((entry) => visit(entry));
      if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([k, v]) => [text(k), visit(v, k)]));
      return item;
    };
    return visit(value);
  };
}
