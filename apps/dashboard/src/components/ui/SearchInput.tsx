import { forwardRef, type InputHTMLAttributes, type CSSProperties } from 'react';
import { cn } from '@/lib/cn';
import styles from './SearchInput.module.css';

/** A search box with a clear (×) button: shown while there is text, the same in every browser (the native one is hidden in globals.css). */
export const SearchInput = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange'> & { value: string; onValue: (v: string) => void; wrapStyle?: CSSProperties; wrapClassName?: string }
>(function SearchInput({ value, onValue, wrapStyle, wrapClassName, className, ...rest }, ref) {
  return (
    <span className={cn(styles.wrap, wrapClassName)} style={wrapStyle}>
      <input ref={ref} type="search" className={cn(styles.input, className)} value={value} onChange={(e) => onValue(e.target.value)} {...rest} />
      {value && (
        <button
          type="button"
          className={styles.clear}
          aria-label="Clear the search"
          title="Clear"
          // keep the focus in the box (and a picker that closes on blur open)
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onValue('')}
        >
          ×
        </button>
      )}
    </span>
  );
});
