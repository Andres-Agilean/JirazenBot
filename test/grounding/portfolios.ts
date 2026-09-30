import type { CardCandidate } from '@/teams/search.js';
import type { EvalCase } from './types.js';

/** Fixed "now" so the stale item stays stale forever, whatever day the eval runs. */
const FIXTURE_NOW_MS = Date.parse('2026-09-30T15:00:00Z');

const jira = (
  issueKey: string,
  summary: string,
  status: string,
  updatedAt: string,
  assignee?: string,
): CardCandidate => ({
  ref: { system: 'jira', issueKey, explicit: true },
  label: issueKey,
  summary,
  status,
  updatedAt,
  ...(assignee ? { assignee } : {}),
});

const zendesk = (ticketId: string, summary: string, status: string, updatedAt: string): CardCandidate => ({
  ref: { system: 'zendesk', ticketId, explicit: true },
  label: `chamado ${ticketId}`,
  summary,
  status,
  updatedAt,
});

/** The one item last updated more than STALE_AFTER_DAYS before FIXTURE_NOW_MS. */
export const STALE_ITEM_LABEL = 'QZ-106';
/** A non-stale Jira card, used by the "not in context" case. */
export const ROOT_CAUSE_ITEM_LABEL = 'QZ-101';

/**
 * Eight open activities in two sections (6 Jira, 2 Zendesk-only), uncapped (total 8). Known
 * aggregates: 3 'Pronto para Delivery', 2 'Done', 1 'Blocked', 1 'open', 1 'new'; assignees
 * Gabriel Alves x2, Carla Nunes x1, the other five unassigned.
 */
export const teamPortfolio: NonNullable<EvalCase['portfolio']> = {
  name: 'Equipe Quartzo',
  total: 8,
  nowMs: FIXTURE_NOW_MS,
  cards: [
    jira('QZ-101', 'Erro ao exportar relatório mensal', 'Pronto para Delivery', '2026-09-28T13:00:00Z', 'Gabriel Alves'),
    jira('QZ-102', 'Ajustar layout da tela de login', 'Pronto para Delivery', '2026-09-27T13:00:00Z', 'Gabriel Alves'),
    jira('QZ-103', 'Novo filtro na listagem de pedidos', 'Pronto para Delivery', '2026-09-29T13:00:00Z', 'Carla Nunes'),
    jira('QZ-104', 'Atualizar dependências do backend', 'Done', '2026-09-25T13:00:00Z'),
    jira('QZ-105', 'Revisar textos do onboarding', 'Done', '2026-09-26T13:00:00Z'),
    jira('QZ-106', 'Integração com o gateway de pagamento', 'Blocked', '2026-08-20T13:00:00Z'),
    zendesk('20501', 'Cliente não consegue redefinir a senha', 'open', '2026-09-29T18:00:00Z'),
    zendesk('20502', 'Dúvida sobre emissão de nota fiscal', 'new', '2026-09-30T12:00:00Z'),
  ],
};
