/** Публичные переносимые DTO. Здесь нет импортов Core, NestJS, Node.js или React. */
import type { StoredProjectSettings } from "./entities/project-settings.js";
export type {
  ProductStatus,
  ProductReference,
  ProductContract,
  ProductFields,
  ProductRecord,
  ProductReadiness,
  ProductState,
} from "./product.js";
export const API_PREFIX = "/api/v1";
export const API_CONTRACT_VERSION = 1 as const;
export const API_DOCS_PATH = "/api/docs";
export const OPENAPI_PATH = "/api/openapi.json";

export type RelayMode = "local" | "workspace";
export interface RelayProject {
  key: string;
  id: string;
  name: string;
  /** Человекочитаемый адрес проекта; у недоступной регистрации может отсутствовать. */
  slug?: string;
  configPath: string;
  available: boolean;
  error?: string;
}
export interface ServerContextResponse {
  mode: RelayMode;
  configPath: string;
  projects: RelayProject[];
  defaultProject: string | null;
}

export interface PageMeta {
  hasMore: boolean;
  nextCursor: string | null;
  truncated?: boolean;
}
export interface ApiSuccess<T> {
  ok: true;
  data: T;
  meta?: PageMeta;
}
export interface ApiFailure {
  ok: false;
  error: { code: string; message: string; exitCode?: number; details?: unknown };
}
export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;
export function success<T>(data: T, meta?: PageMeta): ApiSuccess<T> {
  return { ok: true, data, ...(meta === undefined ? {} : { meta }) };
}

export type StatusColor =
  "black" | "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "white" | "gray" | "none";
export interface StatusDefinition {
  terminal: boolean;
  satisfiesDependencies: boolean;
  color?: StatusColor | undefined;
}
export interface ProjectConfig {
  version: 1;
  mode: "local";
  projectId?: string | undefined;
  /** Версионированные настройки имени и адреса; отсутствуют в прежних конфигурациях. */
  projectSettings?: StoredProjectSettings | undefined;
  storageDir: string;
  defaultStatus: string;
  readyStatuses: string[];
  statuses: Record<string, StatusDefinition>;
  /** Настроенный порт сервера; 0 выбирает свободный порт при запуске. */
  server: { port: number; url?: string | undefined };
  mcp?: { port: number } | undefined;
  output: { format: "text" | "json"; defaultLimit: number; maxBytes: number };
}
export interface ContextResponse {
  /** Режим фоновой доставки; позволяет клиенту не опрашивать Git-статус файловой базы. */
  synchronizationMode?: "file" | "git";
  capabilities?: string[];
  project: string;
  projectId: string;
  configPath: string;
  storagePath: string;
  actor: string;
  config: ProjectConfig;
}
export interface HealthResponse {
  status: "ok";
  stage: "scaffold" | "ready";
  contractVersion: typeof API_CONTRACT_VERSION;
}

/** Результат проверки действующих сущностей, канбана и отношений. */
export interface ValidationData {
  valid: boolean;
  entities: number;
  tasks: number;
  boards: number;
}

export type ServerEvent =
  | { type: "connected"; data: { projectId: string } }
  | { type: "heartbeat"; data: { timestamp: string } }
  | { type: "changed"; data: { source: "api" | "storage"; version?: string } }
  | { type: "workspace-error"; data: { code: string; message: string } };
