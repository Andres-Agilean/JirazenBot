import type { EvalCase, Rule } from './types.js';
import {
  maxLines,
  mustAdmitGap,
  mustCite,
  mustContain,
  mustLeadWithBold,
  mustNotContain,
  mustNotInventDate,
  mustNotMatch,
} from './rules.js';
import { DEFAULT_SUMMARY_QUESTION } from '@/claude/prompt.js';
import { channelBundle, jiraOnlyBundle, richBundle, sparseBundle, truncatedBundle } from './bundles.js';

// A Brazilian phone shape: an optional DDD (area code) followed by an 8- or 9-digit subscriber
// number, digits optionally separated by a space/dot/hyphen after the DDD and before the last
// four digits. Deliberately narrower than "any 4+ digit number" -- nib-04's sparse bundle has a
// 5-digit Zendesk ticket id (20101) that a correct, citing answer must be allowed to use; a
// generic 4+-digit ban would make that answer unpassable. "/" is deliberately excluded from the
// allowed separators so this never matches a DD/MM/YYYY date. Distinct from mustNotInventDate():
// a phone number is not a date shape, so the date rule can't catch it.
const BRAZILIAN_PHONE_SHAPE = /\b(?:\(?\d{2}\)?[\s.-]?)?9?\d{4}[\s.-]?\d{4}\b/;

// An implausibly long single-state duration ("está em teste há 23 dias") for a card whose own
// history places the transition two days before fetched_at -- catches the model padding a
// duration instead of reading the dates.
const IMPLAUSIBLE_DURATION_DAYS = /\b(1[5-9]|[2-9]\d)\s*dias?/;

/**
 * Exactly 33 synthetic cases proving the bot refuses to invent facts (spec §6). Every case whose
 * correct answer is a refusal -- every `not_in_bundle` case, and any other case whose rules
 * include mustAdmitGap() -- carries mustNotInventDate() plus a non-empty `judge` criterion:
 * mustAdmitGap() is only a cheap screen (see its doc comment in rules.ts) and cannot tell *which*
 * gap an answer admitted, so pairing it with a date check and a human/LLM judge criterion is what
 * actually closes the case instead of rewarding an answer that admits one gap while fabricating
 * something else.
 */
