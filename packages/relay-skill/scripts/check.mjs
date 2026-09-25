import { checkSkillSet, processBundle, repoRoot, skillName } from "./lib.mjs";

await checkSkillSet(repoRoot, [skillName]);
const count = await processBundle({ check: true });
console.log(`Скилл ${skillName}: ${count} файлов, сборка актуальна, ссылки переносимы.`);
