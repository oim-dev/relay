import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";

// Для source-прогона node:test, включая импорты server-runtime с decorators.
// tsconfig.test.json не включает внешние исходники; tsx применяет его настройки
// только к совпавшим файлам. dev-конфиг включает server-runtime явно.
register({ tsconfig: fileURLToPath(new URL("../../tsconfig.dev.json", import.meta.url)) });
