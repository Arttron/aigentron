import { useState, type DragEvent, type ReactNode, type Ref } from 'react';
import { Button, type ButtonSize, type ButtonVariant } from './Button';
import styles from './Upload.module.css';

interface PickerProps {
  onFiles: (files: File[]) => void | Promise<void>;
  accept?: string;
  multiple?: boolean;
  /** Opens the phone's own camera app (`capture="environment"`). */
  capture?: boolean;
  /** To open the chooser from code (an attach menu): `ref.current?.click()`. */
  ref?: Ref<HTMLInputElement>;
}

/** The hidden `<input type=file>`: hands the chosen files over as an array; it is reset when the chooser opens again, so the same file can be picked twice. */
export function HiddenFileInput({ onFiles, accept, multiple, capture, ref }: PickerProps) {
  return (
    <input
      ref={ref}
      type="file"
      accept={accept}
      multiple={multiple}
      capture={capture ? 'environment' : undefined}
      className={styles.hidden}
      // The previous choice is cleared when the chooser is OPENED (so the same file can be picked again), not right after a pick: on some phones
      // (Android, files from the gallery or a cloud app) clearing the input invalidates the files while they are still being prepared / uploaded.
      onClick={(e) => {
        e.currentTarget.value = '';
      }}
      onChange={(e) => {
        const files = Array.from(e.target.files ?? []);
        if (files.length) void onFiles(files);
      }}
    />
  );
}

interface UploadButtonProps extends Omit<PickerProps, 'ref'> {
  disabled?: boolean;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Render a bare `<button className>` (the page's own look) instead of the shared Button. */
  className?: string;
  title?: string;
  /** Called first; return true when you handled the click yourself (e.g. a live camera) and the chooser must not open. */
  intercept?: () => boolean;
  children: ReactNode;
}

/** A button that opens the file chooser (+ its hidden input). */
export function UploadButton({ onFiles, accept, multiple = true, capture, intercept, className, children, variant, size, disabled, title }: UploadButtonProps) {
  const [input, setInput] = useState<HTMLInputElement | null>(null);
  const open = () => {
    if (!intercept?.()) input?.click();
  };
  return (
    <>
      {className ? (
        <button type="button" className={className} disabled={disabled} title={title} onClick={open}>
          {children}
        </button>
      ) : (
        <Button variant={variant} size={size} disabled={disabled} title={title} onClick={open}>
          {children}
        </Button>
      )}
      <HiddenFileInput ref={setInput} onFiles={onFiles} accept={accept} multiple={multiple} capture={capture} />
    </>
  );
}

/** Drop-zone state: spread `bind` on the element, `dragging` says when a file is over it. */
export function useFileDrop(onFiles: (files: File[]) => void | Promise<void>) {
  const [dragging, setDragging] = useState(false);
  const bind = {
    onDragOver: (e: DragEvent) => {
      e.preventDefault();
      setDragging(true);
    },
    onDragLeave: () => setDragging(false),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setDragging(false);
      if (e.dataTransfer.files.length) void onFiles(Array.from(e.dataTransfer.files));
    },
  };
  return { dragging, bind };
}
