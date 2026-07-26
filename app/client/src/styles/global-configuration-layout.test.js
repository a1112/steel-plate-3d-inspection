import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const stylesCss = readFileSync('src/styles.css', 'utf8').replace(/\r\n?/g, '\n');

function declaration(selector, property) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = stylesCss.match(new RegExp(`(?:^|[{}])\\s*${escaped}\\s*\\{([^}]*)\\}`))?.[1];
  expect(block, `missing CSS rule ${selector}`).toBeDefined();
  return block.match(new RegExp(`(?:^|\\n)\\s*${property}\\s*:\\s*([^;]+);`))?.[1].trim();
}

describe('global configuration layout CSS contract', () => {
  it('stretches the configuration workspace through the card body', () => {
    expect(declaration('.global-configuration-card', 'display')).toBe('grid');
    expect(declaration('.global-configuration-card', 'grid-template-rows')).toBe(
      'auto minmax(0, 1fr)',
    );
    expect(declaration('.global-configuration-card > .panel-body', 'display')).toBe('flex');
    expect(declaration('.global-configuration-card > .panel-body', 'flex-direction')).toBe(
      'column',
    );
    expect(declaration('.site-config-workspace', 'flex')).toBe('1 1 auto');
  });
});
