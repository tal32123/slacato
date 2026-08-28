export type ModelAlias = 'brief' | 'specialist' | 'compaction' | 'embedding';

/** Configuration-only registry: it contains no provider SDK or business vocabulary. */
export type RegisteredModel = Readonly<{
  providerId: string;
  modelId: string;
  contextWindowTokens?: number;
  nativeStructuredOutput?: boolean;
}>;

export class ModelRegistry {
  private readonly entries = new Map<ModelAlias, RegisteredModel>();

  public register(alias: ModelAlias, model: RegisteredModel): void {
    if (this.entries.has(alias)) throw new Error(`Model alias already registered: ${alias}`);
    this.entries.set(alias, { ...model });
  }

  public resolve(alias: ModelAlias): RegisteredModel {
    const model = this.entries.get(alias);
    if (model === undefined) throw new Error(`No model registered for alias: ${alias}`);
    return model;
  }
}
