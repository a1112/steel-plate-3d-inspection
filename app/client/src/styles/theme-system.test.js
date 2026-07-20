import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const themeSystemCss = readFileSync('src/styles/theme-system.css', 'utf8');
const LIGHT_STYLE_NAMES = ['soft', 'tech', 'industrial', 'modern'];

function relativeLuminance(hex) {
  const channels = hex.match(/[a-f\d]{2}/gi)?.map((channel) => {
    const value = Number.parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  if (!channels || channels.length !== 3) {
    throw new Error(`Invalid RGB color: ${hex}`);
  }
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(first, second) {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

describe('light theme style accessibility', () => {
  it.each(LIGHT_STYLE_NAMES)('keeps white control text readable on the %s accent', (styleName) => {
    const selector = `.app-shell.style-${styleName}.theme-light`;
    const blockStart = themeSystemCss.indexOf(selector);
    const blockEnd = themeSystemCss.indexOf('}', blockStart);
    const styleBlock = themeSystemCss.slice(blockStart, blockEnd);
    const accent = styleBlock.match(/--style-accent:\s*(#[a-f\d]{6})/i)?.[1];

    expect(blockStart, `missing ${selector}`).toBeGreaterThanOrEqual(0);
    expect(accent, `missing light ${styleName} accent`).toBeDefined();
    expect(contrastRatio(accent, '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });
});
