import { describe, expect, it } from 'vitest';
import { wikiToMarkdown } from '../src/fetch/wikiToMarkdown.js';

// Real body captured live from ticket 16467 / QZ-252, comment id 54276177045147 (public: false) --
// a Jira comment mirrored into Zendesk as an internal note. Exercises {panel}, the smart-link
// form, and the image macro together, the combination actually produced by this tenant.
const REAL_MIRRORED_BODY =
  '[Jira] QZ-252 — André Marques:\n\n' +
  '{panel:bgColor=#e3fcef}\n' +
  '✅ Aprovado!\n\n' +
  'Validado com sucesso o novo componente nativo de câmera do QQ. Foram executados 26 casos de teste, contemplando o fluxo de captura de fotos e diferentes cenários de uso da câmera.\n\n' +
  'Todos os cenários foram aprovados, sem identificação de inconsistências.\n\n' +
  'A validação foi realizada em emulador Android e dispositivo físico iOS. Não foi possível realizar os testes em um dispositivo físico Android.\n\n' +
  '[https://some-internal-tool.vercel.app/suites/11111111-1111-1111-1111-111111111111/rounds/22222222-2222-2222-2222-222222222222|https://some-internal-tool.vercel.app/suites/11111111-1111-1111-1111-111111111111/rounds/22222222-2222-2222-2222-222222222222|smart-link] \n\n' +
  '!image-20260811-173359.png|width=579,alt="image-20260811-173359.png"!\n' +
  '{panel}';

describe('wikiToMarkdown', () => {
  it('converts the real live mirrored-comment body: strips the panel, collapses the doubled smart-link, and marks the image', () => {
    const md = wikiToMarkdown(REAL_MIRRORED_BODY);
    expect(md).not.toContain('{panel');
    expect(md).not.toContain('|smart-link]');
    expect(md).not.toContain('!image-20260811-173359.png|width=579');
    expect(md).toContain('[anexo: image-20260811-173359.png]');
    expect(md).toContain('✅ Aprovado!');
    // the prefix line is not wiki markup -- wikiToMarkdown leaves it untouched; collapsing a
    // matched mirror is bundle/render.ts's job, not this converter's.
    expect(md).toContain('[Jira] QZ-252 — André Marques:');
    // the url must survive but never be doubled
    const url = 'https://some-internal-tool.vercel.app/suites/11111111-1111-1111-1111-111111111111/rounds/22222222-2222-2222-2222-222222222222';
    expect(md.split(url)).toHaveLength(2); // exactly one occurrence
  });

  it('passes plain text through byte-identical', () => {
    const plain = 'Ao tirar uma foto o aplicativo fecha';
    expect(wikiToMarkdown(plain)).toBe(plain);
  });

  it('passes lightly-formatted, non-wiki markdown through byte-identical', () => {
    const md = 'Olá, **Bruna**!\n\nRecebemos o seu chamado com sucesso.\n\nAgilean';
    expect(wikiToMarkdown(md)).toBe(md);
  });

  it('strips {color} and {noformat} wrappers, keeping the inner content', () => {
    expect(wikiToMarkdown('{color:red}atenção{color}')).toBe('atenção');
    expect(wikiToMarkdown('{noformat}texto literal{noformat}')).toBe('texto literal');
  });

  it('converts {quote} to markdown blockquote lines', () => {
    expect(wikiToMarkdown('{quote}\nlinha um\nlinha dois\n{quote}')).toBe('> linha um\n> linha dois');
  });

  it('converts {code:lang} to a fenced code block', () => {
    expect(wikiToMarkdown('{code:javascript}\nconst a = 1;\n{code}')).toBe('```javascript\nconst a = 1;\n```');
  });

  it('converts a plain {code} block (no language) to a fenced code block', () => {
    expect(wikiToMarkdown('{code}\nplain\n{code}')).toBe('```\nplain\n```');
  });

  it('converts [text|url] links', () => {
    expect(wikiToMarkdown('veja [aqui|https://x.io/y]')).toBe('veja [aqui](https://x.io/y)');
  });

  it('converts {{monospace}} to backticked code', () => {
    expect(wikiToMarkdown('rode {{npm test}} antes')).toBe('rode `npm test` antes');
  });

  it('converts h1.-h6. headings at line start', () => {
    expect(wikiToMarkdown('h1. Título\nh3. Subtítulo')).toBe('# Título\n### Subtítulo');
  });

  it('converts a bare image macro with no attrs', () => {
    expect(wikiToMarkdown('!foto.png!')).toBe('[anexo: foto.png]');
  });
});
