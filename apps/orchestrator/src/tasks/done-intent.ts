/**
 * "The task is finished" said in a message. Only a short, unambiguous statement counts (the whole message): "done", "готово", "задача завершена",
 * "close the task". A longer message that merely contains the word ("done with step 1, now do step 2") is an ordinary follow-up.
 */
const PATTERNS: RegExp[] = [
  /^(?:ok(?:ay)?[,.! ]+|ок[,.! ]+|да[,.! ]+|thanks?[,.! ]+|thank you[,.! ]+|спасибо[,.! ]+)?(?:it'?s |this is |that'?s |all )?(?:done|finished|complete(?:d)?|resolved|closed|all set)$/i,
  /^(?:ok(?:ay)?[,.! ]+|ок[,.! ]+|да[,.! ]+|thanks?[,.! ]+|спасибо[,.! ]+)?(?:все|всё)?\s*(?:готово|выполнено|завершено|закончено|решено|закрыто|принято|сделано|порядок)$/i,
  /^(?:the )?(?:task|issue|ticket)\s+(?:is\s+)?(?:done|finished|complete(?:d)?|closed|resolved)$/i,
  /^(?:задач[аи]|таск[аи]|вопрос)\s+(?:(?:уже|полностью)\s+)?(?:выполнен[аы]?|завершен[аы]?|завершён[аы]?|закрыт[аы]?|решен[аы]?|решён[аы]?|готов[аы]?)$/i,
  /^(?:please\s+)?(?:close|finish|complete|mark(?:\s+(?:it|this|the task))?\s+(?:as\s+)?done)(?:\s+(?:the\s+)?(?:task|it|this))?$/i,
  /^(?:закрой|закрыть|заверши|завершить|отметь)(?:\s+(?:эту\s+)?(?:задачу|таск[ув]|её|ее|это))?(?:\s+как\s+(?:выполненн\w+|готов\w+|завершённ\w+|завершенн\w+))?$/i,
  /^(?:принято|принимаю|accepted|looks good(?:,? close it)?|lgtm)$/i,
];

/**
 * The same, in the other widely used languages. The whole message must be just the confirmation (optionally with a thanks / "ok" in front), so an
 * ordinary sentence that merely contains the word never closes a task. The button and `/done` work in every language regardless.
 */
