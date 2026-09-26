/** Совместимый путь к переносимому контракту реализации. */
export * from "@relay/contracts/entities/product-implementation";
export { productImplementationSchema, storedImplementationSchema, encodeImplementation, decodeImplementation } from "./legacy-records.js";
export type { ProductImplementation } from "./legacy-records.js";
