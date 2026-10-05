import { createRequire } from "node:module";

/** Read from package.json, so `--version`, the handshake and server_status never disagree with the package. */
export const VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;
