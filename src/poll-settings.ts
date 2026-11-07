export const REPOST_INTERVALS = [0,3600,10800,21600,43200,86400] as const;
export function intervalLabel(seconds:number) {
  return ({0:'Тільки вручну',3600:'Щогодини',10800:'Кожні 3 години',21600:'Кожні 6 годин',43200:'Кожні 12 годин',86400:'Раз на добу'} as Record<number,string>)[seconds] || 'Не налаштовано';
}
export function validInterval(value:number) { return REPOST_INTERVALS.some(interval=>interval===value); }

export const POLL_DURATIONS=[0,1,3,5,6,7,14] as const;
export function durationLabel(days:number){return days===0?'Без строку':days===1?'1 день':days===3?'3 дні':`${days} днів`;}
export function validDuration(days:number){return POLL_DURATIONS.some(value=>value===days);}
