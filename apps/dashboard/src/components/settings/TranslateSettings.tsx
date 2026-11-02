import { useState } from 'react';
import { TRANSLATE_LANGUAGES, loadTranslateLang, saveTranslateLang } from '@/lib/translate-lang';
import { Card, Field, Muted, SectionTitle } from '@/components/ui';

/** Settings → General → Translation: the language the 🌐 translate button under agents' messages translates into. Stored in this browser only. */
export function TranslateSettings() {
  const [lang, setLang] = useState(() => loadTranslateLang());
  const browser = typeof navigator !== 'undefined' ? navigator.language : '';
  const pick = (v: string) => {
    setLang(v);
    saveTranslateLang(v);
  };
  return (
    <Card>
      <SectionTitle>Translation</SectionTitle>
      <Muted>
        The 🌐 button under an agent&apos;s message (discussions, subtask reports) translates it into this language. It is chosen per browser; by default it is the language of the browser
        {browser ? ` (${browser})` : ''}.
      </Muted>
      <Field label="Translate into">
        <select value={lang} onChange={(e) => pick(e.target.value)}>
          <option value="">Browser language{browser ? ` (${browser})` : ''}</option>
          {lang && !TRANSLATE_LANGUAGES.includes(lang) && <option value={lang}>{lang}</option>}
          {TRANSLATE_LANGUAGES.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </Field>
    </Card>
  );
}
