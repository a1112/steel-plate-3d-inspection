import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const stylesCss = readFileSync('src/styles.css', 'utf8').replace(/\r\n?/g, '\n');

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

function lastRule(selector) {
  const blocks = ruleBlocks(selector);
  const block = blocks.at(-1);
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
    expectDeclaration('.online-workspace', 'grid-template-columns', 'clamp(275px, 18.8vw, 300px) minmax(0, 1fr)');
    expectDeclaration('.dashboard-grid.online-dashboard-grid', 'gap', '6px');
    expectDeclaration('.dashboard-grid.online-dashboard-grid', 'padding', '6px 0 0');
    expectDeclaration('.dashboard-grid.online-dashboard-grid', 'grid-template-columns', 'minmax(0, 1fr) clamp(285px, 19vw, 315px)');
    expectDeclaration('.app-footer', 'height', '34px');
    expectDeclaration('.app-footer', 'flex', '0 0 34px');
  });

  it('centers the title in the space remaining after the embedded navigation', () => {
    expectDeclaration('.title-meta-group', 'display', 'grid');
    expectDeclaration('.title-meta-group', 'grid-template-columns', 'auto minmax(0, 1fr)');
    expectDeclaration('.title-meta-group', 'gap', '10px');
    expectDeclaration('.title-meta-group', 'width', '100%');
    expectDeclaration('.title-meta-group', 'min-width', '0');
    expectDeclaration('.system-title', 'justify-self', 'center');
    expectDeclaration('.system-title', 'min-width', '0');
    expectDeclaration('.system-title', 'width', '100%');
    expectDeclaration('.system-title', 'font-size', '22px');
    expectDeclaration('.system-title', 'text-align', 'center');
    expectDeclaration('.brand-header .top-nav.top-nav-embedded', 'height', '30px');
    expectDeclaration('.brand-header .top-nav.top-nav-embedded button', 'height', '30px');
  });

  it('uses one bold blue value treatment across the BKV runtime status blocks', () => {
    expectDeclaration('.brand-status.bkv-runtime-status .status-block span', 'font-weight', '950');
    expectDeclaration('.brand-status.bkv-runtime-status .status-block strong', 'color', 'var(--blue)');
    expectDeclaration('.brand-status.bkv-runtime-status .status-block strong', 'font-weight', '950');
    expectDeclaration('.brand-status.bkv-runtime-status .status-block strong.ok', 'color', 'var(--blue)');
    expectDeclaration('.brand-status.bkv-runtime-status > .bkv-mode-status', 'background', 'transparent');
  });

  it('uses compact defect image and filter rows above the flexible defect list', () => {
    expectDeclaration('.right-column', 'grid-template-rows', 'auto auto minmax(0, 1fr)');
    expectDeclaration('.right-column', 'gap', '6px');
    expectDeclaration('.defect-filter-panel .panel-body', 'padding', '6px 8px 8px');
    expectDeclaration('.defect-type-filter', 'height', '30px');
    expectDeclaration('.severity-filter-inline', 'height', '24px');
  });

  it('keeps the expanded analysis area short and the collapsed layout single-row', () => {
    expectDeclaration('.center-column', 'grid-template-rows', 'minmax(0, 1fr) minmax(150px, 0.25fr)');
    expectDeclaration('.theme-dark .center-column', 'grid-template-rows', 'minmax(0, 1fr) minmax(150px, 0.25fr)');
    expectDeclaration('.center-column.analysis-collapsed', 'grid-template-rows', 'minmax(0, 1fr)');

    const centerRows = ruleBlocks('.center-column')
      .map((block) => declaration(block, 'grid-template-rows'))
      .filter(Boolean);
    expect(centerRows).toContain('minmax(0, 1fr) minmax(120px, 0.2fr)');
    expect(centerRows.every((rows) => !rows.includes('220px') && !rows.includes('240px'))).toBe(true);

    expectDeclaration('.window-controls .window-analysis-collapse', 'border-right', '1px solid var(--line)');
    expect(stylesCss).not.toContain('.app-footer-collapse');
  });

  it('lets the main view consume the released defect-sidebar width', () => {
    expect(
      declaration(
        lastRule('.dashboard-grid.online-dashboard-grid.right-sidebar-collapsed'),
        'grid-template-columns',
      ),
    ).toBe('minmax(0, 1fr)');
  });

  it('keeps the unfolded image free of decorative contour overlays', () => {
    expect(stylesCss).not.toContain('.bar-unfolded-canvas::before');
    expect(stylesCss).not.toContain('.bar-camera-band[role="button"]::after');
    expect(stylesCss).not.toContain('.bar-camera-band[role="button"]:hover .bar-camera-band-image');
    expect(stylesCss).not.toContain('.bar-camera-frame::after');
    expectDeclaration('.bar-camera-band', 'border-top', '0');
    expectDeclaration('.bar-camera-frame', 'border-right', '0');
    expectDeclaration('.bar-camera-frame', 'box-shadow', 'none');
    expectDeclaration('.bar-unfolded-map.orientation-vertical .bar-camera-band', 'border-left', '0');
    expectDeclaration('.bar-unfolded-map.orientation-vertical .bar-camera-frame', 'border-bottom', '0');
  });

  it('renders production defect markers as one-pixel transparent rectangles', () => {
    expectDeclaration('.defect-image-rect', 'border', '1px solid var(--defect-color, #ff3b30)');
    expectDeclaration('.defect-image-rect', 'background', 'transparent');
    expectDeclaration('.defect-image-rect', 'box-shadow', 'none');
    const selectedMarker = firstRule('.defect-image-rect:hover,\n.defect-image-rect:focus-visible,\n.defect-image-rect.selected');
    expect(declaration(selectedMarker, 'border-width')).toBe('1px');
    expect(declaration(selectedMarker, 'outline')).toBe('none');
    expect(declaration(selectedMarker, 'background')).toBe('transparent');
    const lightMarker = firstRule('.theme-light button.defect-image-rect:not(.primary):not(.active):not(.severity-filter-inline),\n.theme-light button.defect-image-rect:not(.primary):not(.active):not(.severity-filter-inline):hover,\n.theme-light button.defect-image-rect:not(.primary):not(.active):not(.severity-filter-inline):focus-visible,\n.theme-light button.defect-image-rect.selected:not(.primary):not(.active):not(.severity-filter-inline)');
    expect(declaration(lightMarker, 'border')).toBe('1px solid var(--defect-color, #ff3b30)');
    expect(declaration(lightMarker, 'background')).toBe('transparent');
    expect(declaration(lightMarker, 'box-shadow')).toBe('none');
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

  it.each(['severe', 'review', 'minor'])(
    'keeps the %s severity button color aligned with its border and tint',
    (severity) => {
      expectDeclaration(
        `.severity-filter-inline.${severity}`,
        'color',
        'var(--severity-color) !important',
      );
    },
  );

  it('does not restore legacy spacing through density, responsive, or theme overrides', () => {
    expectEveryDeclaredValue('.brand-header', 'height', '50px');
    expectEveryDeclaredValue('.online-workspace', 'gap', '6px');
    expectEveryDeclaredValue('.online-workspace', 'padding', '0 8px 8px');
    expectEveryDeclaredValue('.dashboard-grid.online-dashboard-grid', 'gap', '6px');
    expectEveryDeclaredValue('.dashboard-grid.online-dashboard-grid', 'padding', '6px 0 0');
    expectEveryDeclaredValue('.right-column', 'grid-template-rows', 'auto auto minmax(0, 1fr)');
    expectEveryDeclaredValue('.right-column', 'gap', '6px');

    expectDeclaration('.density-dense .online-workspace', 'gap', '6px');
    expectDeclaration('.density-dense .online-workspace', 'padding', '0 8px 8px');
    expectDeclaration('.density-dense .online-workspace', 'grid-template-columns', 'clamp(270px, 20vw, 290px) minmax(0, 1fr)');
    expectDeclaration('.density-dense .dashboard-grid.online-dashboard-grid', 'gap', '6px');
    expectDeclaration('.density-dense .dashboard-grid.online-dashboard-grid', 'padding', '6px 0 0');
    expectDeclaration('.density-dense .dashboard-grid.online-dashboard-grid', 'grid-template-columns', 'minmax(0, 1fr) clamp(270px, 20vw, 292px)');
    expectDeclaration('.theme-dark .online-workspace', 'gap', '6px');
    expectDeclaration('.theme-dark .online-workspace', 'padding', '0 8px 8px');
    expectDeclaration('.theme-dark .dashboard-grid.online-dashboard-grid', 'gap', '6px');
    expectDeclaration('.theme-dark .right-column', 'gap', '6px');
    expectDeclaration('.theme-dark .right-column', 'grid-template-rows', 'auto auto minmax(0, 1fr)');

    const denseColumnGroup = firstRule(
      '.density-dense .left-column,\n.density-dense .center-column,\n.density-dense .right-column',
    );
    expect(declaration(denseColumnGroup, 'gap')).toBe('6px');
  });
});
