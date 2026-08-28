/** Facts observed by a credentialed probe; do not substitute assumptions for these values. */
export type OllamaCapabilities = Readonly<{
  generationModelId: string;
  embeddingModelId: string;
  nativeStructuredOutput: boolean;
  embeddingDimension: number;
  embeddingUnitNormalized: boolean;
  warnings: readonly string[];
  probedAt: string;
}>;

export type OllamaCapabilityProbe = Readonly<{
  generationModelId: string;
  embeddingModelId: string;
  availableModelIds: readonly string[];
  nativeStructuredOutput: boolean;
  embeddingDimension: number;
  embeddingUnitNormalized: boolean;
  warnings: readonly string[];
}>;
