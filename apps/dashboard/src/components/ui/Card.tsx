import type { ElementType, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import styles from './Card.module.css';

type CardProps<T extends ElementType> = {
  as?: T;
  className?: string;
  children: ReactNode;
};

/**
 * Elevated panel. Polymorphic via `as` so it can render a <form> (with
 * onSubmit) as easily as a <div>.
 */
export function Card<T extends ElementType = 'div'>({
  as,
  className,
  children,
  ...rest
}: CardProps<T> & Omit<React.ComponentPropsWithoutRef<T>, keyof CardProps<T>>) {
  const Tag = (as ?? 'div') as ElementType;
  return (
    <Tag className={cn(styles.card, className)} {...rest}>
      {children}
    </Tag>
  );
}

/** Small uppercase label that heads a card section. */
export function SectionTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn(styles.sectionTitle, className)}>{children}</p>;
}
