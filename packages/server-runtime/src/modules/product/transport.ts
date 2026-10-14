import {
  productValidationSchema,
  productLintQuerySchema,
  productLintPageSchema,
  productOverviewMapQuerySchema,
  productOverviewMapPageSchema,
} from "@relay/contracts/product-query";
import {
  productParticipationQuerySchema,
  productParticipationPageSchema,
  productParticipationReplaceSchema,
  productParticipationSavedSchema,
  productImplementationDetailSchema,
} from "@relay/contracts/product-participation";

export const productTransportSchemas = {
  ProductValidation: productValidationSchema,
  ProductLintQuery: productLintQuerySchema,
  ProductLintPage: productLintPageSchema,
  ProductOverviewMapQuery: productOverviewMapQuerySchema,
  ProductOverviewMapPage: productOverviewMapPageSchema,
  ProductParticipationQuery: productParticipationQuerySchema,
  ProductParticipationPage: productParticipationPageSchema,
  ProductParticipationReplace: productParticipationReplaceSchema,
  ProductParticipationSaved: productParticipationSavedSchema,
  ProductImplementationDetail: productImplementationDetailSchema,
};
