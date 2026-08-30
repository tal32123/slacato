import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ESLint } from 'eslint';
import { afterEach, describe, expect, it } from 'vitest';

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { force: true })));
});

describe('architectural boundary lint policy', () => {
  it.each([
    ['packages/core/src', '../../infrastructure/src/index.ts'],
    ['packages/infrastructure/src', '../../../apps/api/src/main.ts'],
    ['apps/web/src', '../../../packages/infrastructure/src/index.ts'],
    ['apps/api/src', '../../../packages/infrastructure/src/index.ts'],
    ['scripts', '../apps/web/src/main.tsx']
  ])('rejects %s importing %s outside its composition root', async (directory, source) => {
    const file = join(process.cwd(), directory, `boundary-fixture-${randomUUID()}.ts`);
    created.push(file);
    await writeFile(file, `import '${source}';\nexport {};\n`);
    const eslint = new ESLint({ cwd: process.cwd() });

    const [result] = await eslint.lintFiles([file]);

    expect(result?.messages.some((message) => message.ruleId === 'boundaries/dependencies')).toBe(true);
  });

  it('permits only the documented API composition root to import infrastructure', async () => {
    const eslint = new ESLint({ cwd: process.cwd() });
    const [result] = await eslint.lintFiles(['apps/api/src/main.ts']);

    expect(result?.messages.some((message) => message.ruleId === 'boundaries/dependencies')).toBe(false);
  });

  it('rejects a specialist importing another specialist agent', async () => {
    const eslint = new ESLint({ cwd: process.cwd() });
    const [result] = await eslint.lintText("import './conversation.js';\nexport {};\n", {
      filePath: 'packages/core/src/application/agents/strategy.ts'
    });

    expect(result?.messages.some((message) => message.ruleId === 'no-restricted-imports')).toBe(true);
  });

  it('permits scripts to depend on core, contracts, and infrastructure', async () => {
    const eslint = new ESLint({ cwd: process.cwd() });
    const [result] = await eslint.lintFiles(['scripts/ingest.ts']);

    expect(result?.messages.some((message) => message.ruleId === 'boundaries/dependencies')).toBe(false);
    expect(result?.messages.some((message) => message.ruleId === 'boundaries/no-unknown-files')).toBe(false);
  });

  it.each([
    ['node:fs'],
    ['node:fs/promises'],
    ['node:path'],
    ['node:child_process']
  ])('rejects packages/core importing %s directly', async (source) => {
    const eslint = new ESLint({ cwd: process.cwd() });
    const [result] = await eslint.lintText(`import '${source}';\nexport {};\n`, {
      filePath: 'packages/core/src/application/evidence/boundary-fixture.ts'
    });

    expect(result?.messages.some((message) => message.ruleId === 'no-restricted-imports')).toBe(true);
  });

  it('still permits packages/core importing node:crypto for pure hashing', async () => {
    const eslint = new ESLint({ cwd: process.cwd() });
    const [result] = await eslint.lintText("import { createHash } from 'node:crypto';\nexport {};\n", {
      filePath: 'packages/core/src/application/evidence/boundary-fixture.ts'
    });

    expect(result?.messages.some((message) => message.ruleId === 'no-restricted-imports')).toBe(false);
  });
});
