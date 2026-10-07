// State files hold item titles from private repos and the agent token, and
// macOS home directories are readable by the whole `staff` group. Write them
// owner-only, in owner-only directories.
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode only applies to directories it creates.
  await chmod(dir, 0o700);
}

export async function writePrivateFile(path: string, contents: string): Promise<void> {
  await ensurePrivateDir(dirname(path));
  await writeFile(path, contents, { mode: 0o600 });
  // writeFile's mode only applies when it creates the file.
  await chmod(path, 0o600);
}
