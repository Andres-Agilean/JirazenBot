import { describe, expect, it } from 'vitest';
import { adfToMarkdown, type AdfNode } from '../src/fetch/adf.js';

const doc = (...content: AdfNode[]): AdfNode => ({ type: 'doc', content });
const para = (...content: AdfNode[]): AdfNode => ({ type: 'paragraph', content });
const text = (t: string, marks?: AdfNode['marks']): AdfNode => ({ type: 'text', text: t, ...(marks ? { marks } : {}) });

describe('adfToMarkdown', () => {
  it('passes strings through and maps null to empty', () => {
    expect(adfToMarkdown('já é texto')).toBe('já é texto');
    expect(adfToMarkdown(null)).toBe('');
  });

  it('renders paragraphs and text marks', () => {
    expect(adfToMarkdown(doc(para(text('a '), text('b', [{ type: 'strong' }]), text(' '), text('c', [{ type: 'em' }]), text(' '), text('d', [{ type: 'code' }]))))).toBe('a **b** *c* `d`');
  });

  it('renders links', () => {
    expect(adfToMarkdown(doc(para(text('docs', [{ type: 'link', attrs: { href: 'https://x.io' } }]))))).toBe('[docs](https://x.io)');
  });

  it('renders bullet and ordered lists', () => {
    const md = adfToMarkdown(doc(
      { type: 'bulletList', content: [ { type: 'listItem', content: [para(text('um'))] }, { type: 'listItem', content: [para(text('dois'))] } ] },
      { type: 'orderedList', content: [ { type: 'listItem', content: [para(text('primeiro'))] } ] },
    ));
    expect(md).toBe('- um\n- dois\n\n1. primeiro');
  });

  it('renders code blocks, headings, blockquotes and rules', () => {
    const md = adfToMarkdown(doc(
      { type: 'heading', attrs: { level: 2 }, content: [text('Título')] },
      { type: 'codeBlock', attrs: { language: 'ts' }, content: [text('const a = 1;')] },
      { type: 'blockquote', content: [para(text('citado'))] },
      { type: 'rule' },
    ));
    expect(md).toBe('## Título\n\n```ts\nconst a = 1;\n```\n\n> citado\n\n---');
  });

  it('renders tables as markdown tables', () => {
    const cell = (t: string, header = false): AdfNode => ({ type: header ? 'tableHeader' : 'tableCell', content: [para(text(t))] });
    const md = adfToMarkdown(doc({ type: 'table', content: [
      { type: 'tableRow', content: [cell('col1', true), cell('col2', true)] },
      { type: 'tableRow', content: [cell('a'), cell('b')] },
    ] }));
    expect(md).toBe('| col1 | col2 |\n| --- | --- |\n| a | b |');
  });

  it('resolves mentions to display names and hardBreak to newline', () => {
    expect(adfToMarkdown(doc(para({ type: 'mention', attrs: { text: '@Heitor Alves' } }, { type: 'hardBreak' }, text('oi'))))).toBe('@Heitor Alves\noi');
  });

  it('notes media as attachment placeholders and unwraps panels', () => {
    const md = adfToMarkdown(doc(
      { type: 'panel', attrs: { panelType: 'info' }, content: [para(text('atenção'))] },
      { type: 'mediaGroup', content: [ { type: 'media', attrs: { type: 'file', alt: 'video.mp4' } } ] },
    ));
    expect(md).toBe('atenção\n\n[anexo: video.mp4]');
  });

  it('ignores unknown node types but keeps their children', () => {
    expect(adfToMarkdown(doc({ type: 'layoutSection', content: [para(text('dentro'))] }))).toBe('dentro');
  });

  it('preserves nested list structure with correct indentation', () => {
    const md = adfToMarkdown(doc({ type: 'bulletList', content: [
      { type: 'listItem', content: [para(text('um')), { type: 'bulletList', content: [
        { type: 'listItem', content: [para(text('nested1'))] },
        { type: 'listItem', content: [para(text('nested2'))] },
      ] }] },
      { type: 'listItem', content: [para(text('dois'))] },
    ] }));
    expect(md).toBe('- um\n  - nested1\n  - nested2\n- dois');
  });
});
