import { playgroundPath, processBundle, skillName } from "./lib.mjs";

const count = await processBundle();
console.log(`Собран skills/${skillName}: ${count} файлов.`);
console.log(`Обновлён ${playgroundPath}: ${count} файлов.`);
