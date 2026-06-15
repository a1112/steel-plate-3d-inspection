const NON_DRAGGABLE_SELECTOR = [
  '[data-no-drag]',
  'button',
  'input',
  'select',
  'textarea',
  'a',
  '[role="button"]',
  '[contenteditable="true"]',
].join(',');

export function canStartTitlebarDrag(target: EventTarget | null) {
  if (!(target instanceof Element)) {
    return true;
  }

  return !target.closest(NON_DRAGGABLE_SELECTOR);
}
