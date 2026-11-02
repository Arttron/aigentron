/** The language the 🌐 translate button translates INTO: chosen in Settings → General (per browser), otherwise the browser's own language. */
const KEY = 'lds.translateLang';

/** [stored name — sent to the model as is, label]. */
export const TRANSLATE_LANGUAGES: readonly string[] = [
  'English', 'Russian', 'Ukrainian', 'Belarusian', 'Polish', 'Czech', 'Slovak', 'Bulgarian', 'Serbian', 'Croatian', 'Romanian', 'Hungarian', 'German', 'Dutch', 'French', 'Spanish', 'Portuguese',
  'Italian', 'Catalan', 'Greek', 'Turkish', 'Swedish', 'Norwegian', 'Danish', 'Finnish', 'Lithuanian', 'Latvian', 'Estonian', 'Georgian', 'Armenian', 'Azerbaijani', 'Kazakh', 'Uzbek', 'Hebrew',
  'Arabic', 'Persian', 'Hindi', 'Bengali', 'Thai', 'Vietnamese', 'Indonesian', 'Chinese', 'Japanese', 'Korean',
];

export const loadTranslateLang = (): string => {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
};

export const saveTranslateLang = (lang: string): void => {
  try {
    if (lang) localStorage.setItem(KEY, lang);
    else localStorage.removeItem(KEY);
  } catch {
    /* not persisted */
  }
};

/** What to send as the target: the choice, else the browser language tag, else English. */
export const translateTarget = (): string => loadTranslateLang() || (typeof navigator !== 'undefined' ? navigator.language : '') || 'English';
