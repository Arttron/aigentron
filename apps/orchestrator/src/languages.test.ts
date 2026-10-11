import { describe, expect, it } from 'vitest';
import { sanitize } from './attachments/attachments.service';
import { matchAgent, nameKey, parseAddress } from './channels/agent-match';
import { Bm25Index, chunkText, tokenize } from './knowledge/kb-core';
import { isDoneMessage } from './tasks/done-intent';
import { cleanTitle, isWeakPrompt } from './titles/title-core';

/** One short sentence per language: [text, a query that must find it, language]. */
const CORPUS: [string, string, string][] = [
  ['Штукатурка стен выполняется в два слоя толщиной не более пятнадцати миллиметров.', 'штукатурки стены', 'Russian'],
  ['Штукатурення стін виконується у два шари завтовшки не більше п’ятнадцяти міліметрів.', 'штукатурення стіни', 'Ukrainian'],
  ['Plaster must be applied in two layers, each not thicker than fifteen millimetres.', 'plastering layers', 'English'],
  ['Der Putz muss in zwei Schichten aufgetragen werden, jede höchstens fünfzehn Millimeter dick.', 'Putz Schichten', 'German'],
  ['L’enduit doit être appliqué en deux couches, chacune d’au plus quinze millimètres.', 'enduit couches', 'French'],
  ['El yeso debe aplicarse en dos capas de no más de quince milímetros cada una.', 'yeso capas', 'Spanish'],
  ['Tynk należy nakładać w dwóch warstwach, każda o grubości do piętnastu milimetrów.', 'tynk warstwach', 'Polish'],
  ['Sıva iki kat halinde uygulanmalı, her kat en fazla on beş milimetre kalınlığında olmalıdır.', 'sıva kat', 'Turkish'],
  ['墙面抹灰应分两层施工，每层厚度不得超过十五毫米。', '抹灰 施工', 'Chinese'],
  ['壁の左官は二層に分けて施工し、各層の厚さは十五ミリ以下とする。', '左官 施工', 'Japanese'],
  ['벽면 미장은 두 겹으로 시공하며 각 층의 두께는 15밀리미터를 넘지 않아야 한다.', '미장 시공', 'Korean'],
  ['يجب وضع الملاط على طبقتين بسماكة لا تزيد عن خمسة عشر ملليمترا لكل طبقة.', 'الملاط طبقتين', 'Arabic'],
  ['יש למרוח את הטיח בשתי שכבות בעובי של עד חמישה עשר מילימטר כל אחת.', 'טיח שכבות', 'Hebrew'],
  ['प्लास्टर को दो परतों में लगाया जाना चाहिए, प्रत्येक की मोटाई पंद्रह मिलीमीटर से अधिक नहीं।', 'प्लास्टर परतों', 'Hindi'],
  ['ต้องฉาบปูนเป็นสองชั้น แต่ละชั้นหนาไม่เกินสิบห้ามิลลิเมตร', 'ฉาบปูน สองชั้น', 'Thai'],
  ['Lớp vữa phải được thi công thành hai lớp, mỗi lớp dày không quá mười lăm milimét.', 'vữa thi công', 'Vietnamese'],
  ['Πρέπει να εφαρμόζεται το σοβάτισμα σε δύο στρώσεις πάχους έως δεκαπέντε χιλιοστά.', 'σοβάτισμα στρώσεις', 'Greek'],
];

