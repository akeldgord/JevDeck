import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { ProviderError } from './errors';

/**
 * Prompts are files, not string literals.
 *
 * Each prompt carries its version in its filename, and the hash of the bytes actually used is
 * recorded on the attempt. A missing or unreadable prompt is a hard failure: substituting a
 * hidden default would silently change what the pipeline does to every document, and the
 * recorded version would then be a lie.
 */

export const DEFAULT_PROMPTS_DIR = fileURLToPath(new URL('../../../prompts/', import.meta.url));

/** Prompt ids the pipeline requires. */
export const REQUIRED_PROMPTS = [
  'concepts/extract.v1',
  'cards/generate.v1',
  'validation/support.v1',
] as const;

export type PromptId = (typeof REQUIRED_PROMPTS)[number];

export interface LoadedPrompt {
  id: string;
  version: string;
  content: string;
  /** sha256 of the file bytes. Recorded per attempt so a run is reproducible. */
  hash: string;
}

export class PromptLibrary {
  private readonly prompts: Map<string, LoadedPrompt>;

  constructor(prompts: Map<string, LoadedPrompt>) {
    this.prompts = prompts;
  }

  /** Throws when the prompt is absent. There is deliberately no default. */
  require(id: PromptId): LoadedPrompt {
    const prompt = this.prompts.get(id);
    if (!prompt) {
      throw new ProviderError(
        'unknown',
        `Required prompt "${id}" is missing from the prompt directory. ` +
          'Restore it rather than falling back to a built-in default.'
      );
    }
    return prompt;
  }

  ids(): string[] {
    return [...this.prompts.keys()].sort();
  }
}

function versionFromFilename(filename: string): string {
  const match = filename.match(/\.(v\d+)\.md$/);
  return match ? match[1] : 'unversioned';
}

function walk(root: string, prefix = ''): Array<{ id: string; path: string }> {
  const found: Array<{ id: string; path: string }> = [];

  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      found.push(...walk(root, relative));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      found.push({ id: relative.replace(/\.md$/, ''), path: join(root, relative) });
    }
  }

  return found;
}

/**
 * Reads every `.md` file under the prompt directory.
 *
 * A missing directory is not fatal here — `require` is what fails, and it names the exact
 * prompt that is missing.
 */
export function loadPromptLibrary(dir: string = DEFAULT_PROMPTS_DIR): PromptLibrary {
  const prompts = new Map<string, LoadedPrompt>();

  let entries: Array<{ id: string; path: string }>;
  try {
    entries = walk(dir);
  } catch {
    return new PromptLibrary(prompts);
  }

  for (const entry of entries) {
    const content = readFileSync(entry.path, 'utf8');
    prompts.set(entry.id, {
      id: entry.id,
      // The version lives in the filename, `.md` included, so read it from the path.
      version: versionFromFilename(entry.path),
      content,
      hash: createHash('sha256').update(content).digest('hex'),
    });
  }

  return new PromptLibrary(prompts);
}
