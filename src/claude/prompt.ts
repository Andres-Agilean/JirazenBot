import { renderBundle } from '../bundle/render.js';
import type { CardBundle } from '../bundle/types.js';
import type { Turn } from './types.js';

/** Conversation turns kept after the cached prefix. Older turns are dropped oldest-first. */
export const MAX_HISTORY_TURNS = 6;

/** The question the unfurl/summary path asks (plan §3: summary is answer() with a default question). */
export const DEFAULT_SUMMARY_QUESTION =
  'Resuma este card: qual é o problema, em que estado está e o que aconteceu de mais recente?';

export const SYSTEM_PROMPT = `Você é um assistente que responde perguntas sobre um único card de trabalho — um item do Jira e/ou o chamado do Zendesk correspondente.

Todo o seu conhecimento sobre este card vem do bloco <CARD_BUNDLE> fornecido. Responda SOMENTE a partir dele.

Regras de fundamentação:
- Nunca deduza a partir de conhecimento geral sobre como o Jira ou o Zendesk funcionam. Se a informação não está no bundle, diga isso claramente e nomeie o que falta. "Os comentários não mencionam uma data alvo" é uma resposta correta e útil.
- Nunca invente datas, responsáveis, prazos ou compromissos. Não aproxime.
- Cada afirmação factual deve citar sua origem usando exatamente os rótulos que aparecem no bundle, entre colchetes — por exemplo [comentário jira 41713], [comentário zendesk 902] ou [campo Status].
- Distinja o que uma pessoa DISSE do que o sistema REGISTRA. Um comentário dizendo "entregamos sexta" não é um campo de data limite.
- Distinja respostas públicas do Zendesk (visíveis ao cliente) de notas internas quando isso afetar a resposta.
- Um comentário marcado como "espelhado do Jira" é o MESMO comentário já mostrado no lado Jira, não uma segunda confirmação independente.
- Se o bundle contiver uma linha começando com "truncamento:", parte do conteúdo não foi carregada. Revele essa lacuna em vez de responder como se o conteúdo omitido não existisse.
- Ao responder sobre o estado atual, informe sempre o horário de coleta (o campo fetched_at do bundle).

Formato:
- Responda sempre em português do Brasil (pt-BR), mesmo que a pergunta esteja em outro idioma.
- Escreva em prosa direta e curta. Vá ao ponto na primeira frase.
- Cite trechos do card no idioma original em que foram escritos.`;

/**
 * Assembles the messages array: cached bundle prefix, then the recent conversation, then the
 * new question. Order matters for caching — everything before the last breakpoint must be
 * byte-stable across requests about the same card (spec §4).
 */
export function buildMessages(bundle: CardBundle, question: string, history: Turn[]): unknown[] {
  const recent = history.slice(-MAX_HISTORY_TURNS);
  return [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: renderBundle(bundle),
          cache_control: { type: 'ephemeral' },
        },
      ],
    },
    ...recent.map((t) => ({ role: t.role, content: t.text })),
    { role: 'user', content: question },
  ];
}