describe('search works in every language', () => {
  const idx = new Bm25Index();
  CORPUS.forEach(([text]) => idx.add('', text));
  // Russian and Ukrainian share most stems: either of the two sentences is a correct first hit for either query
  const CLOSE = [0, 1];
  it.each(CORPUS.map((c, i) => [c[2], c[1], i] as [string, string, number]))('%s: the query finds its sentence first', (_lang, query, i) => {
    expect(tokenize(CORPUS[i]![0]).length).toBeGreaterThan(0);
    const hits = idx.search(query, 3);
    expect(hits.length, `${_lang}: no hit`).toBeGreaterThan(0);
    if (CLOSE.includes(i)) expect(CLOSE).toContain(hits[0]!.idx);
    else expect(hits[0]!.idx, `${_lang}: wrong first hit`).toBe(i);
  });
  it('keeps combining marks inside words (Hindi, Thai, Arabic with harakat)', () => {
    expect(tokenize('प्लास्टर')).toEqual(['प्लास्टर']);
    expect(tokenize('الْمِلَاط')).toEqual(tokenize('الملاط'));
  });
  it('cuts text at the sentence marks of CJK / Hindi / Arabic scripts', () => {
    const zh = '这是第一句话。'.repeat(80);
    const chunks = chunkText(zh, { strategy: 'chars', maxChars: 300, overlap: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.text.endsWith('。')).toBe(true);
  });
  it('starts a new clause at "第N条" / "Artikel 3." / numbered clauses of any script', () => {
    const doc = '# 规范\n\n第一条 总则。适用于所有墙面。\n\n第二条 施工。分两层进行。\n\nArtikel 3. Haftung bleibt beim Eigentümer.';
    expect(chunkText(doc, { strategy: 'section', minChars: 0 }).length).toBeGreaterThanOrEqual(3);
  });
});

describe('names and addressing in any script', () => {
  it('file names keep their letters', () => {
    expect(sanitize('кухня 2.jpg')).toBe('кухня 2.jpg');
    expect(sanitize('写真.JPG')).toBe('写真.JPG');
    expect(sanitize('فاتورة.pdf')).toBe('فاتورة.pdf');
    expect(sanitize('../../etc/pass:wd*?.txt')).toBe('pass_wd_.txt');
    expect(sanitize('***')).toBe('_');
  });
  const agents = [{ name: 'помощник' }, { name: 'Архитектор' }, { name: '助手' }, { name: 'tutor' }];
  it('an agent with a non-Latin name is found by /name and @name, case and typos forgiven', () => {
    expect(nameKey('Помощник Иван')).toBe('помощник_иван');
    expect(parseAddress('@помощник сделай отчёт')).toEqual({ symbol: '@', typed: 'помощник', rest: 'сделай отчёт' });
    expect(parseAddress('/助手 你好')).toEqual({ symbol: '/', typed: '助手', rest: '你好' });
    expect(matchAgent('ПОМОЩНИК', agents)).toEqual({ kind: 'exact', name: 'помощник' });
    expect(matchAgent('архитектр', agents)).toMatchObject({ kind: 'fuzzy', name: 'Архитектор' });
    expect(matchAgent('助手', agents)).toEqual({ kind: 'exact', name: '助手' });
  });
});

describe('"the task is finished" in other languages', () => {
  const yes: [string, string][] = [
    ['uk', 'Готово'], ['uk', 'завдання виконано'], ['es', 'Hecho'], ['es', 'tarea completada'], ['pt', 'Concluído'], ['fr', "C'est fait"], ['fr', 'terminé'],
    ['de', 'Erledigt'], ['de', 'Aufgabe abgeschlossen'], ['it', 'Fatto'], ['pl', 'Zrobione'], ['tr', 'Bitti'], ['nl', 'Klaar'],
    ['zh', '完成了'], ['zh', '任务已完成'], ['ja', '完了しました'], ['ja', 'タスクは完了です'], ['ko', '완료'], ['ar', 'تم'], ['he', 'בוצע'], ['hi', 'हो गया'], ['th', 'เสร็จแล้ว'], ['vi', 'Xong rồi'], ['id', 'Selesai'],
  ];
  it.each(yes)('%s: "%s" closes the task', (_l, text) => expect(isDoneMessage(text), text).toBe(true));
  const no = ['Hecho ya el primer paso, ahora haz el segundo', 'Fertig mit Schritt eins, bitte weiter', 'terminé la première partie mais corrige le reste', '完成了第一步，请继续第二步', '완료했지만 수정이 필요해요', 'पहला हो गया, अब दूसरा करो', 'Готово? Проверь ещё раз', 'ist es fertig?', 'bitti mi?'];
  it.each(no)('"%s" is an ordinary message', (text) => expect(isDoneMessage(text), text).toBe(false));
});

describe('titles in any language', () => {
  it('strips quotes of every style and cuts dense scripts sensibly', () => {
    expect(cleanTitle('「比较三家供应商的价格」')).toBe('比较三家供应商的价格');
    expect(cleanTitle('«Сравнение цен на датчики»')).toBe('Сравнение цен на датчики');
    expect(cleanTitle('„Preisvergleich für Sensoren“')).toBe('Preisvergleich für Sensoren');
    expect(cleanTitle('标题：安装温度传感器')).not.toBeNull();
    const long = cleanTitle('这是一个很长的标题'.repeat(20))!;
    expect(long.length).toBeLessThanOrEqual(70);
  });
  it('a short CJK request is informative, a short Latin one is not', () => {
    expect(isWeakPrompt('请帮我比较三家供应商的价格')).toBe(false);
    expect(isWeakPrompt('価格を比較してください')).toBe(false);
    expect(isWeakPrompt('ok')).toBe(true);
  });
});

import { clip } from './channels/telegram.adapter';

describe('Telegram text limit', () => {
  it('never cuts an emoji / astral character in half', () => {
    const text = '😀'.repeat(3000); // every emoji is two UTF-16 units
    const out = clip(text, 4096);
    expect(out.length).toBeLessThanOrEqual(4096);
    expect(out.endsWith('…')).toBe(true);
    const body = out.slice(0, -1);
    expect(body).toBe([...body].join('')); // no lone surrogate left over
    expect(clip('short', 4096)).toBe('short');
  });
});
