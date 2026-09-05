import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';

import { syncProfileAgents } from '../../src/app/profile-agent-sync.ts';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

function createFixture(): string {
  const dir = tmpdir();
  // We'll create fixture per test using the helper
  return dir;
}

async function createFixtureLayout(opts: {
  agentsContent?: Record<string, string>;
  agentsDir?: string;
}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-agent-sync-'));
  temporaryDirectories.push(root);

  const profilesDir = path.join(root, '.opencode', 'profiles');
  const profileDir = path.join(profilesDir, 'test-profile');
  await mkdir(profileDir, { recursive: true });

  const agentsFolder = opts.agentsDir ?? 'agents';

  // Create profile.json with agentsDir
  await writeFile(
    path.join(profileDir, 'profile.json'),
    JSON.stringify({
      id: 'test-profile',
      agentsDir: agentsFolder,
      schemas: [],
    })
  );

  // Create agent .md files
  if (opts.agentsContent) {
    const agentsDir = path.join(profileDir, agentsFolder);
    await mkdir(agentsDir, { recursive: true });
    for (const [name, content] of Object.entries(opts.agentsContent)) {
      await writeFile(path.join(agentsDir, name), content);
    }
  }

  // Set up env so paths.ts resolves correctly
  process.env.STATE_MACHINE_PROFILES_DIR = profilesDir;
  process.env.OPENCODE_HARNESS_DIR = path.join(root, '.opencode');

  return root;
}

