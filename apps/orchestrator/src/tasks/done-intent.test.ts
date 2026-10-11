import { describe, expect, it } from 'vitest';
import { isDoneMessage } from './done-intent';

describe('isDoneMessage', () => {
  it('recognises a short, explicit "it is finished"', () => {
    for (const t of ['done', 'Done!', 'готово', 'Всё готово.', 'задача завершена', 'Задача выполнена', 'task is done', 'the task is complete', 'close the task', 'закрой задачу', 'закрой', 'mark it as done', 'принято', 'ok, done', 'спасибо, готово', 'LGTM', 'looks good, close it']) {
      expect(isDoneMessage(t), t).toBe(true);
    }
  });
  it('does not treat a longer message or a request as a confirmation', () => {
    for (const t of ['done with step 1, now do step 2', 'готово, но добавь ещё тесты', 'is it done?', 'когда будет готово?', 'not done yet', 'не готово', 'сделай доработку', 'please finish the report by tomorrow and send it', '']) {
      expect(isDoneMessage(t), t).toBe(false);
    }
  });
});
