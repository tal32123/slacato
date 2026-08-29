export type ModelAlias = 'brief' | 'specialist' | 'compaction' | 'embedding';

/** Configuration-only registry: it contains no provider SDK or business vocabulary. */
export type RegisteredModel = Readonly<{
  providerId: string;
  modelId: string;
  contextWindowTokens?: number;
  nativeStructuredOutput?: boolean;
}>;

/** Keeps the configured provider model for each application workload. */
export class ModelRegistry {
  private readonly entries = new Map<ModelAlias, RegisteredModel>();

  /** Assigns a provider model to an unconfigured workload alias. */
  public register(alias: ModelAlias, model: RegisteredModel): void {
    if (this.entries.has(alias)) throw new Error(`Model alias already registered: ${alias}`);
    this.entries.set(alias, { ...model });
  }

  /** Returns the provider model configured for a workload alias. */
  public resolve(alias: ModelAlias): RegisteredModel {
    const model = this.entries.get(alias);
    if (model === undefined) throw new Error(`No model registered for alias: ${alias}`);
    return model;
  }
}
