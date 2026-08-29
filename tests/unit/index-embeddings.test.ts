import { describe, expect, it } from 'vitest';
import { resolveEmbeddingIndexConfiguration } from '../../scripts/index-embeddings.js';

describe('embedding index configuration', () => {
  it('uses the fixed 1536-dimensional OpenRouter default embedding profile', () => {
    const configuration = resolveEmbeddingIndexConfiguration({
      AI_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: 'server-only-key'
    });

    expect(configuration.profile).toEqual({
      provider: 'openrouter',
      model: 'openai/text-embedding-3-small',
      dimension: 1536,
      profile: 'openrouter-openai-text-embedding-3-small-1536',
      version: 'v1',
      normalization: 'l2'
    });
  });

  it('rejects a custom OpenRouter embedding model without an explicit dimension', () => {
    expect(() => resolveEmbeddingIndexConfiguration({
      AI_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: 'server-only-key',
      OPENROUTER_EMBEDDING_MODEL: 'vendor/custom-embedding-model'
    })).toThrow('OPENROUTER_EMBEDDING_DIMENSION');
  });

  it('uses an explicitly dimensioned custom OpenRouter embedding profile', () => {
    const configuration = resolveEmbeddingIndexConfiguration({
      AI_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: 'server-only-key',
      OPENROUTER_EMBEDDING_MODEL: 'vendor/custom-embedding-model',
      OPENROUTER_EMBEDDING_DIMENSION: '768'
    });

    expect(configuration.profile).toEqual({
      provider: 'openrouter',
      model: 'vendor/custom-embedding-model',
      dimension: 768,
      profile: 'openrouter-vendor-custom-embedding-model-768',
      version: 'v1',
      normalization: 'l2'
    });
  });

  it.each(['0', '1.5', '16001', 'not-a-number'])('rejects unsafe OpenRouter embedding dimension %s', (dimension) => {
    expect(() => resolveEmbeddingIndexConfiguration({
      AI_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: 'server-only-key',
      OPENROUTER_EMBEDDING_MODEL: 'vendor/custom-embedding-model',
      OPENROUTER_EMBEDDING_DIMENSION: dimension
    })).toThrow('OPENROUTER_EMBEDDING_DIMENSION must be an integer between 1 and 16000');
  });

  it('rejects a dimension override for the fixed OpenRouter default model', () => {
    expect(() => resolveEmbeddingIndexConfiguration({
      AI_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: 'server-only-key',
      OPENROUTER_EMBEDDING_DIMENSION: '768'
    })).toThrow('default OpenRouter embedding model requires dimension 1536');
  });
});
