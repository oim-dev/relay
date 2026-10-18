import { runWorker } from "./launcher.js";

const root = process.argv[2];
if (!root) throw new Error("Не указан каталог Git-базы Relay");
await runWorker(root);
