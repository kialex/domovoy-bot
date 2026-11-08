import { apartmentNumber } from './validation.ts';
import type { Env } from './env.ts';

export interface Premise {
  id: number; chat_id: number; kind: 'apartment' | 'commercial'; number: string;
  business_name: string; entrance: number | null; floor: number | null;
  number_start: number; number_end: number;
}
export interface Membership extends Premise {
  telegram_username?: string;
  group_title?: string; membership_id: number; user_id: number; role: 'owner' | 'tenant' | 'family'; status: string;
  version: number; name: string; phone: string; application_token: string; details: string;
}
export const membershipSelect = `SELECT p.*,m.id AS membership_id,m.user_id,m.role,m.status,m.version,
  m.application_token,m.details,u.name,u.phone FROM memberships m JOIN premises p ON p.id=m.premise_id JOIN profiles u ON u.user_id=m.user_id`;
export function entranceForApartment(value: string): number | null {
  const normalized=apartmentNumber(value);
  if(!normalized)return null;
  const n=Number.parseInt(normalized,10);
  return n <= 84 ? 1 : n <= 133 ? 2 : n <= 187 ? 3 : null;
}
export function commercialKey(name: string): string {
  return `business:${name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()}`;
}
export function validFloor(kind: string, entrance: number, value: string): number | null {
  if (!/^\d{1,2}$/.test(value.trim())) return null;
  const floor = Number(value.trim());
  const minimum = kind === 'commercial' ? (entrance === 1 ? 1 : 0) : (entrance === 1 ? 2 : 1);
  const maximum = entrance === 1 ? 14 : entrance === 2 ? 9 : entrance === 3 ? 10 : -1;
  return floor >= minimum && floor <= maximum ? floor : null;
}
export const premiseLabel = (p: Pick<Premise, 'kind' | 'number'> & Partial<Pick<Premise, 'business_name'>>) => p.kind === 'apartment' ? `Квартира ${p.number}` : `🏪 ${p.business_name || 'Комерція'}`;
export const roleLabel = (role: string) => ({owner:'Власник',tenant:'Орендар',family:'Член сім’ї'} as Record<string,string>)[role] || 'Мешканець';
export async function ownMemberships(env: Env, uid: number, chatId?: number, approvedOnly = false) {
  return (await env.HOME_DB.prepare(`${membershipSelect.replace('SELECT p.*', 'SELECT g.title AS group_title,p.*')} JOIN groups g ON g.chat_id=p.chat_id WHERE m.user_id=? AND g.status='approved' AND g.bot_present=1 ${chatId ? 'AND p.chat_id=?' : ''} ${approvedOnly ? "AND m.status='approved' AND u.phone GLOB '+380[1-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'" : "AND m.status IN ('pending','approved')"} ORDER BY p.chat_id,p.kind,p.number_start`)
    .bind(...(chatId ? [uid, chatId] : [uid])).all<Membership>()).results;
}