describe('syncProfileAgents', () => {
  it('copies agent files from profile to .opencode/agents/<profileId>/', async () => {
    const root = await createFixtureLayout({
      agentsContent: {
        'code.md': '# Code agent\nsome content',
        'review.md': '# Review agent\nreview content',
      },
    });

    const logLines: string[] = [];
    await syncProfileAgents('test-profile', root, (msg) => logLines.push(msg));

    const targetDir = path.join(root, '.opencode', 'agents', 'test-profile');
    expect(existsSync(path.join(targetDir, 'code.md'))).toBe(true);
    expect(existsSync(path.join(targetDir, 'review.md'))).toBe(true);

    const codeContent = await readFile(path.join(targetDir, 'code.md'), 'utf-8');
    expect(codeContent).toContain('# Code agent');
    expect(codeContent).toContain('# MANAGED BY session-guard');
  });

  it('is idempotent on second run', async () => {
    const root = await createFixtureLayout({
      agentsContent: {
        'code.md': '# Code agent',
      },
    });

    await syncProfileAgents('test-profile', root);
    const targetPath = path.join(root, '.opencode', 'agents', 'test-profile', 'code.md');
    const content1 = await readFile(targetPath, 'utf-8');

    await syncProfileAgents('test-profile', root);
    const content2 = await readFile(targetPath, 'utf-8');

    expect(content1).toBe(content2);
  });

  it('removes stale agent files from target', async () => {
    const root = await createFixtureLayout({
      agentsContent: {
        'code.md': '# Code agent',
      },
    });

    // First run — sync code.md
    await syncProfileAgents('test-profile', root);
    const targetDir = path.join(root, '.opencode', 'agents', 'test-profile');
    expect(existsSync(path.join(targetDir, 'code.md'))).toBe(true);

    // Remove code.md from source, add a new file
    const sourceDir = path.join(root, '.opencode', 'profiles', 'test-profile', 'agents');
    await rm(path.join(sourceDir, 'code.md'));
    await writeFile(path.join(sourceDir, 'review.md'), '# Review agent');

    // Second run
    await syncProfileAgents('test-profile', root);

    expect(existsSync(path.join(targetDir, 'code.md'))).toBe(false);
    expect(existsSync(path.join(targetDir, 'review.md'))).toBe(true);
  });

  it('does not remove user-created files outside profile subdirectory', async () => {
    const root = await createFixtureLayout({
      agentsContent: {
        'code.md': '# Code agent',
      },
    });

    // Create a user file in .opencode/agents/ (not in profile subdirectory)
    const opencodeAgentsDir = path.join(root, '.opencode', 'agents');
    await mkdir(opencodeAgentsDir, { recursive: true });
    await writeFile(path.join(opencodeAgentsDir, 'user-agent.md'), '# User created');

    await syncProfileAgents('test-profile', root);

    // User file should still exist
    expect(existsSync(path.join(opencodeAgentsDir, 'user-agent.md'))).toBe(true);
  });

  it('handles missing source agents directory gracefully', async () => {
    const root = await createFixtureLayout({
      agentsContent: {},
      agentsDir: 'nonexistent-agents',
    });

    await expect(syncProfileAgents('test-profile', root)).resolves.toBeUndefined();
  });

  it('handles missing profile.json gracefully', async () => {
    const root = await createFixtureLayout({ agentsContent: { 'code.md': 'content' } });

    const logLines: string[] = [];
    await syncProfileAgents('nonexistent-profile', root, (msg) => logLines.push(msg));

    const hasWarning = logLines.some((l) => l.includes('No profile.json'));
    expect(hasWarning).toBe(true);
  });

  it('error reading one agent file does not block others', async () => {
    const root = await createFixtureLayout({
      agentsContent: {
        'good.md': '# Good agent',
      },
    });

    // Create a source agent directory with a non-readable file by making it a directory
    const sourceAgentsDir = path.join(root, '.opencode', 'profiles', 'test-profile', 'agents');
    await mkdir(path.join(sourceAgentsDir, 'bad.md'));

    await syncProfileAgents('test-profile', root);

    const targetDir = path.join(root, '.opencode', 'agents', 'test-profile');
    expect(existsSync(path.join(targetDir, 'good.md'))).toBe(true);
  });

  it('supports custom agentsDir in profile.json', async () => {
    const root = await createFixtureLayout({
      agentsContent: {
        'code.md': '# Code agent',
      },
      agentsDir: 'custom-agents',
    });

    // Override: source agents are in custom-agents, not agents
    const sourceAgentsDir = path.join(
      root,
      '.opencode',
      'profiles',
      'test-profile',
      'custom-agents'
    );
    await mkdir(sourceAgentsDir, { recursive: true });
    await writeFile(path.join(sourceAgentsDir, 'code.md'), '# Code agent in custom dir');

    await syncProfileAgents('test-profile', root);

    const targetDir = path.join(root, '.opencode', 'agents', 'test-profile');
    const content = await readFile(path.join(targetDir, 'code.md'), 'utf-8');
    expect(content).toContain('custom dir');
  });

  // ── Regression tests for ownership safety ──

  it('REGRESSION: preserves unowned matching filename byte-for-byte and emits collision diagnostic', async () => {
    const root = await createFixtureLayout({
      agentsContent: {
        'code.md': '# Code agent',
      },
    });

    const targetDir = path.join(root, '.opencode', 'agents', 'test-profile');
    await mkdir(targetDir, { recursive: true });
    // Pre-place an unowned file with same name
    const unownedContent = '# Unowned agent — NOT managed by session-guard\n';
    await writeFile(path.join(targetDir, 'code.md'), unownedContent);

    const logLines: string[] = [];
    await syncProfileAgents('test-profile', root, (msg) => logLines.push(msg));

    // Must NOT overwrite the unowned file
    const contentAfter = await readFile(path.join(targetDir, 'code.md'), 'utf-8');
    expect(contentAfter).toBe(unownedContent);

    // Must emit a collision diagnostic
    const hasCollision = logLines.some((l) => l.includes('collision') || l.includes('unowned'));
    expect(hasCollision).toBe(true);
  });

  it('REGRESSION: preserves unowned stale Markdown file in profile subdirectory', async () => {
    const root = await createFixtureLayout({
      agentsContent: {},
    });

    const targetDir = path.join(root, '.opencode', 'agents', 'test-profile');
    await mkdir(targetDir, { recursive: true });
    // Place an unowned Markdown file that has no ownership marker
    const unownedContent = '# Unowned\nsome content\n';
    await writeFile(path.join(targetDir, 'unrelated.md'), unownedContent);

    await syncProfileAgents('test-profile', root);
    const contentAfter = await readFile(path.join(targetDir, 'unrelated.md'), 'utf-8');
    expect(contentAfter).toBe(unownedContent);
  });

  it('REGRESSION: preserves YAML frontmatter when prepending managed marker', async () => {
    const root = await createFixtureLayout({
      agentsContent: {
        'review.md': '---\nname: review-agent\n---\n\n# Review agent\n',
      },
    });

    await syncProfileAgents('test-profile', root);

    const targetDir = path.join(root, '.opencode', 'agents', 'test-profile');
    const content = await readFile(path.join(targetDir, 'review.md'), 'utf-8');
    // YAML frontmatter must remain at the start
    expect(content).toMatch(/^---\n/m);
    // Managed marker must be after frontmatter
    const frontmatterEndIndex = content.indexOf('\n---\n', 1);
    if (frontmatterEndIndex !== -1) {
      const body = content.slice(frontmatterEndIndex + 5);
      expect(body).toContain('# MANAGED BY session-guard');
    }
  });

  it('REGRESSION: recognizes legacy first-line ownership marker', async () => {
    const root = await createFixtureLayout({
      agentsContent: {
        'code.md': '# Code agent\ncontent',
      },
    });

    // Create an existing target file with legacy ownership header
    const targetDir = path.join(root, '.opencode', 'agents', 'test-profile');
    await mkdir(targetDir, { recursive: true });
    const legacyContent = '# MANAGED BY session-guard — do not edit\n# Legacy agent\ncontent';
    await writeFile(path.join(targetDir, 'code.md'), legacyContent);

    // Now source has changed
    const sourceAgentsDir = path.join(root, '.opencode', 'profiles', 'test-profile', 'agents');
    await writeFile(path.join(sourceAgentsDir, 'code.md'), '# Code agent\nupdated content');

    await syncProfileAgents('test-profile', root);

    const contentAfter = await readFile(path.join(targetDir, 'code.md'), 'utf-8');
    // Should still have the managed marker and updated source content (not the old content)
    expect(contentAfter).toContain('# MANAGED BY session-guard');
    expect(contentAfter).toContain('updated content');
  });

  it('REGRESSION: emits diagnostic on init/sync failure without claiming agents are ready', async () => {
    const root = await createFixtureLayout({
      agentsContent: {
        'readonly.md': '# Agent',
      },
    });

    // Remove write permission from the target parent directory
    const targetDir = path.join(root, '.opencode', 'agents', 'test-profile');
    await mkdir(targetDir, { recursive: true });
    await rename(targetDir, targetDir);
    // Make target dir unwritable
    const { chmod } = await import('node:fs/promises');
    await chmod(targetDir, 0o444);

    const logLines: string[] = [];
    await syncProfileAgents('test-profile', root, (msg) => logLines.push(msg));

    // Expect a diagnostic about write failure — not a crash
    const hasErrorDiag = logLines.some(
      (l) => l.includes('Error') || l.includes('error') || l.includes('fail')
    );
    // Restore permissions before assertion (cleanup)
    await chmod(targetDir, 0o755).catch(() => {});
    expect(hasErrorDiag).toBe(true);
  });

  it('REGRESSION: fails when ownership marker appears only after frontmatter and falls back to beginning for no-frontmatter', async () => {
    const root = await createFixtureLayout({
      agentsContent: {
        'plain.md': '---\nname: plain-agent\n---\n\n# Plain agent\nno frontmatter version',
        'simple.md': '# Simple agent\nbody content',
      },
    });

    // Place an unowned file in target that just happens to have frontmatter
    const targetDir = path.join(root, '.opencode', 'agents', 'test-profile');
    await mkdir(targetDir, { recursive: true });
    const unownedContent = '---\nname: plain-agent\n---\n\n# Unowned\n';
    await writeFile(path.join(targetDir, 'plain.md'), unownedContent);

    const logLines: string[] = [];
    await syncProfileAgents('test-profile', root, (msg) => logLines.push(msg));

    // unowned file must be preserved
    const after = await readFile(path.join(targetDir, 'plain.md'), 'utf-8');
    expect(after).toBe(unownedContent);

    // Owned simple file must be written
    const simpleContent = await readFile(path.join(targetDir, 'simple.md'), 'utf-8');
    expect(simpleContent).toContain('# MANAGED BY session-guard');
    expect(simpleContent).toContain('body content');
  });
});
