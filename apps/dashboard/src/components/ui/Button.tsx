import type { AnchorHTMLAttributes, ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
import styles from './Button.module.css';

export type ButtonVariant = 'default' | 'primary' | 'green' | 'red';
export type ButtonSize = 'md' | 'sm';

/** Compose the button class names — shared by Button and anchor-as-button. */
export function buttonClassName(
  variant: ButtonVariant = 'default',
  size: ButtonSize = 'md',
  extra?: string,
): string {
  return cn(styles.btn, styles[variant], size === 'sm' && styles.sm, extra);
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({ variant, size, className, type = 'button', ...rest }: ButtonProps) {
  return <button type={type} className={buttonClassName(variant, size, className)} {...rest} />;
}

interface ButtonLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

/** An <a> styled as a button (e.g. the external Pull Request link). */
export function ButtonLink({ variant, size, className, ...rest }: ButtonLinkProps) {
  return <a className={buttonClassName(variant, size, className)} {...rest} />;
}
