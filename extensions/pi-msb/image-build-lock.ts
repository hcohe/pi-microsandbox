import { promises as fs } from "node:fs";
import { join } from "node:path";

/** Shared flock inodes stay in a private per-user OS-temp directory, never policy storage. */
export async function buildLockDirectory() {
  const root = await fs.realpath("/tmp");
  const path = join(root, `pi-msb-build-locks-${process.getuid!()}`);
  try { await fs.mkdir(path, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const owner = await fs.lstat(path);
  const check = async () => {
    const stat = await fs.lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o700 || stat.dev !== owner.dev || stat.ino !== owner.ino) throw new Error("Unsafe build lock directory identity/ownership");
  };
  await check();
  return { path, check };
}
