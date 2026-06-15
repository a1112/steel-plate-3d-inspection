import { describe, expect, it } from 'vitest';
import { canStartTitlebarDrag } from './titlebar-drag';

function elementFromMarkup(markup: string, selector: string) {
  document.body.innerHTML = markup;
  const element = document.querySelector(selector);
  if (!element) {
    throw new Error(`Missing test element: ${selector}`);
  }
  return element;
}

describe('canStartTitlebarDrag', () => {
  it('allows static status and brand areas to start native dragging', () => {
    expect(canStartTitlebarDrag(elementFromMarkup('<div class="status-block"><strong>正常</strong></div>', 'strong'))).toBe(true);
    expect(canStartTitlebarDrag(elementFromMarkup('<div class="system-title"><strong>检测系统</strong></div>', 'strong'))).toBe(true);
    expect(canStartTitlebarDrag(elementFromMarkup('<img class="ustb-logo" alt="北科工研" />', 'img'))).toBe(true);
  });

  it('blocks dragging from interactive controls', () => {
    expect(canStartTitlebarDrag(elementFromMarkup('<button><span>切换主题</span></button>', 'span'))).toBe(false);
    expect(canStartTitlebarDrag(elementFromMarkup('<div data-no-drag><svg><path /></svg></div>', 'svg'))).toBe(false);
    expect(canStartTitlebarDrag(elementFromMarkup('<input value="abc" />', 'input'))).toBe(false);
  });
});
