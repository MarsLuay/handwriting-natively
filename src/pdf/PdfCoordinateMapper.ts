import { PageCoordinateMapper } from "../runtime/PageCoordinateMapper";

/** @deprecated Use PageCoordinateMapper in shared annotation runtime code. */
export const PdfCoordinateMapper = PageCoordinateMapper;
export type PdfCoordinateMapper = PageCoordinateMapper;
export type {
  PageCoordinateMapperOptions as PdfCoordinateMapperOptions,
  PageCoordinateOrigin,
  PageRotation,
  ViewportPoint
} from "../runtime/PageCoordinateMapper";