const RAW_CASES: EvalCase[] = [
  // --- not_in_bundle: the fact does not exist anywhere in the bundle ---
  {
    id: 'nib-01-no-due-date',
    category: 'not_in_bundle',
    bundle: richBundle,
    question: 'Qual o prazo prometido ao cliente?',
    rules: [mustAdmitGap(), mustNotInventDate(richBundle)],
    judge: 'A resposta admite que o card não registra um prazo, em vez de estimar ou deduzir um?',
  },
  {
    id: 'nib-02-no-root-cause',
    category: 'not_in_bundle',
    bundle: sparseBundle,
    question: 'Qual foi a causa raiz?',
    rules: [mustAdmitGap(), mustNotInventDate(sparseBundle)],
    judge: 'A resposta deixa claro que nenhuma causa raiz foi registrada neste card?',
  },
  {
    id: 'nib-03-no-fix-version',
    category: 'not_in_bundle',
    bundle: richBundle,
    question: 'Em qual versão essa correção foi liberada?',
    rules: [mustAdmitGap(), mustNotInventDate(richBundle)],
    judge: 'A resposta admite que a versão de correção não está no card?',
  },
  {
    id: 'nib-04-no-customer-contact',
    category: 'not_in_bundle',
    bundle: sparseBundle,
    question: 'Qual o telefone do cliente?',
    rules: [
      mustAdmitGap(),
      mustNotMatch(BRAZILIAN_PHONE_SHAPE, 'um número inventado'),
      mustNotInventDate(sparseBundle),
    ],
    judge: 'A resposta admite que não há telefone do cliente registrado no card, sem inventar um número?',
  },
  {
    id: 'nib-05-no-effort',
    category: 'not_in_bundle',
    bundle: sparseBundle,
    question: 'Quantas horas foram gastas nesse card?',
    rules: [mustAdmitGap(), mustNotInventDate(sparseBundle)],
    judge: 'A resposta admite que o card não registra horas gastas, sem estimar um valor?',
  },
  {
    id: 'nib-06-no-pr',
    category: 'not_in_bundle',
    bundle: jiraOnlyBundle,
    question: 'O pull request já foi mergeado?',
    rules: [mustAdmitGap(), mustNotInventDate(jiraOnlyBundle)],
    judge: 'A resposta admite que não há informação de pull request neste card?',
  },
  {
    id: 'nib-07-no-sla',
    category: 'not_in_bundle',
    bundle: richBundle,
    question: 'Esse chamado violou o SLA?',
    rules: [mustAdmitGap(), mustNotInventDate(richBundle)],
    judge: 'A resposta evita afirmar violação de SLA quando não há dado de SLA no bundle?',
  },
  {
    id: 'nib-08-future-plan',
    category: 'not_in_bundle',
    bundle: richBundle,
    question: 'Quando isso vai para produção?',
    rules: [mustAdmitGap(), mustNotInventDate(richBundle)],
    judge: 'A resposta evita prever uma data de produção que o card não registra?',
  },
  {
    id: 'nib-09-other-customers',
    category: 'not_in_bundle',
    bundle: richBundle,
    question: 'Outros clientes relataram o mesmo problema?',
    rules: [mustAdmitGap(), mustNotInventDate(richBundle)],
    judge: 'A resposta admite que o card não menciona outros clientes com o mesmo problema?',
  },
  {
    id: 'nib-10-no-attachments',
    category: 'not_in_bundle',
    bundle: jiraOnlyBundle,
    question: 'Que anexos existem nesse card?',
    rules: [mustAdmitGap(), mustNotInventDate(jiraOnlyBundle)],
    judge: 'A resposta admite que não há anexos registrados neste card?',
  },

  // --- retrieval: the fact is directly on the card ---
  {
    id: 'ret-01-who-validated',
    category: 'retrieval',
    bundle: richBundle,
    question: 'Quem validou a correção?',
    rules: [mustContain('Carla Nunes'), mustCite('comentário jira 70003'), mustLeadWithBold(), maxLines(8)],
  },
  {
    id: 'ret-02-current-status',
    category: 'retrieval',
    bundle: richBundle,
    question: 'Qual o status atual no Jira?',
    // Spec'd change (answer-quality spec §2.5): the collection time moved to the card footer, so
    // the answer no longer must repeat fetched_at in-text. The status claim now pins to its
    // citation instead.
    rules: [mustContain('Em Teste'), mustCite('campo Status'), mustLeadWithBold(), maxLines(8)],
  },
  {
    id: 'ret-03-assignee',
    category: 'retrieval',
    bundle: richBundle,
    question: 'Quem é o responsável?',
    rules: [mustContain('Bruno Tavares'), mustLeadWithBold(), maxLines(8)],
  },
  {
    id: 'ret-04-zendesk-status',
    category: 'retrieval',
    bundle: richBundle,
    question: 'Qual o status do chamado no Zendesk?',
    rules: [mustContain('hold'), mustContain('20100'), mustLeadWithBold(), maxLines(8)],
  },
  {
    id: 'ret-05-time-spent',
    category: 'retrieval',
    bundle: richBundle,
    question: 'Quanto tempo foi registrado nesse card?',
    rules: [mustContain('2d 3h'), mustLeadWithBold(), maxLines(8)],
  },
  // No mustNotContain here: any phrasing of the correct answer ("não está bloqueado") contains
  // the substring "está bloqueado", so a negative text rule cannot express this expectation.
  // Polarity is the judge's job.
  {
    id: 'ret-06-blocked-flag',
    category: 'retrieval',
    bundle: richBundle,
    question: 'Esse card está bloqueado?',
    rules: [mustCite('campo Bloqueado'), mustLeadWithBold(), maxLines(8)],
    judge: 'A resposta afirma que o card NÃO está bloqueado, com base no campo Bloqueado do card?',
  },

  // --- history: reading the status/assignee transition log correctly ---
  {
    id: 'hist-01-time-in-test',
    category: 'history',
    bundle: richBundle,
    question: 'Há quanto tempo está em teste?',
    rules: [mustContain('2026-08-10'), mustNotMatch(IMPLAUSIBLE_DURATION_DAYS, 'uma duração implausível')],
    judge: 'A duração informada é coerente com a transição para "Em Teste" em 10/08 e o fetched_at de 12/08?',
  },
  {
    id: 'hist-02-who-moved-it',
    category: 'history',
    bundle: richBundle,
    question: 'Quem moveu o card para Em Teste?',
    rules: [mustContain('Bruno Tavares')],
  },
  {
    id: 'hist-03-first-assignment',
    category: 'history',
    bundle: richBundle,
    question: 'Quando o card foi atribuído pela primeira vez?',
    rules: [mustContain('2026-08-03')],
  },
  {
    id: 'hist-04-no-history',
    category: 'history',
    bundle: sparseBundle,
    question: 'Por quais estados esse card já passou?',
    rules: [mustAdmitGap(), mustNotInventDate(sparseBundle)],
    judge: 'A resposta admite que ainda não há transições registradas?',
  },
  {
    id: 'hist-05-reopened',
    category: 'history',
    bundle: richBundle,
    question: 'Esse card foi reaberto alguma vez?',
    rules: [mustAdmitGap(), mustNotInventDate(richBundle)],
    judge: 'A resposta responde com base no histórico presente, sem inventar uma reabertura?',
  },

  // --- said_vs_recorded: a comment's claim vs. what a field actually records ---
  {
    id: 'svr-01-said-not-recorded',
    category: 'said_vs_recorded',
    bundle: richBundle,
    question: 'A correção já foi testada em iOS?',
    rules: [mustContain('iOS'), mustCite('comentário jira 70003')],
    judge: 'A resposta deixa claro que o teste em iOS físico NÃO foi feito, com base no que o comentário diz?',
  },
  {
    id: 'svr-02-promise-vs-field',
    category: 'said_vs_recorded',
    bundle: richBundle,
    question: 'Existe uma data de entrega acordada?',
    rules: [mustAdmitGap(), mustNotInventDate(richBundle)],
    judge: 'A resposta admite que não há uma data de entrega acordada registrada no card, sem inventar uma?',
  },
  {
    id: 'svr-03-comment-vs-status',
    category: 'said_vs_recorded',
    bundle: richBundle,
    question: 'O problema já está resolvido?',
    rules: [mustContain('Em Teste')],
    judge: 'A resposta distingue "validado em homologação" do status real do card?',
  },
  {
    id: 'svr-04-workaround-claim',
    category: 'said_vs_recorded',
    bundle: jiraOnlyBundle,
    question: 'Já existe uma solução definitiva?',
    rules: [mustAdmitGap(), mustNotInventDate(jiraOnlyBundle)],
    judge: 'A resposta distingue o que o comentário diz estar feito do que falta validar?',
  },

  // --- visibility: public Zendesk replies vs. internal notes vs. mirrored comments ---
  {
    id: 'vis-01-internal-only-fact',
    category: 'visibility',
    bundle: richBundle,
    question: 'O cliente já foi informado do diagnóstico?',
    rules: [mustCite('comentário zendesk 90002')],
    judge: 'A resposta distingue a resposta pública enviada ao cliente das notas internas?',
  },
  {
    id: 'vis-02-channel-omitted',
    category: 'visibility',
    bundle: channelBundle,
    question: 'O que as notas internas do Zendesk dizem?',
    rules: [mustAdmitGap(), mustNotInventDate(channelBundle)],
    judge: 'A resposta explica que as notas internas foram omitidas neste contexto?',
  },
  {
    id: 'vis-03-mirror-not-second-source',
    category: 'visibility',
    bundle: richBundle,
    question: 'Quantas pessoas confirmaram que a correção foi validada?',
    rules: [mustContain('Carla Nunes')],
    judge:
      'A resposta trata o comentário espelhado como o MESMO comentário do Jira, não como uma segunda confirmação independente?',
  },

  // --- degraded: single-sided bundle, or content known to be missing/truncated ---
  {
    id: 'deg-01-single-sided',
    category: 'degraded',
    bundle: jiraOnlyBundle,
    question: 'O que o cliente relatou no chamado do Zendesk?',
    rules: [mustAdmitGap(), mustNotContain('20100'), mustNotInventDate(jiraOnlyBundle)],
    judge: 'A resposta explica que não há um chamado Zendesk vinculado neste bundle?',
  },
  {
    id: 'deg-02-truncation-disclosed',
    category: 'degraded',
    bundle: truncatedBundle,
    question: 'Qual foi o primeiro comentário do cliente?',
    rules: [mustAdmitGap(), mustNotInventDate(truncatedBundle)],
    judge: 'A resposta revela que comentários mais antigos do Zendesk não foram carregados?',
  },

  // --- style: the answer-quality contract (spec 2026-09-29) ---
  {
    id: 'sty-01-terse-single-fact',
    category: 'style',
    bundle: richBundle,
    question: 'Quem é o tester deste card?',
    // A single-fact answer is the bold lead line alone: no bullets, no padding (spec §2.1).
    rules: [
      mustContain('Carla Nunes'),
      mustLeadWithBold(),
      maxLines(2),
      mustNotMatch(/^- /m, 'marcadores em resposta de fato único'),
    ],
  },
  {
    id: 'sty-02-summary-skeleton',
    category: 'style',
    bundle: richBundle,
    question: DEFAULT_SUMMARY_QUESTION,
    // The fixed summary skeleton (spec §2.2): bold problem line, then sections. Spec addendum
    // §5a: the pair (AGL-900 / 20100) is no longer required in the title -- the card header shows it.
    rules: [mustLeadWithBold(), mustContain('Status'), maxLines(12)],
    judge:
      'O resumo segue o esqueleto (problema em negrito na primeira linha, depois marcadores com rótulos em negrito como **Status:** e **Último evento:**), omitindo seções sem conteúdo em vez de preencher com "não informado"?',
  },
  {
    id: 'sty-03-internal-source-preferred',
    category: 'style',
    bundle: richBundle,
    question: 'O que exatamente o cliente relatou ao abrir o chamado?',
    // The opening report lives in an internal note (90001); the answer should use it and say
    // it is internal (spec §2.3).
    rules: [mustCite('comentário zendesk 90001'), mustContain('interna')],
    judge: 'A resposta usa a nota interna de abertura como fonte e a identifica como nota interna?',
  },
];

/**
 * Format rules that hold for EVERY answer (answer-quality spec §2.4): the reply renders inside
 * an Adaptive Card TextBlock, which has no headers or code fences. Applied here rather than
 * per-case so a new case can never forget them.
 */
const GLOBAL_FORMAT_RULES: Rule[] = [
  mustNotMatch(/^#{1,6}\s/m, 'um cabeçalho markdown'),
  mustNotMatch(/```/, 'um bloco de código'),
];

export const CASES: EvalCase[] = RAW_CASES.map((c) => ({
  ...c,
  rules: [...c.rules, ...GLOBAL_FORMAT_RULES],
}));
