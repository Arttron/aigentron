import { useEffect, useState } from 'react';

/**
 * A whole-number field that can be edited like text: while you type (or clear it to type another number) the text is yours, and only a valid number in
 * range is passed on. A plain `type="number"` bound to `Number(value)` turns an empty field into 0 — which for the queue settings means "automatic" and
 * switched the field off in the middle of an edit.
 */
export function IntInput({ value, min, max, disabled, className, style, onCommit }: { value: number; min: number; max: number; disabled?: boolean; className?: string; style?: React.CSSProperties; onCommit: (n: number) => void }) {
  const [text, setText] = useState(String(value));
  // the value changed from outside (a checkbox, a reload): show it, unless the person is in the middle of typing the same number
  useEffect(() => {
    setText((t) => (Number(t) === value && t.trim() !== '' ? t : String(value)));
  }, [value]);
  return (
    <input
      className={className}
      style={style}
      type="text"
      inputMode="numeric"
      disabled={disabled}
      value={text}
      onChange={(e) => {
        const t = e.target.value.replace(/[^\d]/g, '');
        setText(t);
        const n = Number.parseInt(t, 10);
        if (Number.isInteger(n) && n >= min && n <= max) onCommit(n);
      }}
      onBlur={() => setText(String(value))} // what was left half-typed or out of range goes back to the value that is in force
    />
  );
}
