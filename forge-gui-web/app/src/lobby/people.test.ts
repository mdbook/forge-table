import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AiPhoto } from './people';

describe("the Neural AI's picture", () => {
  const html = (src: string | null | undefined) =>
    renderToStaticMarkup(createElement(AiPhoto, { src, alt: 'Ada', className: 'plate-photo', fallback: createElement('span', { className: 'plate-monogram' }, 'A') }));

  it('is a round img named by the label when the server has one', () => {
    // React's server render adds a preload <link> for the image ahead of it.
    expect(html('/img/avatar/neural').replace(/^<link [^>]*>/, '')).toBe('<img class="ai-photo plate-photo" src="/img/avatar/neural" alt="Ada" draggable="false" data-testid="ai-photo"/>');
  });

  it('is the fallback (the monogram, the glyph) when there is none', () => {
    expect(html(null)).toBe('<span class="plate-monogram">A</span>');
    expect(html(undefined)).toBe('<span class="plate-monogram">A</span>');
    expect(html('')).toBe('<span class="plate-monogram">A</span>');
  });
});
