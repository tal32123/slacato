export type DiagnosticsModuleOptions = Readonly<{
  provider: 'mock' | 'ollama' | 'openrouter';
  pinnedGenerationModel: string;
  pinnedEmbeddingModel: string;
}>;

export const DIAGNOSTICS_OPTIONS = Symbol('DIAGNOSTICS_OPTIONS');