const OTHER_LANGUAGES: Record<string, RegExp> = {
  uk: /^(?:(?:ок|так|дякую|дяк)[,.! ]+)?(?:все\s+|вже\s+)?(?:готово|виконано|завершено|закрито|прийнято|зроблено|задачу\s+завершено|завдання\s+(?:виконано|завершено|закрито)|закрий(?:\s+(?:задачу|завдання))?)$/iu,
  es: /^(?:(?:vale|ok|gracias)[,.! ]+)?(?:ya\s+)?(?:hecho|listo|terminado|completado|finalizado|cerrado|aceptado|tarea\s+(?:completada|terminada|finalizada|cerrada)|cierra\s+(?:la\s+)?tarea|cerrar\s+(?:la\s+)?tarea)$/iu,
  pt: /^(?:(?:ok|obrigad[oa])[,.! ]+)?(?:j[áa]\s+)?(?:pronto|feito|conclu[íi]do|terminado|finalizado|fechado|aceito|tarefa\s+(?:conclu[íi]da|terminada|finalizada|fechada)|fecha\s+a\s+tarefa)$/iu,
  fr: /^(?:(?:ok|merci|d'accord)[,.! ]+)?(?:c'est\s+)?(?:fait|termin[ée]e?|fini(?:e)?|fini|ferm[ée]e?|accept[ée]e?|t[âa]che\s+(?:termin[ée]e|finie|ferm[ée]e)|ferme\s+la\s+t[âa]che|c'est\s+bon)$/iu,
  de: /^(?:(?:ok|danke|alles klar)[,.! ]+)?(?:ist\s+)?(?:fertig|erledigt|abgeschlossen|geschlossen|akzeptiert|aufgabe\s+(?:erledigt|abgeschlossen|fertig)|schlie(?:ß|ss)e\s+die\s+aufgabe|passt)$/iu,
  it: /^(?:(?:ok|grazie)[,.! ]+)?(?:tutto\s+)?(?:fatto|finito|completato|terminato|chiuso|accettato|compito\s+(?:completato|terminato|chiuso)|chiudi\s+(?:il\s+)?compito)$/iu,
  pl: /^(?:(?:ok|dzi[ęe]kuj[ęe])[,.! ]+)?(?:ju[żz]\s+)?(?:gotowe|zrobione|zako[ńn]czone|zamkni[ęe]te|przyj[ęe]te|zadanie\s+(?:wykonane|zako[ńn]czone|zamkni[ęe]te)|zamknij\s+zadanie)$/iu,
  tr: /^(?:(?:tamam|te[şs]ekk[üu]rler)[,.! ]+)?(?:i[şs]\s+)?(?:bitti|tamamland[ıi]|tamam|kapat[ıi]ld[ıi]|kabul|g[öo]rev\s+(?:tamamland[ıi]|bitti|kapand[ıi])|g[öo]revi\s+kapat)$/iu,
  nl: /^(?:(?:ok|bedankt|dank je)[,.! ]+)?(?:is\s+)?(?:klaar|gedaan|voltooid|afgerond|gesloten|geaccepteerd|taak\s+(?:voltooid|afgerond|gesloten)|sluit\s+de\s+taak)$/iu,
  zh: /^(?:(?:好的?|谢谢|多谢)[，,。！!\s]*)?(?:已经?|全部)?(?:完成了?|做完了?|好了|搞定了?|结束了?|办完了?|任务(?:已)?(?:完成|结束|关闭)了?|关闭任务|结束任务|通过|接受)$/u,
  ja: /^(?:(?:はい|ありがとう(?:ございます)?)[、,。！!\s]*)?(?:完了(?:です|しました)?|終わり(?:です|ました)?|終了(?:です|しました)?|できました|済み(?:です|ました)?|タスク(?:は)?(?:完了|終了)(?:です|しました)?|タスクを(?:閉じて|完了にして)(?:ください)?|承認(?:します|しました)?)$/u,
  ko: /^(?:(?:네|감사합니다|고마워요)[,.! ]*)?(?:완료(?:됐어요|되었습니다|했습니다|입니다)?|끝(?:났어요|났습니다)?|다\s*했(?:어요|습니다)|작업\s*(?:완료|종료)(?:됐어요|되었습니다)?|작업을?\s*닫아(?:줘|주세요)|승인(?:합니다|했습니다)?)$/u,
  ar: /^(?:(?:شكرا|حسنا|تمام)[،,.! ]*)?(?:تم|انتهى|انتهت المهمة|اكتمل(?:ت)?(?: المهمة)?|المهمة (?:مكتملة|انتهت|تمت)|أغلق المهمة|اغلق المهمة|موافق)$/u,
  he: /^(?:(?:תודה|בסדר)[,.! ]*)?(?:בוצע|הושלם|סיימתי|סיום|המשימה (?:הושלמה|בוצעה|הסתיימה)|סגור (?:את )?המשימה|אישרתי)$/u,
  hi: /^(?:(?:ठीक है|धन्यवाद|शुक्रिया)[,.! ]*)?(?:हो गया|पूरा हो गया|काम पूरा|काम हो गया|समाप्त|कार्य (?:पूरा|समाप्त|हो गया)|टास्क (?:पूरा|बंद)(?: करो)?|स्वीकार)$/u,
  th: /^(?:(?:ขอบคุณ|โอเค)[,.! ]*)?(?:เสร็จแล้ว|เสร็จเรียบร้อย|เรียบร้อย|เสร็จ|งานเสร็จแล้ว|ปิดงาน|ตกลง)$/u,
  vi: /^(?:(?:ok|c[ảa]m [ơo]n)[,.! ]*)?(?:xong(?: r[ồo]i)?|ho[àa]n th[àa]nh|[đd][ãa] xong|[đd]óng (?:t[ảa]c|c[ôo]ng vi[ệe]c)|ch[ấa]p nh[ậa]n)$/iu,
  id: /^(?:(?:oke|ok|terima kasih)[,.! ]*)?(?:sudah\s+)?(?:selesai|beres|tuntas|ditutup|diterima|tugas\s+(?:selesai|ditutup)|tutup\s+tugas)$/iu,
};

export function isDoneMessage(text: string): boolean {
  const t = text.normalize('NFKC').trim().replace(/[.!…。！]+$/gu, '').replace(/\s+/g, ' ');
  if (!t || t.length > 60) return false;
  return PATTERNS.some((re) => re.test(t)) || Object.values(OTHER_LANGUAGES).some((re) => re.test(t));
}
