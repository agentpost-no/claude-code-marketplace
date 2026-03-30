import { join } from "node:path";

const BASE = join(process.env.HOME ?? "~", ".claude", "channels", "mailmcp");

export const KEYS_DIR = join(BASE, "keys");
export const ATTACHMENTS_DIR = join(BASE, "attachments");
export const CONFIG_PATH = join(BASE, "config.json");
export const THREADS_PATH = join(BASE, "threads.json");
