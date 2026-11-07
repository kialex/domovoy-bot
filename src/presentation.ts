export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function pollCard(id: number, question: string, options: string[], counts: Map<number, number>, closed: boolean) {
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const results = options.map((option, index) => {
    const count = counts.get(index) || 0;
    const percent = total ? Math.round(count / total * 100) : 0;
    const filled = Math.round(percent / 100 * 8);
    return `<b>${index + 1}. ${escapeHtml(option)}</b>\n${'▰'.repeat(filled)}${'▱'.repeat(8 - filled)}  ${count} · ${percent}%`;
  }).join('\n\n');
  return `${closed ? '🏁' : '🗳'} <b>${closed ? 'Підсумки голосування' : 'Голосування будинку'}</b>\n№${id} · ${closed ? 'Завершено' : '🟢 Відкрите'}\n\n<b>${escapeHtml(question)}</b>\n\n${results}\n\n🏘 Проголосувало приміщень: <b>${total}</b>\n\n<i>${closed ? 'Дякуємо за участь! Голоси більше не приймаються.' : 'Оберіть відповідь кнопкою нижче.\nОдин голос від приміщення. Змінити відповідь може лише той, хто її подав, до завершення голосування.'}</i>`;
}
