import { richPollCard } from './poll-layout.ts';
export interface RichPollPreview {title:string;description:string;options:string[];counts:number[];daysRemaining:number;previewUrl?:string;votedPremises?:string[];votedCommerce?:string[];previewNote?:string}
export function richPollPreview(data:RichPollPreview){
 return richPollCard({...data,votedPremises:[...(data.votedPremises||[]),...(data.votedCommerce||[])],previewNote:data.previewNote||(data.previewUrl?'Приклад оформлення: кнопки відкривають це повідомлення. Голоси не збираються.':'Тест оформлення · голоси не збираються.')});
}
