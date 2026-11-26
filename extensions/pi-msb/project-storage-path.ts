import { isAbsolute, join, parse, relative, sep } from "node:path";

/** Readable canonical-root key; artifact names cannot also be Project key components. */
export function projectConfigPath(policyRoot: string, home: string, root: string): string {
  const suffix = relative(home, root);
  const inside = !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`);
  const key = inside ? suffix : relative(parse(root).root, root);
  if (key.split(sep).some((part) => /^(build-context|config\.toml|Dockerfile)$/i.test(part))) {
    throw new Error("Project storage path conflicts with reserved artifact name (build-context, config.toml or Dockerfile); use a checkout path without these components");
  }
  return join(policyRoot, inside ? "projects" : "projects-absolute", key, "config.toml");
}
