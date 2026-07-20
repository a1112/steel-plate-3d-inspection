import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const stylesCss = readFileSync('src/styles.css', 'utf8');

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ruleBlocks(selector) {
  const pattern = new RegExp(`(?:^|[{}])\\s*${escapeRegExp(selector)}\\s*\\{([^}]*)\\}`, 'g');
  return Array.from(stylesCss.matchAll(pattern), (match) => match[1]);
}

function firstRule(selector) {
  const [block] = ruleBlocks(selector);
  expect(block, `missing CSS rule ${selector}`).toBeDefined();
  return block;
}

function declaration(block, property) {
  return block.match(new RegExp(`(?:^|\\n)\\s*${escapeRegExp(property)}\\s*:\\s*([^;]+);`))?.[1].trim();
}

function expectDeclaration(selector, property, value) {
  expect(declaration(firstRule(selector), property), `${selector} ${property}`).toBe(value);
}

function expectEveryDeclaredValue(selector, property, value) {
  const declaredValues = ruleBlocks(selector)
    .map((block) => declaration(block, property))
    .filter(Boolean);

  expect(declaredValues.length, `missing ${property} declarations for ${selector}`).toBeGreaterThan(0);
  expect(new Set(declaredValues), `${selector} must not override ${property} with a legacy value`).toEqual(new Set([value]));
}

describe('compact online detection layout CSS contract', () => {
  it('keeps the header and online workspace compact', () => {
    expectDeclaration('.brand-header', 'height', '50px');
    expectDeclaration('.brand-header', 'grid-template-columns', 'auto minmax(0, 1fr) auto auto');
    expectDeclaration('.brand-header', 'gap', '8px');
    expectDeclaration('.brand-header', 'padding', '3px 6px');
    expectDeclaration('.ustb-logo', 'width', '164px');
    expectDeclaration('.ustb-logo', 'height', '42px');

    expectDeclaration('.online-workspace', 'gap', '6px');
    expectDeclaration('.online-workspace', 'padding', '0 8px 8px');
    expectDeclaration('.dashboard-grid.online-dashboard-grid', 'gap', '6px');
    expectDeclaration('.dashboard-grid.online-dashboard-grid', 'padding', '6px 0 0');
  });

  it('centers the title in the space remaining after the embedded navigation', () => {
    expectDeclaration('.title-meta-group', 'display', 'grid');
    expectDeclaration('.title-meta-group', 'grid-template-columns', 'auto minmax(0, 1fr)');
    expectDeclaration('.title-meta-group', 'gap', '10px');
    expectDeclaration('.title-meta-group', 'width', '100%');
    expectDeclaration('.title-meta-group', 'min-width', '0');
    expectDeclaration('.system-title', 'justify-self', 'center');
    expectDeclaration('.system-title', 'min-width', '0');
    expectDeclaration('.system-title', 'font-size', '22px');
    expectDeclaration('.system-title', 'text-align', 'center');
    expectDeclaration('.brand-header .top-nav.top-nav-embedded', 'height', '30px');
    expectDeclaration('.brand-header .top-nav.top-nav-embedded button', 'height', '30px');
  });

  it('uses a compact filter row above the flexible defect list', () => {
    expectDeclaration('.right-column', 'grid-template-rows', 'auto minmax(0, 1fr)');
    expectDeclaration('.right-column', 'gap', '6px');
    expectDeclaration('.defect-filter-panel .panel-body', 'padding', '6px 8px 8px');
    expectDeclaration('.defect-type-filter', 'height', '30px');
    expectDeclaration('.severity-filter-inline', 'height', '24px');
  });

  it('preserves compact defect filter sizing across every themed style cascade', () => {
    const selector = ".app-shell[class*='style-'] .defect-filter-panel .panel-body";
    expectDeclaration(selector, 'height', 'auto');
    expectDeclaration(selector, 'padding', '6px 8px 8px');
  });

  it('uses category-like tinted severity selection instead of a solid fill', () => {
    const active = firstRule('.severity-filter-inline.active');
    expect(declaration(active, 'color')).toBe('var(--severity-color)');
    expect(declaration(active, 'border-color')).toBe('var(--severity-color)');
    expect(declaration(active, 'background')).toBe(
      'color-mix(in srgb, var(--severity-color) 16%, var(--panel))',
    );
    expect(active).not.toMatch(/background\s*:\s*var\(--severity-color\)/);
    expect(declaration(firstRule('.severity-filter-inline.active strong'), 'color')).toBe('var(--severity-color)');

    const lightActive = firstRule('.theme-light .severity-filter-inline.active');
    expect(declaration(lightActive, 'color')).toBe('var(--severity-color)');
    expect(declaration(lightActive, 'background')).toBe(
      'color-mix(in srgb, var(--severity-color) 16%, white)',
    );
    expect(lightActive).not.toMatch(/color\s*:\s*#fff|background\s*:\s*var\(--severity-color\)/);
  });

  it('does not restore legacy spacing through density, responsive, or theme overrides', () => {
    expectEveryDeclaredValue('.brand-header', 'height', '50px');
    expectEveryDeclaredValue('.online-workspace', 'gap', '6px');
    expectEveryDeclaredValue('.online-workspace', 'padding', '0 8px 8px');
    expectEveryDeclaredValue('.dashboard-grid.online-dashboard-grid', 'gap', '6px');
    expectEveryDeclaredValue('.dashboard-grid.online-dashboard-grid', 'padding', '6px 0 0');
    expectEveryDeclaredValue('.right-column', 'grid-template-rows', 'auto minmax(0, 1fr)');
    expectEveryDeclaredValue('.right-column', 'gap', '6px');

    expectDeclaration('.density-dense .online-workspace', 'gap', '6px');
    expectDeclaration('.density-dense .online-workspace', 'padding', '0 8px 8px');
    expectDeclaration('.density-dense .dashboard-grid.online-dashboard-grid', 'gap', '6px');
    expectDeclaration('.density-dense .dashboard-grid.online-dashboard-grid', 'padding', '6px 0 0');
    expectDeclaration('.theme-dark .online-workspace', 'gap', '6px');
    expectDeclaration('.theme-dark .online-workspace', 'padding', '0 8px 8px');
    expectDeclaration('.theme-dark .dashboard-grid.online-dashboard-grid', 'gap', '6px');
    expectDeclaration('.theme-dark .right-column', 'gap', '6px');
    expectDeclaration('.theme-dark .right-column', 'grid-template-rows', 'auto minmax(0, 1fr)');

    const denseColumnGroup = firstRule(
      '.density-dense .left-column,\n.density-dense .center-column,\n.density-dense .right-column',
    );
    expect(declaration(denseColumnGroup, 'gap')).toBe('6px');
  });
});
